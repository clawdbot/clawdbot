import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setImmediate as settleIo } from "node:timers/promises";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { redactSensitiveFieldValue, redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import {
  killProcessTree,
  prepareSecretInputStdio,
  type SpawnStdioEntry,
} from "openclaw/plugin-sdk/process-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

export type ClaudeAgentSdkSecretInput = { fd: 3; createData: () => Buffer };

const STDERR_CAPTURE_CHARS = 8_192;
const STDERR_PREVIEW_CHARS = 2_000;
const STDERR_DRAIN_GRACE_MS = 200;

function spawnClaudeAgentSdkProcess(
  options: SpawnOptions,
  secretInput: ClaudeAgentSdkSecretInput | undefined,
  observeStderr: (child: ChildProcessWithoutNullStreams) => void,
): SpawnedProcess {
  const stdio: ["pipe", "pipe", "pipe", ...SpawnStdioEntry[]] = ["pipe", "pipe", "pipe"];
  using secretDelivery = prepareSecretInputStdio(stdio, secretInput);
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.env,
    signal: options.signal,
    stdio,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams; // SAFETY: stdio[0..2] are pipes.
  // The SDK only drains stderr for its built-in spawner; unread custom pipes
  // fill at 64 KiB and deadlock credential-backed Claude processes.
  observeStderr(child);
  const killChild = child.kill.bind(child);
  child.kill = (signal?: NodeJS.Signals | number) => {
    if (!child.pid || (signal !== undefined && signal !== "SIGTERM" && signal !== "SIGKILL")) {
      return killChild(signal);
    }
    // Windows must enumerate descendants before the root disappears; POSIX
    // children own a detached group so cancellation never reaches the host.
    killProcessTree(child.pid, {
      detached: process.platform !== "win32",
      ...(signal === "SIGKILL" ? { force: true } : {}),
    });
    return true;
  };
  void secretDelivery?.deliverTo(child).catch(() => child.kill());
  return child;
}

/** Owns one process's stderr, retaining diagnostics only for its active admitted turn. */
export function createClaudeAgentSdkProcessOwner(
  currentContext: () => CliBackendExecuteContext | undefined,
  secretInput?: ClaudeAgentSdkSecretInput,
) {
  // Prepared credentials are destroyed after each turn; a warm child outlives that preparation.
  const credential = secretInput?.createData();
  let environment: SpawnOptions["env"] = {};
  let child: ChildProcessWithoutNullStreams | undefined;
  let drained: Promise<void> | undefined;
  let owner: CliBackendExecuteContext | undefined;
  let tail = "";
  let dropPartialLine = false;
  let atLineBoundary = true;
  const observeStderr = (process: ChildProcessWithoutNullStreams) => {
    child = process;
    drained = new Promise<void>((resolve) => {
      process.stderr.once("close", resolve);
    });
    process.stderr.setEncoding("utf8");
    process.stderr.on("error", () => {}); // A failed diagnostic pipe must not crash the Gateway.
    process.stderr.on("data", (chunk: string) => {
      let text = chunk;
      const context = currentContext();
      if (context !== owner) {
        owner = context;
        tail = "";
        // Never attach the suffix of an idle/previous turn's credential line to a new turn.
        dropPartialLine = !atLineBoundary;
      }
      atLineBoundary = text.endsWith("\n");
      if (!owner) {
        return;
      }
      if (dropPartialLine) {
        const newline = text.indexOf("\n");
        if (newline < 0) {
          return;
        }
        text = text.slice(newline + 1);
        dropPartialLine = false;
      }
      tail += text;
      if (tail.length > STDERR_CAPTURE_CHARS) {
        const bounded = sliceUtf16Safe(tail, -STDERR_CAPTURE_CHARS);
        const newline = bounded.indexOf("\n");
        // Drop a clipped line in full: its missing prefix may identify a credential.
        tail = newline < 0 ? "" : bounded.slice(newline + 1);
        dropPartialLine = newline < 0;
      }
    });
  };
  return {
    [Symbol.dispose]() {
      credential?.fill(0);
      environment = {};
      tail = "";
      owner = undefined;
    },
    // stdout/stderr are independent pipes. Drain this poll cycle before releasing a warm turn.
    settleStderr: () => settleIo(),
    spawn: (options: SpawnOptions) => {
      environment = options.env;
      return spawnClaudeAgentSdkProcess(options, secretInput, observeStderr);
    },
    async withDiagnostics(error: unknown): Promise<unknown> {
      const context = currentContext();
      if (!context || context.abortSignal?.aborted) {
        return error;
      }
      // Custom SDK spawners report exit before stderr EOF. Descendants may keep the pipe open.
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            drained,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, STDERR_DRAIN_GRACE_MS);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      if (owner !== context || currentContext() !== context || context.abortSignal?.aborted) {
        return error;
      }
      let diagnostic = tail;
      // Known opaque credentials need exact-value masking as well as pattern redaction.
      // Warm turns can mint new grants while the child retains its original environment.
      const secrets = [environment, context.env].flatMap((env) =>
        Object.entries(env).flatMap(([name, value]) =>
          value && redactSensitiveFieldValue(name, value, { mode: "tools" }) !== value
            ? [value]
            : [],
        ),
      );
      if (credential) {
        secrets.push(credential.toString("utf8"));
      }
      for (const secret of secrets.filter(Boolean)) {
        for (const value of [
          secret,
          encodeURIComponent(secret),
          JSON.stringify(secret).slice(1, -1),
        ]) {
          diagnostic = diagnostic.replaceAll(value, "[REDACTED]");
        }
      }
      diagnostic = sliceUtf16Safe(
        redactSensitiveText(diagnostic, { mode: "tools" }),
        -STDERR_PREVIEW_CHARS,
      ).trim();
      return diagnostic
        ? new Error(
            `${error instanceof Error ? error.message : String(error)}\nstderr: ${diagnostic}`,
            { cause: error },
          )
        : error;
    },
  };
}
