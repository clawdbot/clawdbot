#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
// Package proof: relocation, native load dependencies, provenance, and actual
// JSONL worker readiness. Never admits or opens the operator's live state.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  seedMacNodeWorkerProofState,
  readMacNodeWorkerProofRows,
} from "./lib/mac-node-worker-proof-state.mjs";
import { auditMacWorkerPortability } from "./lib/mac-worker-portability.mjs";
import { runManagedCommand, terminateManagedChild } from "./lib/managed-child-process.mts";

const [runtimeArg, expectedInfoPath] = process.argv.slice(2);
if (!runtimeArg || !expectedInfoPath) {
  throw new Error("Usage: verify-mac-node-worker.mjs <runtime> <expected-build-info.json>");
}
const runtime = fs.realpathSync(runtimeArg);
const node = path.join(runtime, "bin/node");
const packageRoot = path.join(runtime, "lib/node_modules/openclaw");
const expected = JSON.parse(fs.readFileSync(expectedInfoPath, "utf8"));
const actual = JSON.parse(fs.readFileSync(path.join(packageRoot, "dist/build-info.json"), "utf8"));
for (const key of ["version", "commit", "builtAt", "buildId"]) {
  if (!expected[key] || expected[key] !== actual[key]) {
    throw new Error(`Private worker build mismatch: ${key}`);
  }
}
if (fs.realpathSync(process.execPath) !== node) {
  throw new Error("Worker proof must execute the bundled Node for the requested architecture");
}

const nativeFiles = auditMacWorkerPortability(runtime, node);

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worker-proof-")));
try {
  // Ready manifests do not load lazy native capabilities. Exercise their real
  // package loaders so omitted optional packages and wrong slices fail staging.
  const require = createRequire(path.join(packageRoot, "package.json"));
  // Keep required native mode and bundled module identity in a fresh process;
  // worker readiness below must still use OpenClaw's normal defaults.
  execFileSync(
    node,
    [fileURLToPath(new URL("./verify-mac-node-worker-fs.mjs", import.meta.url)), packageRoot, home],
    {
      cwd: home,
      env: { HOME: home, TMPDIR: home, FS_SAFE_NATIVE_MODE: "require" },
      stdio: "inherit",
    },
  );
  const database = new DatabaseSync(":memory:", { allowExtension: true });
  try {
    require("sqlite-vec").load(database);
    assert.equal(
      typeof database.prepare("SELECT vec_version() AS version").get().version,
      "string",
    );
  } finally {
    database.close();
  }
  await new Promise((resolve, reject) => {
    const terminal = require("@lydell/node-pty").spawn(
      "/bin/sh",
      ["-c", "printf worker-pty-proof"],
      {
        cwd: home,
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        name: "xterm",
        cols: 80,
        rows: 24,
      },
    );
    let output = "";
    const timeout = setTimeout(() => {
      terminal.kill("SIGKILL");
      reject(new Error("Bundled PTY did not exit"));
    }, 10_000);
    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode === 0 && output === "worker-pty-proof") {
        resolve();
      } else {
        reject(new Error(`Bundled PTY failed (${exitCode}): ${output}`));
      }
    });
  });
  for (const nativeFirst of [false, true]) {
    const proofHome = path.join(home, nativeFirst ? "native-first" : "absent");
    const stateDir = path.join(proofHome, "state");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    fs.mkdirSync(proofHome, { recursive: true });
    // State lifecycle coordination lives outside removable state. Only remove
    // this fresh fixture's exact hashes after the complete worker tree exits.
    const coordinatorHash = createHash("sha256").update(databasePath).digest("hex").slice(0, 8);
    const coordinatorFiles = ["state-lifecycle", "gateway-lifecycle"].flatMap((family) => {
      const file = path.join(
        fs.realpathSync("/tmp"),
        `openclaw-state-locks-${process.getuid()}`,
        `${family}.${coordinatorHash}.lock.sqlite`,
      );
      return [file, `${file}-journal`, `${file}-wal`, `${file}-shm`];
    });
    assert(
      coordinatorFiles.every((file) => !fs.existsSync(file)),
      "Proof coordinator already exists",
    );
    const nativeRows = nativeFirst ? seedMacNodeWorkerProofState(databasePath) : undefined;
    let ready = false;
    let failure;
    let diagnostic = "";
    const exitCode = await runManagedCommand({
      bin: node,
      args: [path.join(packageRoot, "dist/entry.js"), "node", "worker"],
      cwd: proofHome,
      env: {
        HOME: proofHome,
        TMPDIR: proofHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(proofHome, "openclaw.json"),
        PATH: `${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        OPENCLAW_NODE_EXEC_HOST: "app",
        OPENCLAW_NODE_EXEC_FALLBACK: "0",
        // Same launch shape as MacNodeHostWorker: the worker must stay in the owned
        // process group, or requireProcessTreeExit only proves the respawn wrapper died.
        OPENCLAW_NO_RESPAWN: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeoutMs: 300_000,
      requireProcessTreeExit: true,
      onReady(child) {
        const lines = createInterface({ input: child.stdout });
        child.stderr.on("data", (data) => {
          diagnostic = (diagnostic + data.toString()).slice(0, 4000);
        });
        lines.on("line", (line) => {
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            return;
          }
          if (message.type !== "ready") {
            return;
          }
          if (
            message.version !== expected.version ||
            !message.manifest?.commands?.includes("system.run") ||
            !message.manifest?.commands?.includes("system.which") ||
            !message.manifest?.commands?.includes("browser.proxy") ||
            !message.manifest?.commands?.includes("browser.proxy.upload.v1") ||
            !message.manifest?.commands?.includes("mcp.tools.call.v1")
          ) {
            failure = new Error("Bundled worker returned an incompatible capability manifest");
            child.stdin.end('{"type":"stop"}\n');
            return;
          }
          ready = true;
          process.stdout.write(
            `${JSON.stringify({ architecture: process.arch, nativeFirst, build: actual, nativeFiles, databasePath, manifest: message.manifest })}\n`,
          );
          child.stdin.end('{"type":"stop"}\n');
        });
        child.on("close", () => lines.close());
        child.stdin.on("error", (error) => {
          failure = error;
          terminateManagedChild(child, "SIGKILL");
        });
      },
    });
    for (const file of coordinatorFiles) {
      fs.rmSync(file, { force: true });
    }
    if (failure || !ready || exitCode !== 0 || /failed during register/u.test(diagnostic)) {
      throw new Error(
        `Bundled worker proof failed (${exitCode}): ${failure?.message ?? "missing readiness or registration failure"}; ${diagnostic}`,
        { cause: failure },
      );
    }
    if (nativeRows) {
      const initialized = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.deepEqual(readMacNodeWorkerProofRows(initialized), nativeRows);
      } finally {
        initialized.close();
      }
    }
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
