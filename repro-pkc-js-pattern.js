#!/usr/bin/env node
//
// Faithful pkc-js community-lifecycle repro for kubo MFS hangs (ipfs/kubo#10842).
//
// Mirrors what pkc-js actually does (lifecycle.ts, comment-updates.ts, cleanup.ts,
// util.ts), so we can bisect WHICH step actually triggers the hang and test fixes
// before applying them in pkc-js.
//
// Lifecycle simulated:
//   1. files.mkdir(/{community})                           (parents:true)
//   2. N rounds of "sync":
//        - Up to PARALLEL_WRITES files.write(path, flush:true, parents:true,
//          create:true, truncate:true) at a time
//        - After each batch of BATCH_SIZE writes: files.flush(/{community})
//        - Sometimes files.rm([...stalePaths], recursive:true, force:true)
//        - Path: /{community}/postUpdates/{bucket}/{cid}/update
//   3. files.rm(/{community}, recursive:true, force:true)  ← the hang point in pkc-js
//
// 2026-06-11 extension, based on a CI goroutine dump of the wedged daemon
// (kubo 0.42.0 / boxo 0.40.0): the deadlock signature is one `files write`
// goroutine stuck in mfs.Mkdir -> childUnsync -> unixfs io.BasicDirectory.Find
// -> dagService.Get -> bitswap SyncGetBlock (a directory node block absent from
// the local blockstore, unbounded wait on a no-peer daemon) WHILE HOLDING the
// MFS directory mutex, plus hundreds of goroutines piled up in sync.Mutex.Lock
// on mfs.(*Directory).Child/getNode (including files rm -> Directory.Flush).
//
// New in this version:
//   - FAULT_MODE env: none | E1 | E2 | E3 | E4 (fault-injection scenarios, see below)
//   - watchdog: detects any MFS op pending > WATCHDOG_PENDING_MS while the daemon
//     core API still answers, then captures /debug/pprof/goroutine?debug=2 and
//     asserts the deadlock signature (machine-checkable "REPRODUCED")
//   - CID forensics: every directory CID learned from files.stat/files.flush is
//     recorded; on wedge we diff against `refs local` to name the vanished block
//   - PARALLEL_COMMUNITIES actually runs community lifecycles concurrently now
//
// Fault modes:
//   E1: control — deliberately remove a known MFS directory-node block OFFLINE
//       (daemon stopped, so the warm dir cache cannot re-persist it), restart for
//       a cold cache, then write under that directory and flush from another
//       community. Expected: deterministic wedge with the exact CI signature.
//       Validates harness + detection.
//   E2: explicit repo.gc loop concurrent with write bursts.
//   E3: "auto-nuke" files.rm(/{community}) racing in-flight writes to the same tree
//       (mirrors pkc-js's v0.0.34 MFS-timeout recovery workaround).
//   E4: dedup purge — communities write IDENTICAL update content (identical file
//       blocks => identical dir nodes => shared blocks across trees), then one
//       community "purges" its copies with pin-less block.rm --force while others
//       still reference the same blocks (mirrors pkc-js comment purge).
//   E5: aborted mutations — a fraction of files.write/files.rm requests are
//       aborted client-side mid-flight (AbortController), mirroring what happens
//       in CI under load (TCP connect ETIMEDOUT, undici HeadersTimeoutError
//       dropping connections): kubo cancels the request context midway through a
//       multi-step MFS mutation, potentially leaving a parent link without its
//       child block.
//
// Exit codes: 0 = completed, no hang; 42 = wedge with deadlock signature
// (REPRODUCED); 41 = hang without the signature; 1 = unexpected error.

import { create, CID } from "kubo-rpc-client";
import pLimit from "p-limit";
import pTimeout from "p-timeout";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { performance } from "perf_hooks";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------- KNOBS (override via env, e.g. PARALLEL_WRITES=10 NUM_COMMENTS=2000 node ...) ----------
const NUM_COMMUNITIES = Number(process.env.NUM_COMMUNITIES ?? 3);
const PARALLEL_COMMUNITIES = Number(process.env.PARALLEL_COMMUNITIES ?? 1); // run N community lifecycles concurrently
const NUM_BUCKETS = Number(process.env.NUM_BUCKETS ?? 5);          // post-update timestamp buckets per community
const NUM_COMMENTS = Number(process.env.NUM_COMMENTS ?? 4000);     // comment updates per community (spread across buckets)
const SYNC_ROUNDS = Number(process.env.SYNC_ROUNDS ?? 3);          // number of "publish" cycles (rewrite same paths)
const PARALLEL_WRITES = Number(process.env.PARALLEL_WRITES ?? 50); // pkc-js uses pLimit(50)
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 50);           // pkc-js BATCH_SIZE = 50
const WRITE_FLUSH = (process.env.WRITE_FLUSH ?? "true") === "true";
const BATCH_FLUSH_COMMUNITY = (process.env.BATCH_FLUSH_COMMUNITY ?? "true") === "true";
const RM_STALE_BETWEEN_SYNCS = (process.env.RM_STALE_BETWEEN_SYNCS ?? "true") === "true";
const FINAL_FLUSH_BEFORE_DELETE = (process.env.FINAL_FLUSH_BEFORE_DELETE ?? "false") === "true";
const DELETE_RM_STRATEGY = process.env.DELETE_RM_STRATEGY ?? "recursive"; // "recursive" | "bottom-up" | "rename-then-rm"
const WRITE_TIMEOUT_MS = Number(process.env.WRITE_TIMEOUT_MS ?? 15_000);
const FLUSH_TIMEOUT_MS = Number(process.env.FLUSH_TIMEOUT_MS ?? 120_000);
const RM_TIMEOUT_MS = Number(process.env.RM_TIMEOUT_MS ?? 120_000);
const CONTENT_PADDING = Number(process.env.CONTENT_PADDING ?? 500); // bytes
const SCENARIO = process.env.SCENARIO ?? "default";                  // label written to log

// Fault injection / detection knobs (2026-06-11)
const FAULT_MODE = process.env.FAULT_MODE ?? "none";                // none | E1 | E2 | E3 | E4
const GC_INTERVAL_MS = Number(process.env.GC_INTERVAL_MS ?? 4_000); // E2: repo.gc cadence
const NUKE_DELAY_MS = Number(process.env.NUKE_DELAY_MS ?? 2_000);   // E3: delay into a sync round before firing the nuke rm
const WATCHDOG_PENDING_MS = Number(process.env.WATCHDOG_PENDING_MS ?? 45_000); // op pending this long while daemon alive => wedge
const WAITERS_MIN = Number(process.env.WAITERS_MIN ?? 3);           // min mfs mutex waiters for the signature (CI dump had ~250)
const ABORT_RATE = Number(process.env.ABORT_RATE ?? 0.08);          // E5: fraction of MFS mutations aborted mid-flight
const ABORT_AFTER_MS_MAX = Number(process.env.ABORT_AFTER_MS_MAX ?? 40); // E5: abort within [0, MAX] ms of issuing the request
// ---------------------------------------------------------------------------------------------

const TEMP_IPFS_DIR = path.join(__dirname, ".test-ipfs-node");
const API_PORT = 45003;
const GATEWAY_PORT = 48082;
const SWARM_PORT = 44003;
const IPFS_API_URL = `http://127.0.0.1:${API_PORT}`;

const logTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runLabel = FAULT_MODE === "none" ? SCENARIO : `${FAULT_MODE}_${SCENARIO}`;
const reportFile = path.join(LOG_DIR, `repro-pkc-js-pattern_${runLabel}_${logTimestamp}.json`);
const kuboStderrFile = path.join(LOG_DIR, `repro-pkc-js-pattern_${runLabel}_${logTimestamp}_kubo.stderr.log`);

const report = {
    scenario: SCENARIO,
    faultMode: FAULT_MODE,
    kuboVersion: null, // filled from /api/v0/version after daemon start
    config: {
        NUM_COMMUNITIES, PARALLEL_COMMUNITIES, NUM_BUCKETS, NUM_COMMENTS, SYNC_ROUNDS, PARALLEL_WRITES, BATCH_SIZE,
        WRITE_FLUSH, BATCH_FLUSH_COMMUNITY, RM_STALE_BETWEEN_SYNCS, FINAL_FLUSH_BEFORE_DELETE,
        DELETE_RM_STRATEGY, WRITE_TIMEOUT_MS, FLUSH_TIMEOUT_MS, RM_TIMEOUT_MS, CONTENT_PADDING,
        FAULT_MODE, GC_INTERVAL_MS, NUKE_DELAY_MS, WATCHDOG_PENDING_MS, WAITERS_MIN, ABORT_RATE, ABORT_AFTER_MS_MAX
    },
    startedAt: new Date().toISOString(),
    steps: [],
    knownCids: {},   // cidString -> { path, source, t }  (dir/file blocks the MFS tree references)
    removedCids: [], // cids we deliberately block.rm'd (fault injection)
    hang: null,
    wedge: null,     // goroutine-dump analysis + vanished-block forensics
    finishedAt: null
};

function writeReport() {
    try { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2)); } catch {}
}

function step(label, extra = {}) {
    const entry = { label, t: new Date().toISOString(), tStart: performance.now(), ...extra };
    report.steps.push(entry);
    writeReport();
    return (result = {}) => {
        entry.tEnd = performance.now();
        entry.durationMs = +(entry.tEnd - entry.tStart).toFixed(1);
        Object.assign(entry, result);
        writeReport();
    };
}

// ---------------------------------------------------------------------------------------------
// In-flight op tracking + watchdog
// ---------------------------------------------------------------------------------------------
const inflight = new Map(); // id -> { label, startedAtMs }
let inflightSeq = 0;

function tracked(label, promise) {
    const id = ++inflightSeq;
    inflight.set(id, { label, startedAtMs: Date.now() });
    return promise.finally(() => inflight.delete(id));
}

let watchdogTimer = null;
let wedgeHandled = false;

function startWatchdog() {
    watchdogTimer = setInterval(async () => {
        if (wedgeHandled) return;
        const now = Date.now();
        let oldest = null;
        for (const op of inflight.values()) {
            if (!oldest || op.startedAtMs < oldest.startedAtMs) oldest = op;
        }
        if (!oldest || now - oldest.startedAtMs < WATCHDOG_PENDING_MS) return;
        // Something has been pending too long. Is the daemon core API still alive?
        const alive = await coreApiAlive(5_000);
        await handleWedge(`watchdog: op "${oldest.label}" pending ${Math.round((now - oldest.startedAtMs) / 1000)}s, core API ${alive ? "alive" : "dead"}`);
    }, 5_000);
    watchdogTimer.unref?.();
}

async function coreApiAlive(timeoutMs) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(`${IPFS_API_URL}/api/v0/id`, { method: "POST", signal: ac.signal });
        await res.text();
        return res.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(t);
    }
}

// ---------------------------------------------------------------------------------------------
// Goroutine dump capture + deadlock-signature assertion
// (signature taken from the 2026-06-11 CI dump of the wedged kubo 0.42.0 daemon)
// ---------------------------------------------------------------------------------------------
async function dumpGoroutines(label) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 20_000);
    try {
        const res = await fetch(`${IPFS_API_URL}/debug/pprof/goroutine?debug=2`, { signal: ac.signal });
        const text = await res.text();
        const file = path.join(LOG_DIR, `goroutine_${runLabel}_${logTimestamp}_${label}.txt`);
        fs.writeFileSync(file, text);
        return { file, text };
    } catch (e) {
        return { file: null, text: null, error: e.message };
    } finally {
        clearTimeout(t);
    }
}

function analyzeDump(text) {
    if (!text) return { lockHolders: 0, mfsMutexWaiters: 0, reproduced: false, holders: [] };
    const blocks = text.split(/\n\n(?=goroutine )/);
    const holders = [];
    let mfsMutexWaiters = 0;
    for (const b of blocks) {
        const header = b.slice(0, b.indexOf("\n"));
        const inMfsLookup = /boxo\/mfs\.\(\*Directory\)\.(childUnsync|childFromDag)|unixfs\/io\.\(\*(Basic|HAMT)Directory\)\.Find/.test(b);
        const inBlockFetch = /bitswap.*(SyncGetBlock|GetBlock)|blockservice\.getBlock/.test(b);
        if (inMfsLookup && inBlockFetch) holders.push(header);
        if (/\[sync\.Mutex\.Lock/.test(header) && /mfs\.\(\*Directory\)\./.test(b)) mfsMutexWaiters++;
    }
    return {
        lockHolders: holders.length,
        holders,
        mfsMutexWaiters,
        reproduced: holders.length >= 1 && mfsMutexWaiters >= WAITERS_MIN
    };
}

// ---------------------------------------------------------------------------------------------
// CID forensics: record every MFS-referenced block CID we learn; on wedge, diff vs refs local
// ---------------------------------------------------------------------------------------------
function recordCid(cid, p, source) {
    if (!cid) return;
    const s = cid.toString();
    if (!report.knownCids[s]) report.knownCids[s] = { path: p, source, t: new Date().toISOString() };
}

// The blockstore is keyed by multihash; `refs local` prints raw-codec CIDv1 (bafkrei...)
// while files.stat reports dag-pb CIDv0 (Qm...). Compare MULTIHASHES, never CID strings.
function multihashKey(cidString) {
    return Buffer.from(CID.parse(cidString).multihash.bytes).toString("base64");
}

async function vanishedBlocks(ipfs) {
    // refs local only touches the blockstore (not MFS), so it works while MFS is wedged.
    const local = new Set();
    try {
        for await (const ref of ipfs.refs.local({ timeout: 60_000 })) {
            try { local.add(multihashKey(ref.ref)); } catch {}
        }
    } catch (e) {
        return { error: `refs local failed: ${e.message}` };
    }
    const missing = [];
    for (const [s, meta] of Object.entries(report.knownCids)) {
        try {
            if (!local.has(multihashKey(s))) missing.push({ cid: s, ...meta });
        } catch {}
    }
    return { localBlockCount: local.size, missing: missing.slice(0, 100), missingCount: missing.length };
}

async function handleWedge(trigger) {
    if (wedgeHandled) return;
    wedgeHandled = true;
    console.error(`\n=== WEDGE DETECTED (${trigger}) ===`);
    const probe = await probeDaemon(15_000);
    let dump = await dumpGoroutines("wedge");
    let analysis = analyzeDump(dump.text);
    if (!analysis.reproduced) {
        // A GC-induced stall can trip the watchdog before the system settles into the
        // deadlock; give it 30s and re-dump before deciding (keep both dumps on disk).
        console.error("first dump lacks full signature, re-dumping in 30s...");
        await new Promise((r) => setTimeout(r, 30_000));
        const dump2 = await dumpGoroutines("wedge2");
        const analysis2 = analyzeDump(dump2.text);
        if (analysis2.lockHolders > analysis.lockHolders || analysis2.reproduced) {
            dump = dump2;
            analysis = analysis2;
        }
    }
    const ipfs = create({ url: IPFS_API_URL });
    const forensics = await vanishedBlocks(ipfs);
    report.wedge = {
        trigger,
        probe,
        goroutineDumpFile: dump.file,
        dumpError: dump.error,
        analysis: { ...analysis, holders: analysis.holders.slice(0, 5) },
        forensics
    };
    writeReport();

    console.error(`Probe verdict: ${probe.verdict}`);
    console.error(`Goroutine dump: ${dump.file ?? `FAILED (${dump.error})`}`);
    console.error(`Signature: lockHolders=${analysis.lockHolders} mfsMutexWaiters=${analysis.mfsMutexWaiters} (need >=1 and >=${WAITERS_MIN})`);
    if (analysis.holders.length) console.error(`Lock holder(s):\n  ${analysis.holders.slice(0, 5).join("\n  ")}`);
    if (forensics.missingCount) {
        console.error(`VANISHED BLOCKS (${forensics.missingCount}): MFS references these but the blockstore no longer has them:`);
        for (const m of forensics.missing.slice(0, 10)) console.error(`  ${m.cid}  (${m.source} ${m.path})`);
    } else if (!forensics.error) {
        console.error(`No recorded MFS CID is missing from the blockstore (${forensics.localBlockCount} local blocks).`);
    }

    if (analysis.reproduced) {
        console.error(`\nREPRODUCED faultMode=${FAULT_MODE} scenario=${SCENARIO} kubo=${report.kuboVersion}`);
        await finishAndExit(42);
    } else {
        console.error(`\nHANG WITHOUT FULL SIGNATURE faultMode=${FAULT_MODE} scenario=${SCENARIO} kubo=${report.kuboVersion}`);
        await finishAndExit(41);
    }
}

async function finishAndExit(code) {
    report.finishedAt = new Date().toISOString();
    writeReport();
    await teardownIpfsNode({ wipe: code === 0 }); // keep the wedged repo for post-mortem
    console.log(`\nReport: ${reportFile}`);
    console.log(`Kubo stderr: ${kuboStderrFile}`);
    process.exit(code);
}

// ---------------------------------------------------------------------------------------------
// Daemon lifecycle (init / start / stop split so fault modes can restart with a warm repo)
// ---------------------------------------------------------------------------------------------
let ipfsDaemon = null;
const ipfsBin = path.join(__dirname, "node_modules/kubo/kubo/ipfs");

async function initIpfsRepo() {
    if (fs.existsSync(TEMP_IPFS_DIR)) fs.rmSync(TEMP_IPFS_DIR, { recursive: true, force: true });

    await new Promise((resolve, reject) => {
        const init = spawn(ipfsBin, ["init"], { env: { ...process.env, IPFS_PATH: TEMP_IPFS_DIR }, stdio: "ignore" });
        init.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ipfs init exit ${code}`))));
    });

    const configPath = path.join(TEMP_IPFS_DIR, "config");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    cfg.Addresses.API = `/ip4/127.0.0.1/tcp/${API_PORT}`;
    cfg.Addresses.Gateway = `/ip4/127.0.0.1/tcp/${GATEWAY_PORT}`;
    cfg.Addresses.Swarm = [`/ip4/0.0.0.0/tcp/${SWARM_PORT}/ws`];
    cfg.Bootstrap = null;
    cfg.Discovery.MDNS.Enabled = false;
    cfg.Datastore.GCPeriod = "1h";
    cfg.Datastore.StorageMax = "10GB";
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

async function startIpfsDaemon() {
    const logStream = fs.createWriteStream(kuboStderrFile, { flags: "a" });
    logStream.write(`\n===== daemon start ${new Date().toISOString()} =====\n`);
    ipfsDaemon = spawn(ipfsBin, ["daemon", "--enable-gc=false"], {
        env: { ...process.env, IPFS_PATH: TEMP_IPFS_DIR },
        stdio: ["ignore", "pipe", "pipe"]
    });
    // "Daemon is ready" goes to STDOUT — capture both streams.
    ipfsDaemon.stderr.on("data", (d) => logStream.write(d));
    ipfsDaemon.stdout.on("data", (d) => logStream.write(d));

    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("daemon start timeout")), 30000);
        const check = (d) => {
            if (d.toString().includes("Daemon is ready")) { clearTimeout(t); resolve(); }
        };
        ipfsDaemon.stdout.on("data", check);
        ipfsDaemon.stderr.on("data", check);
    });

    // Belt-and-suspenders: don't trust the banner, verify the API actually answers.
    for (let i = 0; ; i++) {
        if (await coreApiAlive(2_000)) break;
        if (i > 30) throw new Error("daemon API did not come up within 60s of the ready banner");
        await new Promise((r) => setTimeout(r, 2_000));
    }

    try {
        const res = await fetch(`${IPFS_API_URL}/api/v0/version`, { method: "POST" });
        report.kuboVersion = (await res.json()).Version;
    } catch {}
}

async function stopIpfsDaemon() {
    if (!ipfsDaemon) return;
    const d = ipfsDaemon;
    ipfsDaemon = null;
    const exited = new Promise((r) => d.on("exit", r));
    d.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
    if (d.exitCode === null && d.signalCode === null) {
        d.kill("SIGKILL");
        await exited;
    }
    // Verify the API is actually down (a stale daemon would invalidate cold-cache assumptions).
    for (let i = 0; i < 15; i++) {
        if (!(await coreApiAlive(1_000))) return;
        await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error("daemon API still answering after SIGTERM/SIGKILL — repo lock not released?");
}

// Run a kubo CLI command directly against the (stopped) repo. Offline mode errors fast
// on missing blocks instead of hanging in bitswap, so it's safe for verification.
function ipfsCli(args) {
    return new Promise((resolve) => {
        const p = spawn(ipfsBin, args, { env: { ...process.env, IPFS_PATH: TEMP_IPFS_DIR } });
        let out = "", err = "";
        p.stdout.on("data", (d) => (out += d));
        p.stderr.on("data", (d) => (err += d));
        p.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    });
}

async function setupIpfsNode() {
    await initIpfsRepo();
    await startIpfsDaemon();
}

async function teardownIpfsNode({ wipe = true } = {}) {
    await stopIpfsDaemon();
    if (wipe && fs.existsSync(TEMP_IPFS_DIR)) fs.rmSync(TEMP_IPFS_DIR, { recursive: true, force: true });
    else if (!wipe) console.log(`Kept wedged repo for post-mortem: ${TEMP_IPFS_DIR}`);
}

// E5: abort a fraction of MFS mutations mid-flight (request ctx canceled inside kubo,
// like CI's connect-ETIMEDOUT / HeadersTimeoutError connection drops under load).
let abortedOps = 0;
function maybeAbortSignal() {
    if (FAULT_MODE !== "E5" || Math.random() >= ABORT_RATE) return undefined;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), Math.random() * ABORT_AFTER_MS_MAX).unref?.();
    abortedOps++;
    return ac.signal;
}

function isAbortError(e) {
    return e.name === "AbortError" || /abort/i.test(e.message);
}

// Mirrors writeKuboFilesWithTimeout in pkc-js util.ts, including its retry-on-transient-error
// behavior: concurrent writes racing to create the same fresh parent dir surface
// "file already exists" from Mkdir, which pkc-js absorbs by retrying.
async function writeWithTimeout(ipfs, p, content) {
    for (let attempt = 1; ; attempt++) {
        const signal = maybeAbortSignal();
        try {
            return await pTimeout(
                tracked(`files.write ${p}`, ipfs.files.write(p, content, { create: true, truncate: true, parents: true, flush: WRITE_FLUSH, signal })),
                { milliseconds: WRITE_TIMEOUT_MS, message: `Timed out writing to MFS path ${p}` }
            );
        } catch (e) {
            if (signal && isAbortError(e)) return; // E5: deliberately dropped mutation, move on like CI does
            if (attempt < 3 && /already exists|directory already has entry/i.test(e.message)) {
                await new Promise((r) => setTimeout(r, 50 * attempt));
                continue;
            }
            throw e;
        }
    }
}

// Mirrors removeMfsFilesSafely in pkc-js util.ts.
async function removeMfsFilesSafely(ipfs, paths) {
    const signal = maybeAbortSignal(); // E5: a partially-canceled recursive rm is a prime dangling-link candidate
    try {
        return await pTimeout(
            tracked(`files.rm ${paths[0]}${paths.length > 1 ? ` (+${paths.length - 1})` : ""}`, ipfs.files.rm(paths, { recursive: true, force: true, signal })),
            { milliseconds: RM_TIMEOUT_MS, message: `Timed out removing MFS paths ${JSON.stringify(paths)}` }
        );
    } catch (e) {
        if (signal && isAbortError(e)) return;
        throw e;
    }
}

// Probe daemon at hang. Distinguishes process-dead vs. MFS-only-dead.
async function probeDaemon(perEndpointTimeoutMs = 30_000) {
    const api = `http://127.0.0.1:${API_PORT}/api/v0`;
    const endpoints = ["id", "version", "repo/stat", "files/stat?arg=/"];
    const probeResults = [];
    for (const ep of endpoints) {
        const start = Date.now();
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), perEndpointTimeoutMs);
        try {
            const res = await fetch(`${api}/${ep}`, { method: "POST", signal: ac.signal });
            await res.text();
            probeResults.push({ ep, ok: res.ok, status: res.status, ms: Date.now() - start, timedOut: false });
        } catch (e) {
            probeResults.push({ ep, ok: false, ms: Date.now() - start, timedOut: e.name === "AbortError", err: e.message });
        } finally {
            clearTimeout(t);
        }
    }
    const mfsHung = probeResults.find((r) => r.ep.startsWith("files/stat"))?.timedOut;
    const allHung = probeResults.every((r) => r.timedOut);
    let verdict;
    if (ipfsDaemon && (ipfsDaemon.exitCode !== null || ipfsDaemon.signalCode !== null)) verdict = "CRASHED";
    else if (allHung) verdict = "FULLY_HUNG";
    else if (mfsHung) verdict = "MFS_HUNG";
    else verdict = "RESPONSIVE";
    return { verdict, probeResults };
}

function commentCid(i) {
    return "Qm" + String(i).padStart(44, "0");
}

// E4 writes identical content across communities so file blocks (and therefore the
// single-entry parent dir nodes) dedup into shared blocks across MFS subtrees.
function contentFor(community, round, idx) {
    if (FAULT_MODE === "E4") return `update-shared-${idx} ` + "x".repeat(CONTENT_PADDING);
    return `update-${community}-r${round}-${idx} ` + "x".repeat(CONTENT_PADDING);
}

async function statAndRecord(ipfs, p, source) {
    try {
        const st = await tracked(`files.stat ${p}`, ipfs.files.stat(p));
        recordCid(st.cid, p, source);
        return st;
    } catch {
        return null;
    }
}

async function syncCommunity(ipfs, community, round, buckets, commentsThisRound, staleRefs) {
    const baseDir = `/${community}`;

    const limit = pLimit(PARALLEL_WRITES);
    const writePromises = [];
    const pendingPathsForRm = [];

    for (let idx = 0; idx < commentsThisRound; idx++) {
        const bucket = buckets[idx % buckets.length];
        // Re-use a small CID space so we overwrite existing files in later rounds (real workload pattern).
        const cid = commentCid(idx % NUM_COMMENTS);
        const filePath = `${baseDir}/postUpdates/${bucket}/${cid}/update`;
        const content = contentFor(community, round, idx);

        // Track for the "rm stale paths" sweep that pkc-js does via _mfsPathsToRemove
        if (round > 0 && RM_STALE_BETWEEN_SYNCS && idx % 23 === 0) {
            // Stale path == parent dir of the old update (matches pkc-js's "strip '/update'" behavior)
            pendingPathsForRm.push(`${baseDir}/postUpdates/${bucket}/${cid}`);
        }

        writePromises.push(
            limit(async () => {
                await writeWithTimeout(ipfs, filePath, new TextEncoder().encode(content));
            })
        );

        if (writePromises.length >= BATCH_SIZE) {
            const end = step(`write-batch`, { community, round, size: writePromises.length });
            await Promise.all(writePromises);
            writePromises.length = 0;
            end();

            if (BATCH_FLUSH_COMMUNITY) {
                const endFlush = step(`flush-community`, { community, round });
                const signal = maybeAbortSignal();
                try {
                    const flushedCid = await pTimeout(tracked(`files.flush ${baseDir}`, ipfs.files.flush(baseDir, { signal })), { milliseconds: FLUSH_TIMEOUT_MS, message: `flush(${baseDir}) timeout` });
                    recordCid(flushedCid, baseDir, "files.flush");
                    endFlush();
                } catch (e) {
                    if (signal && isAbortError(e)) { endFlush({ aborted: true }); } else throw e;
                }
            }
        }
    }

    if (writePromises.length) {
        const end = step(`write-batch-tail`, { community, round, size: writePromises.length });
        await Promise.all(writePromises);
        end();
        if (BATCH_FLUSH_COMMUNITY) {
            const endFlush = step(`flush-community-tail`, { community, round });
            const flushedCid = await pTimeout(tracked(`files.flush ${baseDir}`, ipfs.files.flush(baseDir)), { milliseconds: FLUSH_TIMEOUT_MS, message: `flush(${baseDir}) timeout` });
            recordCid(flushedCid, baseDir, "files.flush");
            endFlush();
        }
    }

    // Record the bucket dir CIDs the tree now references (mirrors pkc-js statMfsPathSafely
    // reading postUpdates dir CIDs for the community record; also feeds wedge forensics).
    for (const bucket of buckets) await statAndRecord(ipfs, `${baseDir}/postUpdates/${bucket}`, "bucket-stat");

    if (RM_STALE_BETWEEN_SYNCS && pendingPathsForRm.length) {
        const end = step(`rm-stale-paths`, { community, round, count: pendingPathsForRm.length });
        try {
            await removeMfsFilesSafely(ipfs, pendingPathsForRm);
        } catch (e) {
            end({ error: e.message });
            throw e;
        }
        end();
    }

    staleRefs.length = 0;
}

async function deleteCommunity(ipfs, community) {
    const baseDir = `/${community}`;

    if (FINAL_FLUSH_BEFORE_DELETE) {
        const end = step(`pre-delete-flush`, { community });
        try {
            await pTimeout(tracked(`files.flush ${baseDir}`, ipfs.files.flush(baseDir)), { milliseconds: FLUSH_TIMEOUT_MS, message: `pre-delete flush timeout` });
            end();
        } catch (e) { end({ error: e.message }); throw e; }
    }

    const end = step(`delete-community`, { community, strategy: DELETE_RM_STRATEGY });
    try {
        if (DELETE_RM_STRATEGY === "recursive") {
            await removeMfsFilesSafely(ipfs, [baseDir]);
        } else if (DELETE_RM_STRATEGY === "bottom-up") {
            // Walk MFS tree leaf-first, rm each leaf with recursive:false, then prune empties.
            await bottomUpDelete(ipfs, baseDir);
        } else if (DELETE_RM_STRATEGY === "rename-then-rm") {
            const trashPath = `/_trash_${community}_${Date.now()}`;
            await ipfs.files.mv(baseDir, trashPath);
            await removeMfsFilesSafely(ipfs, [trashPath]);
        }
        end();
    } catch (e) { end({ error: e.message }); throw e; }
}

async function bottomUpDelete(ipfs, dir) {
    const entries = [];
    for await (const e of ipfs.files.ls(dir)) entries.push(e);
    for (const e of entries) {
        const child = `${dir}/${e.name}`;
        if (e.type === "directory" || e.type === 1) await bottomUpDelete(ipfs, child);
        else await pTimeout(ipfs.files.rm(child, { recursive: false }), { milliseconds: RM_TIMEOUT_MS, message: `rm(${child}) timeout` });
    }
    await pTimeout(ipfs.files.rm(dir, { recursive: true, force: true }), { milliseconds: RM_TIMEOUT_MS, message: `rm(${dir}) timeout` });
}

// ---------------------------------------------------------------------------------------------
// Fault injectors
// ---------------------------------------------------------------------------------------------

// E1 control: deliberately remove a known MFS dir-node block, then make traffic
// traverse it. Validates the harness can detect the CI deadlock end-to-end.
async function runE1(ipfs) {
    const community = "community-e1";
    const buckets = Array.from({ length: NUM_BUCKETS }, (_, i) => 1700000000 + i * 100);
    const stale = [];

    await tracked("mkdir", ipfs.files.mkdir(`/${community}`, { parents: true }));
    const seedComments = Math.min(NUM_COMMENTS, 300); // small tree is enough
    const seedEnd = step("e1-seed-tree", { community, comments: seedComments });
    await syncCommunity(ipfs, community, 0, buckets, seedComments, stale);
    seedEnd();

    // Victim: the first bucket's directory node.
    const victimPath = `/${community}/postUpdates/${buckets[0]}`;
    const st = await statAndRecord(ipfs, victimPath, "e1-victim-stat");
    if (!st) throw new Error(`e1: stat(${victimPath}) failed`);
    const victimCid = st.cid;
    console.log(`E1: victim dir ${victimPath} -> ${victimCid}`);

    // Remove the victim block OFFLINE, with the daemon stopped. Doing it via the API of a
    // running daemon is useless: boxo's MFS dir cache still holds the node in memory and
    // the next flush re-persists it (verified 2026-06-11 — block reappeared in blockstore).
    // A daemon restart is also what makes the cache cold so the next traversal must hit
    // the blockstore (pkc-js's test server restarts daemons mid-suite, same effect).
    const rmEnd = step("e1-offline-block-rm-victim", { cid: victimCid.toString() });
    await stopIpfsDaemon();
    const rmRes = await ipfsCli(["block", "rm", "--force", victimCid.toString()]);
    if (rmRes.code !== 0) throw new Error(`e1: offline block rm failed: ${rmRes.err}`);
    const statRes = await ipfsCli(["block", "stat", victimCid.toString()]);
    if (statRes.code === 0) throw new Error(`e1: victim block still present after offline rm: ${statRes.out}`);
    report.removedCids.push({ cid: victimCid.toString(), path: victimPath, mode: "E1-offline" });
    rmEnd({ verified: `block stat exit ${statRes.code}: ${statRes.err.slice(0, 120)}` });
    console.log(`E1: victim block removed offline and verified gone (${statRes.err.slice(0, 80)})`);

    const restartEnd = step("e1-daemon-restart");
    await startIpfsDaemon();
    restartEnd();

    // 1) Poisoned write: must traverse the victim dir to create /<newCid>/update under it.
    //    Fire-and-forget WITHOUT a client timeout so the watchdog sees it pending.
    const poisonPath = `${victimPath}/${commentCid(999999)}/update`;
    console.log(`E1: poisoned write under missing dir node: ${poisonPath}`);
    tracked(`POISONED files.write ${poisonPath}`, ipfs.files.write(poisonPath, new TextEncoder().encode("poison"), { create: true, truncate: true, parents: true, flush: true })).catch(() => {});

    await new Promise((r) => setTimeout(r, 2_000));

    // 2) Root flush: recursively syncs the tree, blocks behind the wedged dir while
    //    holding ancestor locks (this is the cascade step from the CI dump).
    tracked(`files.flush /`, ipfs.files.flush("/")).catch(() => {});

    await new Promise((r) => setTimeout(r, 2_000));

    // 3) Unrelated community traffic should now pile up on the MFS mutexes.
    const otherCommunity = "community-e1-other";
    await tracked("mkdir-other", ipfs.files.mkdir(`/${otherCommunity}`, { parents: true })).catch(() => {});
    for (let i = 0; i < 20; i++) {
        const p = `/${otherCommunity}/postUpdates/${buckets[0]}/${commentCid(i)}/update`;
        tracked(`pileup files.write ${p}`, ipfs.files.write(p, new TextEncoder().encode("pileup"), { create: true, truncate: true, parents: true, flush: true })).catch(() => {});
        tracked(`pileup files.stat /`, ipfs.files.stat("/")).catch(() => {});
        await new Promise((r) => setTimeout(r, 250));
    }

    // Hold the process open; the watchdog fires handleWedge() when the poisoned ops age out.
    console.log("E1: waiting for watchdog verdict...");
    await new Promise((r) => setTimeout(r, WATCHDOG_PENDING_MS + 30_000));
    // If we got here without the watchdog firing, nothing wedged.
    throw new Error("E1 completed without a wedge: poisoned write did not hang (mechanism model wrong?)");
}

// E2: explicit repo.gc concurrent with write bursts.
function startGcLoop(ipfs) {
    let stopped = false;
    (async () => {
        while (!stopped && !wedgeHandled) {
            const end = step("repo-gc");
            try {
                let n = 0;
                for await (const r of ipfs.repo.gc()) { if (r.cid) { n++; recordGcRemoval(r.cid); } }
                end({ removed: n });
            } catch (e) {
                end({ error: e.message });
            }
            await new Promise((r) => setTimeout(r, GC_INTERVAL_MS));
        }
    })();
    return () => { stopped = true; };
}

function recordGcRemoval(cid) {
    // gc reports raw-codec CIDv1 (multihash keyspace); knownCids holds dag-pb CIDv0 strings.
    let key;
    try { key = Buffer.from(cid.multihash.bytes).toString("base64"); } catch { return; }
    for (const [s, meta] of Object.entries(report.knownCids)) {
        try {
            if (multihashKey(s) === key) {
                report.removedCids.push({ cid: s, path: meta.path, source: meta.source, mode: "E2-gc" });
                return;
            }
        } catch {}
    }
}

// E4: purge shared (deduped) blocks from one community while others still reference them.
async function purgeDedupedBlocks(ipfs, community, buckets) {
    const baseDir = `/${community}`;
    const victims = [];
    // pkc-js purge order (per MFS_TIMEOUT_ANALYSIS_SUMMARY): MFS rm -> unpin -> block rm --force.
    for (let i = 0; i < 50; i++) {
        const cid = commentCid(i);
        const p = `${baseDir}/postUpdates/${buckets[i % buckets.length]}/${cid}`;
        const st = await statAndRecord(ipfs, p, "e4-purge-stat");          // dir node CID
        const stFile = await statAndRecord(ipfs, `${p}/update`, "e4-purge-stat-file"); // file block CID
        if (st) victims.push({ path: p, cid: st.cid });
        if (stFile) victims.push({ path: `${p}/update`, cid: stFile.cid });
    }
    const rmPathsEnd = step("e4-mfs-rm-purged", { community, count: victims.length });
    await removeMfsFilesSafely(ipfs, victims.filter((v) => !v.path.endsWith("/update")).map((v) => v.path)).catch((e) => console.error("e4 rm:", e.message));
    rmPathsEnd();
    const blockRmEnd = step("e4-block-rm-purged", { community, count: victims.length });
    try {
        for await (const res of ipfs.block.rm(victims.map((v) => v.cid), { force: true })) {
            if (!res.error) report.removedCids.push({ cid: res.cid.toString(), mode: "E4-purge" });
        }
        blockRmEnd();
    } catch (e) {
        blockRmEnd({ error: e.message });
    }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
async function communityLifecycle(ipfs, c) {
    const community = `community-${c}`;
    const buckets = Array.from({ length: NUM_BUCKETS }, (_, i) => 1700000000 + c * 1000 + i * 100);
    const stale = [];

    const mkdirEnd = step("mkdir-community", { community });
    await tracked(`files.mkdir /${community}`, ipfs.files.mkdir(`/${community}`, { parents: true }));
    mkdirEnd();

    for (let round = 0; round < SYNC_ROUNDS; round++) {
        const roundEnd = step("sync-round", { community, round });

        // E3: fire the pkc-js "auto-nuke" recovery rm into the middle of our own sync round.
        if (FAULT_MODE === "E3" && round > 0) {
            setTimeout(() => {
                if (wedgeHandled) return;
                const end = step("e3-auto-nuke", { community, round });
                tracked(`E3 nuke files.rm /${community}`, ipfs.files.rm(`/${community}`, { recursive: true, force: true }))
                    .then(() => end())
                    .catch((e) => end({ error: e.message }));
            }, NUKE_DELAY_MS);
        }

        try {
            await syncCommunity(ipfs, community, round, buckets, NUM_COMMENTS, stale);
        } catch (e) {
            // E3 nukes the tree under us; per-op errors are expected, hangs are not.
            if (FAULT_MODE === "E3" && /file does not exist|not a directory|paths must start/i.test(e.message)) {
                roundEnd({ error: `expected-after-nuke: ${e.message}` });
                continue;
            }
            throw e;
        }
        roundEnd();

        // E4: after a round, purge deduped blocks from community-0 while others keep referencing them.
        if (FAULT_MODE === "E4" && c === 0) await purgeDedupedBlocks(ipfs, community, buckets);
    }

    await deleteCommunity(ipfs, community);
}

async function main() {
    const setupEnd = step("setup-daemon");
    await setupIpfsNode();
    setupEnd();
    console.log(`kubo ${report.kuboVersion}, faultMode=${FAULT_MODE}, scenario=${SCENARIO}`);

    const ipfs = create({ url: IPFS_API_URL });
    startWatchdog();

    let stopGc = null;
    try {
        if (FAULT_MODE === "E1") {
            await runE1(ipfs);
        } else {
            if (FAULT_MODE === "E2") stopGc = startGcLoop(ipfs);

            const communityLimit = pLimit(Math.max(1, PARALLEL_COMMUNITIES));
            await Promise.all(
                Array.from({ length: NUM_COMMUNITIES }, (_, c) => communityLimit(() => communityLifecycle(ipfs, c)))
            );
        }

        report.result = "ok";
    } catch (e) {
        if (wedgeHandled) return; // handleWedge already owns shutdown
        report.result = "hang";
        report.hangError = e.message;
        console.error("\nHANG (op timeout):", e.message);
        await handleWedge(`op timeout: ${e.message}`);
        return;
    } finally {
        stopGc?.();
    }

    clearInterval(watchdogTimer);
    report.finishedAt = new Date().toISOString();
    writeReport();
    await teardownIpfsNode({ wipe: true });
    console.log(`\nReport: ${reportFile}`);
    console.log(`Kubo stderr: ${kuboStderrFile}`);
    console.log(`Result: ok (no wedge). Last 10 steps:`);
    for (const s of report.steps.slice(-10)) {
        console.log(`  [${s.durationMs ?? "??"}ms] ${s.label}`, s.error ? `ERROR=${s.error}` : "");
    }
}

process.on("SIGINT", async () => { await teardownIpfsNode({ wipe: false }); process.exit(130); });

main().catch(async (e) => {
    console.error("fatal:", e);
    await teardownIpfsNode({ wipe: false });
    process.exit(1);
});
