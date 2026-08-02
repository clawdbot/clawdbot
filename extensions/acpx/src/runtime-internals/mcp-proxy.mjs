#!/usr/bin/env node

/**
 * Stdio MCP proxy used by ACPX wrappers. It injects OpenClaw-provided MCP
 * servers into session creation/load/fork requests before forwarding to target.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { splitCommandLine } from "./mcp-command-line.mjs";

function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message || error.name || "Error";
  }
  return String(error);
}

function decodePayload(argv) {
  const payloadIndex = argv.indexOf("--payload");
  if (payloadIndex < 0) {
    throw new Error("Missing --payload");
  }
  const encoded = argv[payloadIndex + 1];
  if (!encoded) {
    throw new Error("Missing MCP proxy payload value");
  }
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid MCP proxy payload");
  }
  if (typeof parsed.targetCommand !== "string" || parsed.targetCommand.trim() === "") {
    throw new Error("MCP proxy payload missing targetCommand");
  }
  const mcpServers = Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [];
  return {
    targetCommand: parsed.targetCommand,
    mcpServers,
  };
}

function shouldInject(method) {
  return method === "session/new" || method === "session/load" || method === "session/fork";
}

/** Grace period for a cooperative target to exit on forwarded stdin EOF. */
const STDIN_EOF_GRACE_MS = 2_000;

/** Bounded window between SIGTERM and the forced SIGKILL of the target tree. */
const FORCED_REAP_WINDOW_MS = 750;

/**
 * Build the self-contained Windows tree-termination invocation. Windows has
 * no process-group signaling, so the tree walk is delegated to taskkill: /T
 * covers the target and every descendant it owns, and /F forces it (the
 * SIGKILL equivalent) once the graceful phase had its bounded window.
 */
export function createWindowsTreeKillCommand(pid, signal) {
  const args = ["/PID", String(pid), "/T"];
  if (signal === "SIGKILL") {
    args.push("/F");
  }
  return { command: "taskkill", args };
}

/** Signal the whole target process tree (the target owns its group off win32). */
function killTargetTree(child, signal) {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    const { command, args } = createWindowsTreeKillCommand(child.pid, signal);
    try {
      const taskkill = spawn(command, args, { stdio: "ignore", windowsHide: true });
      taskkill.on("error", () => {
        // taskkill unavailable or the target is already gone.
      });
      taskkill.unref();
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Probe whether anything in the target tree is still alive. Off win32 the
 * process group can outlive a cooperative parent exit, so probe the whole
 * group; on Windows only the direct child is observable without a tree walk.
 */
function targetTreeAlive(child) {
  if (process.platform === "win32" || child.pid === undefined) {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function rewriteLine(line, mcpServers) {
  if (!line.trim()) {
    return line;
  }
  try {
    const parsed = JSON.parse(line);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !shouldInject(parsed.method) ||
      !parsed.params ||
      typeof parsed.params !== "object" ||
      Array.isArray(parsed.params)
    ) {
      return line;
    }
    const next = {
      ...parsed,
      params: {
        ...parsed.params,
        mcpServers,
      },
    };
    return JSON.stringify(next);
  } catch {
    return line;
  }
}

/** Build spawn options for the proxied MCP target process. */
export function createTargetSpawnOptions(platform = process.platform) {
  const options = {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  };
  if (platform === "win32") {
    options.windowsHide = true;
  } else {
    // Give the target its own process group so teardown can signal the whole
    // tree (target plus any descendants) instead of the direct child only.
    options.detached = true;
  }
  return options;
}

function isMainModule() {
  const mainPath = process.argv[1];
  if (!mainPath) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(mainPath)).href;
}

function main() {
  const { targetCommand, mcpServers } = decodePayload(process.argv.slice(2));
  const target = splitCommandLine(targetCommand);
  const child = spawn(target.command, target.args, createTargetSpawnOptions());

  if (!child.stdin || !child.stdout) {
    throw new Error("Failed to create MCP proxy stdio pipes");
  }

  const input = createInterface({ input: process.stdin });
  let exiting = false;
  // Set once the host closes stdin: from then on the proxy owns the target
  // tree until the graceful-to-forced reap finishes — even when the direct
  // target exits cooperatively, because its descendants may outlive it.
  let eofTeardown = null;

  const exitWithError = (error) => {
    if (exiting) {
      return;
    }
    exiting = true;
    input.close();
    killTargetTree(child, "SIGTERM");
    process.stderr.write(`${formatErrorMessage(error)}\n`);
    process.exit(1);
  };

  child.stdin.on("error", exitWithError);
  process.stdout.on("error", exitWithError);

  // The target leads its own process group (detached off win32), so host
  // signals aimed at the proxy no longer reach it. Forward them to the whole
  // target tree before dying, or a host that terminates the proxy instead of
  // closing stdin would orphan the target and its descendants.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      if (!exiting) {
        exiting = true;
        killTargetTree(child, signal);
      }
      process.kill(process.pid, signal);
    });
  }

  // Reap the target tree once host-EOF teardown starts: SIGTERM, a bounded
  // window, then SIGKILL for anything that resisted. Only then exit, keeping
  // the target's own exit code (or signal) when it already exited
  // cooperatively. The kill timer stays ref'd so the forced phase runs even
  // when nothing else keeps the event loop alive.
  const reapTargetTree = () => {
    if (exiting || eofTeardown === null) {
      return;
    }
    exiting = true;
    if (eofTeardown.termTimer !== null) {
      clearTimeout(eofTeardown.termTimer);
    }
    killTargetTree(child, "SIGTERM");
    const { code, signal } = eofTeardown;
    process.exitCode = code;
    setTimeout(() => {
      if (targetTreeAlive(child)) {
        killTargetTree(child, "SIGKILL");
      }
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code);
    }, FORCED_REAP_WINDOW_MS);
  };

  input.on("line", (line) => {
    if (exiting) {
      return;
    }
    child.stdin.write(`${rewriteLine(line, mcpServers)}\n`, (error) => {
      if (error) {
        exitWithError(error);
      }
    });
  });
  input.on("close", () => {
    if (exiting || child.stdin.destroyed || child.stdin.writableEnded) {
      return;
    }
    child.stdin.end();
    // The host closed stdin: a cooperative target exits on the forwarded EOF.
    // Give it a short grace period, then reap the whole target tree — SIGTERM,
    // a bounded window, then SIGKILL — so a hung, TERM-resistant, or
    // stdin-ignoring target cannot leak the proxy or any descendant.
    eofTeardown = { termTimer: null, code: 0, signal: null };
    eofTeardown.termTimer = setTimeout(reapTargetTree, STDIN_EOF_GRACE_MS);
    eofTeardown.termTimer.unref();
  });

  child.stdout.pipe(process.stdout);

  child.on("error", exitWithError);

  child.on("close", (code, signal) => {
    if (exiting) {
      return;
    }
    if (eofTeardown !== null) {
      // Cooperative exit during host-EOF teardown: descendants may still be
      // alive in the target's process group, so keep tree ownership and run
      // the reap instead of exiting together with the parent.
      eofTeardown.code = code ?? 0;
      eofTeardown.signal = signal;
      reapTargetTree();
      return;
    }
    exiting = true;
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

if (isMainModule()) {
  main();
}
