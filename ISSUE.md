# Deterministic reproduction: `repo gc` concurrent with MFS writes permanently wedges MFS (kubo 0.42.0)

> Canonical writeup for the upstream report on https://github.com/ipfs/kubo/issues/10842.
> All evidence produced with kubo 0.42.0 / boxo v0.40.0 on linux/amd64. Repro scripts live in this repo.

## TL;DR

We finally have a **deterministic, machine-checkable reproduction** of the MFS hang, plus the mechanism, plus goroutine dumps from both production CI and the repro:

1. `repo gc` computes its live set from pins + the **persisted** MFS root. Directory-node blocks referenced only by MFS's **in-memory** state (mid-update, or cached-but-not-yet-re-linked) are invisible to that walk, so GC collects them while concurrent `files` writes are in flight.
2. The next MFS path traversal does `mfs.Directory.childUnsync → unixfs io.BasicDirectory.Find → dagService.Get(<collected CID>)` — a blockstore miss that falls through to **`bitswap SyncGetBlock` with no timeout, while holding the MFS directory mutex** (`mfs/dir.go` `Child`/`childUnsync` hold `d.lock`; `unixfs/io/directory.go:879` does the `dserv.Get`). Nobody on the network has a private MFS dir node, so the goroutine waits forever.
3. `files flush` / `files rm` walk the tree taking ancestor locks, so they queue behind the wedged directory **while holding locks up to the MFS root** — after which **every** MFS request on the daemon hangs forever, while `/id`, `/version`, `repo/stat` keep answering in milliseconds. Every API-level recovery (including `files rm` of the affected tree) just becomes one more blocked goroutine.

## Why you couldn't reproduce it (answering the Dec 2025 / Jan 2026 triage)

Two conditions are both necessary, and a quiet desktop daemon never meets them together:

- **(a) Block removal concurrent with MFS write traffic.** In practice: `repo gc` racing `files write/flush/rm`. Without GC (or some other block remover), the workload alone never wedges — we ran the same traffic generator with no fault injection and it is clean every time.
- **(b) A cold MFS directory cache for the affected entry.** This is the subtle one: if the dir node is still in boxo's in-memory `entriesCache`, the next flush silently **re-persists the removed block** (we verified this directly: `block rm` a dir-node CID via the API of a running daemon, and the block reappears in the blockstore after the next flush). The wedge only triggers when the cache is cold — which happens *constantly* under a flush-heavy workload, because `Directory.Flush → getNode(true) → cacheSync(clean=true)` wipes `entriesCache`, and also after any daemon restart.

Our client (pkc-js) flushes per-write and per-batch, so dir lookups permanently alternate between "cache wiped by flush" and "re-read node from blockstore under the dir mutex" — maximizing exposure to (b) whenever (a) fires.

## Why it "persists after restart" (answering the Oct 2025 datapoint)

This looked like a separate problem at the time; it is the same bug. Once GC has collected dir-node blocks, the **persisted MFS root durably references missing blocks**. After a restart the dir cache is cold everywhere, so the first traversal into a dangling subtree re-wedges the daemon immediately. That is why only deleting the repo (or surgically removing the dangling subtree before any traversal) recovers.

Related operational finding: a wedged daemon **does not shut down on SIGTERM** — graceful shutdown waits on the wedged MFS subsystem (and `Internal.ShutdownTimeout` defaults to 12h). Recovery requires SIGKILL.

## Reproduction (one command each)

```bash
npm install

# Realistic cause: repo.gc loop racing pkc-js-shaped concurrent MFS traffic.
# Wedged 5/5 runs in ~2 minutes. Exit 42 = wedge with machine-checked deadlock signature.
npm run repro:e2

# Minimal primitive: seed a tree, stop daemon, `ipfs block rm --force <one bucket dir-node CID>`
# offline (verified gone), start daemon (cold cache), write under that directory. 3/3 runs.
npm run repro:e1

# Control: same traffic, no fault -> clean (exit 0).
npm run repro:e0
```

The harness (`repro-pkc-js-pattern.js`) detects the wedge with a watchdog (any MFS op pending >45s while `/api/v0/id` still answers), captures `/debug/pprof/goroutine?debug=2`, and asserts the signature: ≥1 goroutine in `mfs …Find → … → bitswap SyncGetBlock` plus N goroutines in `sync.Mutex.Lock` on `mfs.(*Directory)`. It also records every CID returned by `files flush`/`files stat` during the run and diffs them against `refs local` (by multihash) after the wedge.

**Forensics from a tracked E2 run:** the 225 CIDs that `repo gc` reported removing were exactly the 225 MFS-referenced directory-node blocks missing from the blockstore post-mortem. GC names the blocks; the wedge then waits on one of them.

## Evidence tally (kubo 0.42.0)

| Experiment | Runs | Wedge | Notes |
|---|---|---|---|
| E2: `repo gc` racing concurrent MFS writes | 5 | **5** | 4/5 matched the full goroutine signature on the first dump; the other dump raced the GC stall and matched on re-dump |
| E1: one dir-node block removed offline + cold cache | 3 | **3** | deterministic by construction; every precondition verified in-run |
| E0: same traffic, no fault | several | 0 | |
| E3: recursive `files rm` racing in-flight writes to the same tree | 4 | 0 | |
| E4: `block rm --force` of blocks dedup-shared across MFS trees (running daemon) | 1 | 0 | warm cache re-persists them |
| E5: aborting a fraction of `files write/rm` requests mid-flight | 2 | 0 | request-ctx cancellation does not corrupt MFS |
| notify-race: `block get` before `block put` of the same CID, 0-30 ms apart | 2000 iters | 0 stuck | `NotifyNewBlocks` wake-up works; the wedge is not a missed local notification |

We also hit the identical wedge (same stacks, same `Find` argument shape) on a real CI-style daemon serving a full parallel test suite, with `repo gc` log lines seconds before the wedge — and in GitHub Actions CI dumps (kubo 0.42.0, 250+ goroutines blocked 25+ minutes).

## Lock-holder stack (identical, frame-for-frame, in CI dumps and the repro)

```
goroutine N [select, X minutes]:
github.com/ipfs/boxo/bitswap/client/internal/getter.SyncGetBlock(...)
        github.com/ipfs/boxo@v0.40.0/bitswap/client/internal/getter/getter.go:49
github.com/ipfs/boxo/bitswap/client.(*Client).GetBlock(...)
        github.com/ipfs/boxo@v0.40.0/bitswap/client/client.go:430
github.com/ipfs/boxo/blockservice.getBlock(...)
        github.com/ipfs/boxo@v0.40.0/blockservice/blockservice.go:272
...
github.com/ipfs/boxo/ipld/merkledag.(*dagService).Get(...)
        github.com/ipfs/boxo@v0.40.0/ipld/merkledag/merkledag.go:88
github.com/ipfs/boxo/ipld/unixfs/io.(*BasicDirectory).Find(...)
        github.com/ipfs/boxo@v0.40.0/ipld/unixfs/io/directory.go:879
github.com/ipfs/boxo/mfs.(*Directory).childFromDag(...)   [d.lock HELD]
github.com/ipfs/boxo/mfs.(*Directory).childUnsync(...)
github.com/ipfs/boxo/mfs.(*Directory).mkdirWithOpts(...)
github.com/ipfs/boxo/mfs.Mkdir(...)
github.com/ipfs/kubo/core/commands.ensureContainingDirectoryExists(...)
        github.com/ipfs/kubo@v0.42.0/core/commands/files.go:1501
```

And the pile-up (up to 250+ of these, including the `files rm` you would use to recover):

```
goroutine M [sync.Mutex.Lock, X minutes]:
sync.(*Mutex).Lock(...)
github.com/ipfs/boxo/mfs.(*Directory).Child / .getNode / .Flush
github.com/ipfs/kubo/core/commands.removePath
        github.com/ipfs/kubo@v0.42.0/core/commands/files.go:1435
```

## Suggested fix directions (happy to test patches)

1. **Bound the under-lock fetch**: `unixfs io directory.Find` (and MFS paths that call it while holding `Directory.lock`) should use an offline/local-only DAG service or a bounded context. A directory traversal should fail fast on a locally-missing block instead of waiting indefinitely on bitswap while holding the mutex. This alone converts "permanently wedged daemon, SIGKILL required" into an error the client can handle.
2. **Make GC and MFS coherent**: GC's live set should include MFS in-memory state (or GC should quiesce/flush MFS under a shared lock) so concurrent `files` writes cannot have their just-linked nodes collected. This removes the corruption (dangling persisted root) rather than just the hang.

Given there is now a one-command deterministic repro, we would appreciate this being re-prioritized from P2. Artifacts in this repo: `repro-pkc-js-pattern.js` (harness + fault modes + signature detection + forensics), `test-notify-race.mjs` (null test), `watch-test-server-wedge.mjs` (live-daemon watchdog), goroutine dumps and JSON op-logs from the runs.
