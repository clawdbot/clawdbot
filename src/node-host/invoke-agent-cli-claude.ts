/** Validates and streams one approval-gated Claude CLI turn on a headless node. */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { signalProcessTree } from "../process/kill-tree.js";
import { resolveSafeChildProcessInvocation } from "../process/windows-command.js";
import { truncateUtf8Suffix } from "../utils/utf8-truncate.js";
import type { NodeHostClient } from "./client.js";
import type { ClaudeCliNodeRunParams } from "./invoke-agent-cli-claude-params.js";
import type { NodeInvokeRequestPayload, RunResult } from "./invoke-types.js";
import { createNodeInvokeProgressWriter } from "./node-invoke-progress.js";

const OUTPUT_CAP_BYTES = 200_000;
const STDERR_TAIL_BYTES = 20_000;
const TERMINAL_EVENT_MAX_BYTES = 1024 * 1024;

function isClaudeResultLine(line: string): boolean {
  try {
    const value = JSON.parse(line) as { type?: unknown };
    return value?.type === "result";
  } catch {
    return false;
  }
}

/** Spawn the node-resolved Claude binary and stream bounded UTF-8 stdout. */
export async function runClaudeCliNodeCommand(params: {
  client: NodeHostClient;
  frame: NodeInvokeRequestPayload;
  request: ClaudeCliNodeRunParams;
  argv: string[];
  cwd: string | undefined;
  env: Record<string, string> | undefined;
  timeoutMs: number | undefined;
  signal?: AbortSignal;
}): Promise<RunResult> {
  const cancelledResult = (): RunResult => ({
    exitCode: 130,
    timedOut: false,
    success: false,
    stdout: "",
    stderr: "Claude CLI invocation cancelled",
    error: null,
    truncated: false,
  });
  if (params.signal?.aborted) {
    return cancelledResult();
  }
  let promptDir: string | undefined;
  let argv = params.argv;
  try {
    if (params.request.systemPrompt !== undefined) {
      promptDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-claude-prompt-"));
      const promptPath = path.join(promptDir, "system-prompt.md");
      await fs.writeFile(promptPath, params.request.systemPrompt, { mode: 0o600 });
      argv = [...argv, "--append-system-prompt-file", promptPath];
    }
    if (params.signal?.aborted) {
      return cancelledResult();
    }
    return await new Promise<RunResult>((resolve) => {
      let settled = false;
      let hardTimedOut = false;
      let idleTimedOut = false;
      let cancelled = false;
      let truncated = false;
      let outputBytes = 0;
      let stderr = "";
      const decoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const terminalDecoder = new StringDecoder("utf8");
      let terminalLineBuffer = "";
      let terminalLineTouchesTruncation = false;
      let terminalResultLine: string | undefined;
      const invocation = resolveSafeChildProcessInvocation({
        argv,
        cwd: params.cwd,
        env: params.env ?? process.env,
      });
      const child = spawn(invocation.command, invocation.args, {
        cwd: params.cwd,
        env: params.env,
        stdio: ["pipe", "pipe", "pipe"],
        ...(process.platform !== "win32" ? { detached: true } : {}),
        windowsHide: invocation.windowsHide,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });

      const kill = () => {
        const pid = child.pid;
        if (typeof pid === "number" && pid > 0) {
          signalProcessTree(pid, "SIGKILL", { detached: process.platform !== "win32" });
        }
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort; close/error settles the result.
        }
      };
      const progress = createNodeInvokeProgressWriter({
        client: params.client,
        frame: params.frame,
        idleTimeoutMs: params.request.idleTimeoutMs,
        onError: kill,
      });
      const abortRun = () => {
        cancelled = true;
        kill();
      };
      params.signal?.addEventListener("abort", abortRun, { once: true });
      if (params.signal?.aborted) {
        abortRun();
      }
      const hardTimer = setTimeout(() => {
        hardTimedOut = true;
        kill();
      }, params.timeoutMs ?? params.request.timeoutMs);
      let idleTimer: ReturnType<typeof setTimeout>;
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimedOut = true;
          kill();
        }, params.request.idleTimeoutMs);
      };
      resetIdleTimer();

      const retain = (chunk: Buffer): Buffer => {
        if (outputBytes >= OUTPUT_CAP_BYTES) {
          truncated = true;
          return Buffer.alloc(0);
        }
        const remaining = OUTPUT_CAP_BYTES - outputBytes;
        const retained = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        outputBytes += retained.length;
        if (retained.length !== chunk.length) {
          truncated = true;
        }
        return retained;
      };

      const captureTerminalLines = (raw: Buffer, touchesTruncation: boolean) => {
        terminalLineBuffer += terminalDecoder.write(raw);
        terminalLineTouchesTruncation ||= touchesTruncation;
        while (true) {
          const newline = terminalLineBuffer.indexOf("\n");
          if (newline < 0) {
            break;
          }
          const line = terminalLineBuffer.slice(0, newline).replace(/\r$/u, "");
          terminalLineBuffer = terminalLineBuffer.slice(newline + 1);
          if (
            terminalLineTouchesTruncation &&
            Buffer.byteLength(line, "utf8") <= TERMINAL_EVENT_MAX_BYTES &&
            isClaudeResultLine(line)
          ) {
            terminalResultLine = line;
          }
          terminalLineTouchesTruncation = touchesTruncation;
        }
        if (Buffer.byteLength(terminalLineBuffer, "utf8") > TERMINAL_EVENT_MAX_BYTES) {
          terminalLineBuffer = "";
          terminalLineTouchesTruncation = false;
        }
      };
      // Output pipes can fail independently; child close/error remains authoritative.
      const ignoreOutputStreamError = () => {};
      child.stdout.on("error", ignoreOutputStreamError);
      child.stderr.on("error", ignoreOutputStreamError);
      child.stdout.on("data", (raw: Buffer) => {
        const retained = retain(raw);
        if (retained.length > 0) {
          captureTerminalLines(retained, false);
        }
        if (retained.length < raw.length) {
          captureTerminalLines(raw.subarray(retained.length), true);
        }
        // The Gateway's inactivity timer observes stdout progress events only;
        // keep the node-local kill timer on the same signal to avoid orphan runs.
        resetIdleTimer();
        if (retained.length === 0) {
          progress.queueHeartbeat();
          return;
        }
        const text = decoder.write(retained);
        void progress.write(text, child.stdout);
      });
      child.stderr.on("data", (raw: Buffer) => {
        retain(raw);
        stderr = truncateUtf8Suffix(`${stderr}${stderrDecoder.write(raw)}`, STDERR_TAIL_BYTES);
        resetIdleTimer();
        progress.queueHeartbeat();
      });
      child.stdin.on("error", () => {});
      child.stdin.end(params.request.stdin ?? "");

      const finish = async (exitCode: number | null, error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(hardTimer);
        clearTimeout(idleTimer);
        progress.stopHeartbeats();
        params.signal?.removeEventListener("abort", abortRun);
        const finalText = decoder.end();
        if (finalText) {
          void progress.write(finalText);
        }
        const terminalText = terminalDecoder.end();
        if (terminalText) {
          terminalLineBuffer += terminalText;
        }
        const finalStderr = stderrDecoder.end();
        if (finalStderr) {
          stderr = truncateUtf8Suffix(`${stderr}${finalStderr}`, STDERR_TAIL_BYTES);
        }
        if (
          terminalLineTouchesTruncation &&
          Buffer.byteLength(terminalLineBuffer, "utf8") <= TERMINAL_EVENT_MAX_BYTES &&
          isClaudeResultLine(terminalLineBuffer)
        ) {
          terminalResultLine = terminalLineBuffer;
        }
        if (truncated && terminalResultLine) {
          void progress.write(`\n${terminalResultLine}\n`);
        }
        await progress.flush();
        progress.stop();
        const timeoutMessage = idleTimedOut
          ? "Claude CLI produced no output before the idle timeout"
          : hardTimedOut
            ? "Claude CLI exceeded the hard timeout"
            : "";
        const finalError = progress.error ?? error;
        const cancelledMessage = cancelled ? "Claude CLI invocation cancelled" : "";
        resolve({
          exitCode: exitCode ?? (idleTimedOut || hardTimedOut ? 124 : cancelled ? 130 : 1),
          timedOut: idleTimedOut || hardTimedOut,
          noOutputTimedOut: idleTimedOut,
          success: exitCode === 0 && !idleTimedOut && !hardTimedOut && !cancelled && !finalError,
          stdout: "",
          stderr: truncateUtf8Suffix(
            [stderr, timeoutMessage, cancelledMessage, finalError?.message]
              .filter(Boolean)
              .join("\n"),
            STDERR_TAIL_BYTES,
          ),
          error: finalError?.message ?? null,
          truncated,
        });
      };
      child.once("error", (error) => void finish(null, error));
      child.once("close", (code) => void finish(code));
    });
  } finally {
    if (promptDir) {
      await fs.rm(promptDir, { recursive: true, force: true });
    }
  }
}
