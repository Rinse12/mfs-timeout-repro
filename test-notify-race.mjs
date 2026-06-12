#!/usr/bin/env node
//
// Minimal bitswap notify-race test (no MFS involved).
//
// Hypothesis: on kubo 0.42 (boxo 0.40), a block lookup that misses the local
// blockstore and registers a bitswap want can MISS the NotifyNewBlocks wake-up
// from a concurrent local block.put of the same CID. On a daemon with no peers
// the want then never resolves => the get hangs forever. This is the same
// blockservice.getBlock -> bitswap Client.GetBlock path that boxo MFS dir
// lookups take while holding the MFS directory mutex (ipfs/kubo#10842 wedge).
//
// Method: for each iteration, compute a fresh raw block's CID client-side,
// fire block.get(cid) FIRST (guaranteed local miss -> bitswap want), then after
// a randomized 0..D ms delay block.put the bytes. The put's notify must wake
// the getter. Any get that stays pending despite the block being present
// locally = bug reproduced.
//
// Exit codes: 0 = all iterations resolved; 42 = at least one stuck get with
// the block verifiably present (dump captured).

import { create, CID } from "kubo-rpc-client";
import { sha256 } from "multiformats/hashes/sha2";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const ITERATIONS = Number(process.env.ITERATIONS ?? 2000);
const MAX_DELAY_MS = Number(process.env.MAX_DELAY_MS ?? 30);
const STUCK_AFTER_MS = Number(process.env.STUCK_AFTER_MS ?? 15_000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8); // parallel iterations to stress notify ordering
const NOISE_PUTS = Number(process.env.NOISE_PUTS ?? 4);   // unrelated puts fired around each race to stress notify

const TEMP_IPFS_DIR = path.join(__dirname, ".test-ipfs-node-race");
const API_PORT = 45013;
const IPFS_API_URL = `http://127.0.0.1:${API_PORT}`;
const ipfsBin = path.join(__dirname, "node_modules/kubo/kubo/ipfs");

let ipfsDaemon = null;

async function setup() {
    if (fs.existsSync(TEMP_IPFS_DIR)) fs.rmSync(TEMP_IPFS_DIR, { recursive: true, force: true });
    await new Promise((res, rej) => {
        const p = spawn(ipfsBin, ["init"], { env: { ...process.env, IPFS_PATH: TEMP_IPFS_DIR }, stdio: "ignore" });
        p.on("close", (c) => (c === 0 ? res() : rej(new Error(`init exit ${c}`))));
    });
    const configPath = path.join(TEMP_IPFS_DIR, "config");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    cfg.Addresses.API = `/ip4/127.0.0.1/tcp/${API_PORT}`;
    cfg.Addresses.Gateway = `/ip4/127.0.0.1/tcp/45014`;
    cfg.Addresses.Swarm = [`/ip4/0.0.0.0/tcp/45015/ws`];
    cfg.Bootstrap = null;
    cfg.Discovery.MDNS.Enabled = false;
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    ipfsDaemon = spawn(ipfsBin, ["daemon", "--enable-gc=false"], { env: { ...process.env, IPFS_PATH: TEMP_IPFS_DIR }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("daemon start timeout")), 30_000);
        const check = (d) => { if (d.toString().includes("Daemon is ready")) { clearTimeout(t); res(); } };
        ipfsDaemon.stdout.on("data", check);
        ipfsDaemon.stderr.on("data", check);
    });
}

async function teardown() {
    if (!ipfsDaemon) return;
    ipfsDaemon.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 500));
    if (fs.existsSync(TEMP_IPFS_DIR)) fs.rmSync(TEMP_IPFS_DIR, { recursive: true, force: true });
}

async function dumpGoroutines(label) {
    try {
        const res = await fetch(`${IPFS_API_URL}/debug/pprof/goroutine?debug=2`);
        const text = await res.text();
        const file = path.join(LOG_DIR, `goroutine_notifyrace_${label}_${Date.now()}.txt`);
        fs.writeFileSync(file, text);
        return file;
    } catch (e) {
        return `dump failed: ${e.message}`;
    }
}

// CIDv1 raw, sha2-256 — computed client-side so we can "get before put".
const RAW = 0x55;
async function rawCidFor(bytes) {
    return CID.create(1, RAW, await sha256.digest(bytes));
}

let stuck = 0, resolved = 0, putBeforeGetWins = 0;

async function raceIteration(ipfs, i) {
    const bytes = Buffer.from(`notify-race-${i}-${"x".repeat(64)}`);
    const cid = await rawCidFor(bytes);

    // 1) get first — guaranteed local miss -> bitswap want on a no-peer daemon
    const getPromise = ipfs.block.get(cid).then(
        () => ({ ok: true }),
        (e) => ({ ok: false, err: e.message })
    );

    // 2) noise puts to stress notify ordering
    for (let n = 0; n < NOISE_PUTS; n++) ipfs.block.put(Buffer.from(`noise-${i}-${n}-${Math.random()}`)).catch(() => {});

    // 3) racing put of the wanted bytes
    await new Promise((r) => setTimeout(r, Math.random() * MAX_DELAY_MS));
    const putCid = await ipfs.block.put(bytes, { format: "raw", version: 1 });
    if (putCid.toString() !== cid.toString()) throw new Error(`cid mismatch: computed ${cid} vs put ${putCid}`);

    // 4) the get must now resolve via NotifyNewBlocks
    const verdict = await Promise.race([
        getPromise,
        new Promise((r) => setTimeout(() => r({ ok: false, stuck: true }), STUCK_AFTER_MS))
    ]);

    if (verdict.stuck) {
        stuck++;
        // The block IS present (we just put it) — confirm via block.stat, then dump.
        const stat = await ipfs.block.stat(cid).then((s) => `present size=${s.size}`, (e) => `stat failed: ${e.message}`);
        const dump = await dumpGoroutines(`iter${i}`);
        console.error(`\nSTUCK GET iter=${i} cid=${cid} blockstore=${stat}`);
        console.error(`goroutine dump: ${dump}`);
        return false;
    }
    resolved++;
    return true;
}

async function main() {
    await setup();
    const ipfs = create({ url: IPFS_API_URL });
    console.log(`notify-race: ${ITERATIONS} iterations, concurrency ${CONCURRENCY}, max put delay ${MAX_DELAY_MS}ms, kubo ${(await ipfs.version()).version}`);

    let next = 0;
    async function worker() {
        for (;;) {
            const i = next++;
            if (i >= ITERATIONS || stuck > 0) return;
            await raceIteration(ipfs, i);
            if (i > 0 && i % 200 === 0) console.log(`  iter ${i}: resolved=${resolved} stuck=${stuck}`);
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    console.log(`\ndone: resolved=${resolved} stuck=${stuck}`);
    await teardown();
    process.exit(stuck > 0 ? 42 : 0);
}

process.on("SIGINT", async () => { await teardown(); process.exit(130); });
main().catch(async (e) => { console.error("fatal:", e); await teardown(); process.exit(1); });
