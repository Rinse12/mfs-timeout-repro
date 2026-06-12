#!/usr/bin/env node
//
// Phase-1b watchdog: polls the pkc-js test server's Kubo daemons for the MFS
// deadlock signature (ipfs/kubo#10842) while the node-local test suite runs.
//
// On detection it saves the goroutine dump and writes a WEDGED-<port>.marker
// file, but does NOT touch the daemon — leave it wedged for post-mortem
// (files stat walks, refs local, offline tree walk after manual daemon kill).
//
// Usage: node watch-test-server-wedge.mjs   (Ctrl+C to stop)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const PORTS = [15001, 15002, 15004, 15005, 15006]; // pkc-js test server daemons
const POLL_MS = Number(process.env.POLL_MS ?? 10_000);
const WAITERS_MIN = Number(process.env.WAITERS_MIN ?? 3);

function analyzeDump(text) {
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
    return { lockHolders: holders.length, holders, mfsMutexWaiters, reproduced: holders.length >= 1 && mfsMutexWaiters >= WAITERS_MIN };
}

async function poll(port) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15_000);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/debug/pprof/goroutine?debug=2`, { signal: ac.signal });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    } finally {
        clearTimeout(t);
    }
}

const alreadyWedged = new Set();
console.log(`watching kubo daemons on ports ${PORTS.join(", ")} every ${POLL_MS / 1000}s for the MFS deadlock signature...`);

for (;;) {
    for (const port of PORTS) {
        if (alreadyWedged.has(port)) continue;
        const text = await poll(port);
        if (!text) continue;
        const a = analyzeDump(text);
        if (a.reproduced) {
            alreadyWedged.add(port);
            const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            const dumpFile = path.join(LOG_DIR, `goroutine_testserver_${port}_${ts}.txt`);
            fs.writeFileSync(dumpFile, text);
            fs.writeFileSync(path.join(__dirname, `WEDGED-${port}.marker`), JSON.stringify({ port, ts, dumpFile, lockHolders: a.lockHolders, mfsMutexWaiters: a.mfsMutexWaiters, holders: a.holders.slice(0, 5) }, null, 2));
            console.log(`\n=== WEDGE on port ${port} at ${ts} ===`);
            console.log(`lockHolders=${a.lockHolders} mfsMutexWaiters=${a.mfsMutexWaiters}`);
            console.log(`dump: ${dumpFile}`);
            console.log(`DO NOT restart the daemon — post-mortem it first.`);
        } else if (a.mfsMutexWaiters > 0 || a.lockHolders > 0) {
            console.log(`port ${port}: partial signal lockHolders=${a.lockHolders} waiters=${a.mfsMutexWaiters}`);
        }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
}
