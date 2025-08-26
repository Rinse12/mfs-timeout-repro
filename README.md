# Reproducing IPFS MFS files.rm Timeout Bug

This script reproduces the timeout issue described in:
https://github.com/ipfs/kubo/issues/10842

The script automatically sets up and manages its own Kubo IPFS node with garbage collection disabled to maximize the chance of reproducing the bug.

## Prerequisites

**This is a self-contained reproduction script** - just install dependencies:

```bash
npm install
```

No need to install IPFS separately - the script uses the Kubo binary from node_modules.

## Running the Script

```bash
node reproduce-mfs-timeout.js
```

**Self-contained**: The script automatically manages its own IPFS node - no manual daemon setup required!

## How It Works

The script reproduces plebbit-js production patterns through intensive parallel MFS operations:

1. **Creates a dedicated IPFS node** in `.test-ipfs-node/` with GC disabled
2. **Builds up MFS cache** by creating directories and files based on configured values
   - Uses `ipfs.files.write()` with plebbit-js directory structure: `/{subplebbit}/postUpdates/{timestamp}/{commentCid}/update`
   - Operations run in parallel batches of 100 to maximize cache buildup
3. **Stresses the routing system** with concurrent DHT/IPNS operations that fail (isolated node)
   - Parallel `ipfs.name.resolve()` and `ipfs.dht.findProvs()` calls
4. **Performs cache-intensive MFS operations** while routing is stressed:
   - `ipfs.files.cp()` operations to copy directory trees
   - `ipfs.files.stat()` and `ipfs.files.ls()` to traverse cache structures
5. **Attempts removal** of deeply nested paths where timeouts typically occur
   - Uses `ipfs.files.rm()` with 4-minute timeout (240s)
   - Timeouts can occur in any MFS operation (`files.write`, `files.rm`, etc.)
6. **Cleans up** everything when done

## Configuration

Edit the script constants to adjust behavior (around line 247):

```javascript
const NUM_DIRECTORIES = 500; // Directories to create
const FILES_PER_DIR = 5000; // Files per directory
const PARALLEL_OPS = 100; // Parallel operations for stress
const ROUTING_STRESS_OPS = 100; // Routing pressure operations
const USE_FLUSH = true; // Bug occurs with both true and false
```

## Expected Behavior

### ✅ If Bug Reproduces:

-   Script shows "🎉 BUG SUCCESSFULLY REPRODUCED! 🎉"
-   You'll see "TIMEOUT: [operation] exceeded 240s" (files.write, files.rm, or other MFS operations)
-   Confirms the exact issue plebbit-js faces in production

### ❌ If Bug Doesn't Reproduce:

-   The bug can occur with both `USE_FLUSH = true` and `USE_FLUSH = false`
-   Increase `NUM_DIRECTORIES` and `FILES_PER_DIR` values
-   Run the script multiple times back-to-back

## Node Configuration

The script automatically configures the test IPFS node with:

-   **GC completely disabled** (`GCPeriod: "1h"`, `--enable-gc=false`)
-   **High storage limits** (`StorageMax: "10GB"`) to prevent early cleanup
-   **Custom ports** to avoid conflicts (API: 45003, Gateway: 48082)
-   **Isolated networking** (no bootstrap peers, no MDNS discovery)

## Logging and Diagnostics

The script generates comprehensive logs for analysis:

-   **Console output**: Real-time progress with operation summaries
-   **JSON operation log**: Detailed timing data for all IPFS operations
-   **Kubo daemon logs**: Stdout/stderr from the IPFS daemon
-   **Debug logs**: Full debug output when `DEBUG=*` is set

All log files are timestamped and stored in the script directory.
