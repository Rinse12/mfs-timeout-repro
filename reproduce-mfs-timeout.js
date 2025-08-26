#!/usr/bin/env node

/**
 * Script to reproduce IPFS MFS files.rm timeout issue
 * Based on https://github.com/ipfs/kubo/issues/10842
 *
 * This script:
 * 1. Sets up a dedicated Kubo node with GC disabled
 * 2. Creates many MFS directories and files without flushing
 * 3. Performs parallel operations to build up cache
 * 4. Attempts to remove deeply nested paths to trigger timeout
 */

import { create } from "kubo-rpc-client";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { performance } from "perf_hooks";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Enable DEBUG logging by default
process.env.DEBUG = process.env.DEBUG || "*";

// Set up logging to files
const logTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const stdoutLogFile = path.join(__dirname, `reproduce-mfs-timeout_stdout_${logTimestamp}.log`);
const stderrLogFile = path.join(__dirname, `reproduce-mfs-timeout_stderr_${logTimestamp}.log`);

// Create log streams
const stdoutStream = fs.createWriteStream(stdoutLogFile, { flags: "a" });
const stderrStream = fs.createWriteStream(stderrLogFile, { flags: "a" });

// Capture original stdout/stderr write functions
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

// Override stdout write to capture output
process.stdout.write = function (chunk, encoding, fd) {
    stdoutStream.write(chunk);
    return originalStdoutWrite.call(process.stdout, chunk, encoding, fd);
};

// Override stderr write to capture output
process.stderr.write = function (chunk, encoding, fd) {
    stderrStream.write(chunk);
    return originalStderrWrite.call(process.stderr, chunk, encoding, fd);
};

// Handle process exit to close streams
process.on("exit", () => {
    stdoutStream.end();
    stderrStream.end();
});

console.log(`📝 Reproduce MFS timeout script logs:`);
console.log(`   📄 stdout: ${stdoutLogFile}`);
console.log(`   📄 stderr: ${stderrLogFile}`);

// Utility function to wrap IPFS calls with 2-minute timeout
function withTimeout(promise, operation, timeoutMs = 120000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => {
                const timestamp = new Date().toISOString();
                const errorMsg = `TIMEOUT: ${operation} exceeded ${timeoutMs / 1000}s at ${timestamp}`;
                console.error(`⏰ ${errorMsg}`);
                reject(new Error(errorMsg));
            }, timeoutMs);
        })
    ]);
}

// Configuration
const TEMP_IPFS_DIR = path.join(__dirname, ".test-ipfs-node");
const API_PORT = 45003;
const GATEWAY_PORT = 48082;
const SWARM_PORT = 44003;
const IPFS_API_URL = `http://127.0.0.1:${API_PORT}`;

// Based on the actual failing test patterns - need intensive parallel load
const NUM_DIRECTORIES = 500; // Moderate number of dirs
const FILES_PER_DIR = 5000; // More files per dir to build cache faster  
const PARALLEL_OPS = 100; // Increase parallelism 
const ROUTING_STRESS_OPS = 100; // More routing pressure
const USE_FLUSH = false;

console.log("=".repeat(70));
console.log("IPFS MFS files.rm Timeout Reproduction Script");
console.log("Based on real production failure from plebbit-js tests");
console.log("=".repeat(70));
console.log(`Temp IPFS directory: ${TEMP_IPFS_DIR}`);
console.log(`API Port: ${API_PORT}, Gateway: ${GATEWAY_PORT}, Swarm: ${SWARM_PORT}`);
console.log(`Directories to create: ${NUM_DIRECTORIES}`);
console.log(`Files per directory: ${FILES_PER_DIR}`);
console.log(`Parallel operations: ${PARALLEL_OPS}`);
console.log(`Routing stress operations: ${ROUTING_STRESS_OPS}`);
console.log(`Flush enabled: ${USE_FLUSH}`);
console.log("");
console.log("This script reproduces the exact conditions from:");
console.log("- GitHub issue: https://github.com/ipfs/kubo/issues/10842");
console.log("- Production failure: plebbit-js test suite timeout");
console.log("- Key factors: Isolated node + Heavy MFS load + No flushing");
console.log("=".repeat(70));

let ipfsDaemon = null;

async function setupIpfsNode() {
    console.log("\n1. Setting up dedicated IPFS node with GC disabled...");

    // Clean up any existing test directory
    if (fs.existsSync(TEMP_IPFS_DIR)) {
        console.log("  Removing existing test IPFS directory...");
        fs.rmSync(TEMP_IPFS_DIR, { recursive: true, force: true });
    }

    // Use IPFS from node_modules for latest version
    const ipfsPath = path.join(__dirname, "../../node_modules/kubo/kubo/ipfs");

    // Initialize IPFS repo
    console.log("  Initializing IPFS repository...");
    await new Promise((resolve, reject) => {
        const init = spawn(ipfsPath, ["init"], {
            env: { ...process.env, IPFS_PATH: TEMP_IPFS_DIR },
            stdio: ["ignore", "pipe", "pipe"]
        });

        let output = "";
        init.stdout.on("data", (data) => (output += data.toString()));
        init.stderr.on("data", (data) => (output += data.toString()));

        init.on("close", (code) => {
            if (code === 0) {
                resolve(output);
            } else {
                reject(new Error(`IPFS init failed with code ${code}: ${output}`));
            }
        });
    });

    console.log("  IPFS repository initialized");

    // Configure the node
    console.log("  Configuring IPFS node...");
    const configPath = path.join(TEMP_IPFS_DIR, "config");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

    // Set ports
    config.Addresses.API = `/ip4/127.0.0.1/tcp/${API_PORT}`;
    config.Addresses.Gateway = `/ip4/127.0.0.1/tcp/${GATEWAY_PORT}`;
    config.Addresses.Swarm = [`/ip4/0.0.0.0/tcp/${SWARM_PORT}`];

    // EXACT configuration from the failing test
    // Copy everything from /home/user2/Nextcloud/projects/plebbit/plebbit-js/.test-ipfs-offline/config
    config.Bootstrap = null; // Critical: No bootstrap peers (isolated node)
    config.Discovery.MDNS.Enabled = false; // Critical: No local discovery

    // Exact datastore settings
    config.Datastore = {
        BlockKeyCacheSize: null,
        BloomFilterSize: 0,
        GCPeriod: "1h",
        HashOnRead: false,
        Spec: {
            mounts: [
                {
                    mountpoint: "/blocks",
                    path: "blocks",
                    prefix: "flatfs.datastore",
                    shardFunc: "/repo/flatfs/shard/v1/next-to-last/2",
                    sync: false,
                    type: "flatfs"
                },
                {
                    compression: "none",
                    mountpoint: "/",
                    path: "datastore",
                    prefix: "leveldb.datastore",
                    type: "levelds"
                }
            ],
            type: "mount"
        },
        StorageGCWatermark: 90,
        StorageMax: "10GB"
    };

    // Exact IPNS settings that match the failing config
    config.Ipns = {
        RecordLifetime: "",
        RepublishPeriod: "",
        ResolveCacheSize: 128,
        MaxCacheTTL: "10s"
    };

    // Match the exact API headers from failing config
    config.API.HTTPHeaders = {
        "Access-Control-Allow-Origin": ["*"]
    };

    // Match Gateway settings
    config.Gateway.HTTPHeaders = {
        "Access-Control-Allow-Headers": ["*"]
    };

    // Ensure Swarm has WebSocket transport like the failing config
    config.Addresses.Swarm = [`/ip4/0.0.0.0/tcp/${SWARM_PORT}/ws`];

    // Other critical settings from failing config
    config.Peering = { Peers: null };
    config.Pubsub = { DisableSigning: false, Router: "" };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log("  IPFS configuration updated (GC disabled, storage limits increased)");

    // Start daemon
    console.log("  Starting IPFS daemon...");

    // Create log files for kubo daemon
    const kuboStdoutLogFile = path.join(__dirname, `kubo_stdout_${logTimestamp}.log`);
    const kuboStderrLogFile = path.join(__dirname, `kubo_stderr_${logTimestamp}.log`);
    const kuboLogStream = fs.createWriteStream(kuboStdoutLogFile, { flags: "a" });
    const kuboErrStream = fs.createWriteStream(kuboStderrLogFile, { flags: "a" });

    console.log(`📝 Kubo daemon logs:`);
    console.log(`   📄 stdout: ${kuboStdoutLogFile}`);
    console.log(`   📄 stderr: ${kuboStderrLogFile}`);

    ipfsDaemon = spawn(ipfsPath, ["daemon", "--enable-gc=false"], {
        env: {
            ...process.env,
            IPFS_PATH: TEMP_IPFS_DIR,
            DEBUG: process.env.DEBUG || "*",
            IPFS_LOGGING: "debug",
            GOLOG_LOG_LEVEL: "debug"
        },
        stdio: ["ignore", "pipe", "pipe"]
    });

    // Capture kubo logs to files
    ipfsDaemon.stdout.on("data", (data) => {
        console.log(`[kubo] ${data}`);
        kuboLogStream.write(data);
    });

    ipfsDaemon.stderr.on("data", (data) => {
        console.error(`[kubo] ${data}`);
        kuboErrStream.write(data);
    });

    // Close kubo log streams on exit
    ipfsDaemon.on("exit", () => {
        kuboLogStream.end();
        kuboErrStream.end();
    });

    // Wait for daemon to be ready
    await new Promise((resolve, reject) => {
        let isReady = false;
        const timeout = setTimeout(() => {
            reject(new Error("IPFS daemon failed to start within 30 seconds"));
        }, 30000);

        const checkOutput = (data) => {
            const chunk = data.toString();
            if (chunk.includes("Daemon is ready") || chunk.includes("API server listening")) {
                if (!isReady) {
                    isReady = true;
                    clearTimeout(timeout);
                    resolve();
                }
            }
        };

        ipfsDaemon.stdout.on("data", checkOutput);
        ipfsDaemon.stderr.on("data", checkOutput);

        ipfsDaemon.on("close", (code) => {
            if (!isReady) {
                clearTimeout(timeout);
                reject(new Error(`IPFS daemon exited with code ${code}`));
            }
        });
    });

    console.log("  IPFS daemon is ready");

    // Wait a bit more for full initialization
    await new Promise((resolve) => setTimeout(resolve, 2000));
}

async function cleanupIpfsNode() {
    console.log("\nCleaning up IPFS node...");

    if (ipfsDaemon) {
        console.log("  Stopping IPFS daemon...");
        ipfsDaemon.kill("SIGTERM");

        // Wait for graceful shutdown
        await new Promise((resolve) => {
            ipfsDaemon.on("close", resolve);
            setTimeout(() => {
                ipfsDaemon.kill("SIGKILL");
                resolve();
            }, 5000);
        });
    }

    if (fs.existsSync(TEMP_IPFS_DIR)) {
        console.log("  Removing test IPFS directory...");
        fs.rmSync(TEMP_IPFS_DIR, { recursive: true, force: true });
    }

    console.log("  Cleanup completed");
}

async function runMfsTimeoutTest() {
    const ipfs = create({ url: IPFS_API_URL });

    // Test connection
    console.log("\n2. Testing connection to managed IPFS node...");
    const id = await withTimeout(ipfs.id(), "ipfs.id()");
    const nodeId = typeof id.id === "string" ? id.id : id.id.toString();
    console.log(`  Connected to node: ${nodeId.substring(0, 20)}...`);

    const baseDir = `/test-mfs-timeout-${Date.now()}`;

    console.log(`\n3. Creating base directory: ${baseDir}`);
    await withTimeout(ipfs.files.mkdir(baseDir, { parents: true }), `ipfs.files.mkdir(${baseDir})`);

    console.log("\n4. Creating nested directory structure without flushing...");
    console.log("  This simulates the plebbit-js MFS usage pattern...");
    const startCreate = performance.now();

    // Create nested directories with files - simulating production subplebbit structure
    const creationPromises = [];

    for (let i = 0; i < NUM_DIRECTORIES; i++) {
        // Exact plebbit-js structure: /{address}/postUpdates/{timestampRange}/{commentCid}/update
        const subplebbitAddress = `sub${i.toString().padStart(3, "0")}`;
        const timestampRange = Date.now() + i;

        creationPromises.push(
            (async () => {
                try {
                    // Add multiple comment updates to this timestamp bucket (simulating comment updates)
                    const filePromises = [];
                    for (let j = 0; j < FILES_PER_DIR; j++) {
                        const commentCid = `Qm${j.toString().padStart(44, "0")}`; // Fake but realistic CID
                        const filePath = `${baseDir}/${subplebbitAddress}/postUpdates/${timestampRange}/${commentCid}/update`;
                        const content = `Comment update data ${i}-${j} ` + "x".repeat(500); // Larger content

                        filePromises.push(
                            withTimeout(
                                ipfs.files.write(filePath, new TextEncoder().encode(content), {
                                    create: true,
                                    parents: true,
                                    flush: false // Critical: no flushing
                                }),
                                `ipfs.files.write(${filePath})`
                            ).catch((err) => {
                                console.error(`Failed to write ${filePath}:`, err.message);
                            })
                        );
                    }

                    // Process files in batches
                    for (let k = 0; k < filePromises.length; k += PARALLEL_OPS) {
                        await Promise.all(filePromises.slice(k, k + PARALLEL_OPS));
                    }

                    if ((i + 1) % 20 === 0) {
                        console.log(`    Created ${i + 1}/${NUM_DIRECTORIES} directories...`);
                    }
                } catch (error) {
                    console.error(`Failed to create directory ${i}:`, error.message);
                }
            })()
        );

        // Process directories in batches to avoid overwhelming
        if (creationPromises.length >= 5) {
            await Promise.all(creationPromises);
            creationPromises.length = 0;
        }
    }

    // Wait for remaining operations
    await Promise.all(creationPromises);

    const createTime = ((performance.now() - startCreate) / 1000).toFixed(2);
    console.log(`  Directory structure creation completed in ${createTime}s`);

    if (USE_FLUSH) {
        console.log("\n5. Flushing MFS (this would prevent the bug)...");
        const flushStart = performance.now();
        await withTimeout(ipfs.files.flush("/"), "ipfs.files.flush(/)");
        const flushTime = ((performance.now() - flushStart) / 1000).toFixed(2);
        console.log(`    Flush completed in ${flushTime}s`);
    } else {
        console.log("\n5. Skipping flush to build up unflushed cache (triggers the bug)...");
    }

    // Generate routing stress like in the failing logs
    console.log("\n6. Generating routing pressure (like in failing test logs)...");
    console.log("  Creating many parallel operations that trigger routing attempts...");
    const routingStressOps = [];

    // Generate operations that will trigger routing requests but fail (isolated node)
    for (let i = 0; i < ROUTING_STRESS_OPS; i++) {
        routingStressOps.push(
            (async () => {
                try {
                    // These operations will trigger internal routing requests that fail
                    const fakeCid = `Qm${i.toString().padStart(44, "0")}`;

                    // Try to resolve a fake IPNS name (will trigger routing)
                    try {
                        await withTimeout(
                            ipfs.name.resolve(`12D3KooW${i.toString().padStart(40, "0")}`, { timeout: 100 }),
                            "ipfs.name.resolve()"
                        );
                    } catch (e) {
                        /* Expected to fail */
                    }

                    // Try to find providers for content (will trigger DHT queries)
                    try {
                        const providerIterator = ipfs.dht.findProvs(fakeCid, { timeout: 100 });
                        await withTimeout(
                            (async () => {
                                for await (const _ of providerIterator) {
                                    break; // Just trigger the operation
                                }
                            })(),
                            "ipfs.dht.findProvs()"
                        );
                    } catch (e) {
                        /* Expected to fail */
                    }
                } catch (error) {
                    // All expected to fail - we just want the routing pressure
                }
            })()
        );

        // Process in batches to maintain parallel pressure
        if (routingStressOps.length >= 20) {
            await Promise.all(
                routingStressOps.map(
                    (op) => op.catch(() => {}) // Ignore all errors
                )
            );
            routingStressOps.length = 0;
        }
    }

    await Promise.all(routingStressOps.map((op) => op.catch(() => {})));
    console.log("  Routing pressure operations completed (all expected to fail)");

    // NOW perform additional cache-building operations while routing is stressed
    console.log("\n7. Performing MFS operations while routing system is stressed...");
    const additionalOps = [];

    // Simulate operations like ipfsCpWithRmIfFails from plebbit-js
    for (let i = 0; i < 100; i++) {
        additionalOps.push(
            (async () => {
                const tempPath = `${baseDir}/temp${i}`;
                const sourcePath = `${baseDir}/sub${String(i % 20).padStart(3, "0")}/postUpdates`;

                try {
                    // Copy operation (builds cache)
                    await withTimeout(
                        ipfs.files.cp(sourcePath, tempPath, {
                            parents: true,
                            flush: false // No flushing!
                        }),
                        `ipfs.files.cp(${sourcePath} -> ${tempPath})`
                    );

                    // Stat operation (accesses cache)
                    await withTimeout(ipfs.files.stat(tempPath), `ipfs.files.stat(${tempPath})`);

                    // List operation (traverses cache) - consume iterator to access cache
                    await withTimeout(
                        (async () => {
                            for await (const file of ipfs.files.ls(tempPath, { long: false })) {
                                void file; // Just access the cache, don't use the data
                            }
                        })(),
                        `ipfs.files.ls(${tempPath})`
                    );
                } catch (error) {
                    // Ignore errors, we're just building cache pressure
                }
            })()
        );

        // Process in smaller batches to maintain pressure
        if (additionalOps.length >= PARALLEL_OPS) {
            await Promise.all(additionalOps);
            additionalOps.length = 0;
        }
    }

    await Promise.all(additionalOps);
    console.log("  MFS cache stress operations completed");

    // THE CRITICAL TEST - Remove deeply nested paths without flushing
    console.log("\n8. THE MOMENT OF TRUTH: Attempting to remove deeply nested paths...");
    console.log("  This is where the timeout should occur if the bug reproduces!");
    console.log("  (Each operation has a 30-second timeout to match test pattern)");

    const pathsToRemove = [];
    // Try to remove various nested structures - match plebbit-js removal pattern
    for (let i = 0; i < 15; i++) {
        const subplebbitAddress = `sub${String(i).padStart(3, "0")}`;
        const timestampRange = Date.now() + i;
        // Remove entire timestamp bucket (like removing purged comments)
        pathsToRemove.push(`${baseDir}/${subplebbitAddress}/postUpdates/${timestampRange}`);
    }

    console.log(`\n  Attempting to remove ${pathsToRemove.length} nested directory trees...`);

    let timeoutCount = 0;

    for (let idx = 0; idx < pathsToRemove.length; idx++) {
        const pathToRemove = pathsToRemove[idx];
        const removeStart = performance.now();
        console.log(`  [${idx + 1}/${pathsToRemove.length}] Removing: ${pathToRemove}`);

        try {
            // Use 2-minute timeout for remove operations
            await withTimeout(
                ipfs.files.rm(pathToRemove, {
                    recursive: true,
                    flush: false // This is the key - no flushing causes the bug
                }),
                `ipfs.files.rm(${pathToRemove})`
            );

            const removeTime = ((performance.now() - removeStart) / 1000).toFixed(2);
            console.log(`    ✓ Success: Removed in ${removeTime}s`);
        } catch (error) {
            const removeTime = ((performance.now() - removeStart) / 1000).toFixed(2);

            if (error.message.includes("TIMEOUT")) {
                timeoutCount++;
                console.log(`    ✗ TIMEOUT: Operation timed out after ${removeTime}s`);

                if (timeoutCount === 1) {
                    console.log("\n" + "=".repeat(70));
                    console.log("🎉 BUG SUCCESSFULLY REPRODUCED! 🎉");
                    console.log("");
                    console.log("The files.rm operation timed out, confirming the issue described in:");
                    console.log("https://github.com/ipfs/kubo/issues/10842");
                    console.log("");
                    console.log("This demonstrates the exact problem plebbit-js faces in production:");
                    console.log("- MFS operations without flushing build up cache");
                    console.log("- Eventually files.rm operations timeout and never resolve");
                    console.log("- The IPFS node becomes unresponsive for MFS operations");
                    console.log("=".repeat(70));
                }

                // Continue with remaining paths to see if pattern persists
                console.log("    Continuing with remaining paths...");
            } else {
                console.log(`    ✗ Failed: ${error.message} (after ${removeTime}s)`);
            }
        }
    }

    if (timeoutCount === 0) {
        console.log("\n9. Test completed without reproducing the timeout bug");
        console.log("   Possible reasons:");
        console.log("   - Try increasing NUM_DIRECTORIES and FILES_PER_DIR");
        console.log("   - The system may be too fast or have different IPFS version");
        console.log("   - Run the script multiple times to build up more state");
    } else {
        console.log(`\n9. Bug reproduction successful! ${timeoutCount} timeouts occurred`);
        console.log("   This confirms the MFS cache issue exists in your IPFS setup");
    }

    // Attempt cleanup (may also timeout)
    console.log("\n10. Attempting cleanup...");
    try {
        await withTimeout(ipfs.files.rm(baseDir, { recursive: true, flush: true }), `ipfs.files.rm(${baseDir}) - cleanup`);
        console.log("   Cleanup successful");
    } catch (error) {
        console.log(`   Cleanup failed: ${error.message}`);
        console.log("   This is expected if the bug was reproduced");
    }

    return timeoutCount > 0;
}

async function main() {
    let bugReproduced = false;

    try {
        await setupIpfsNode();
        bugReproduced = await runMfsTimeoutTest();
    } catch (error) {
        console.error("\nError during test execution:", error.message);
    } finally {
        await cleanupIpfsNode();
    }

    console.log("\n" + "=".repeat(70));
    if (bugReproduced) {
        console.log("✅ SUCCESS: MFS timeout bug has been reproduced!");
        console.log("This confirms the issue exists and affects plebbit-js in production.");
    } else {
        console.log("❌ Bug not reproduced in this run");
        console.log("Try running the script again or increasing the parameters.");
    }
    console.log("=".repeat(70));
}

// Handle cleanup on interruption
process.on("SIGINT", async () => {
    console.log("\n\nScript interrupted by user");
    await cleanupIpfsNode();
    process.exit(1);
});

process.on("SIGTERM", async () => {
    console.log("\n\nScript terminated");
    await cleanupIpfsNode();
    process.exit(1);
});

// Run the test
main().catch(async (error) => {
    console.error("\nUnexpected error in main:", error);
    await cleanupIpfsNode();
    process.exit(1);
});
