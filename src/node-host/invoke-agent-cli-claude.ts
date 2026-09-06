/** Validates and streams one approval-gated Claude CLI turn on a headless node. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { logWarn } from "../logger.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import type { RunExit, SpawnSecretInput } from "../process/supervisor/types.js";
import { truncateUtf8Suffix } from "../utils/utf8-truncate.js";
import { prepareNodeClaudeSkillSession } from "./claude-skill-session.js";
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
  secretInput?: SpawnSecretInput;
  timeoutMs: number | undefined;
  signal?: AbortSignal;
  skillIo?: OpenClawPluginNodeHostCommandIo;
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
  let skillSession: Awaited<ReturnType<typeof prepareNodeClaudeSkillSession>> | undefined;
  let cleanupSkillArtifacts: (() => Promise<void>) | undefined;
  let argv = params.argv;
  try {
    if (params.request.skillRuntime) {
      if (!params.skillIo) {
        throw new Error("Upgrade and restart this node host for Claude skill resources.");
      }
      skillSession = await prepareNodeClaudeSkillSession(params.skillIo);
      cleanupSkillArtifacts = skillSession.cleanup;
      argv = [...argv, ...skillSession.argv];
    }
    const systemPrompt = skillSession
      ? [skillSession.rewriteReferences(params.request.systemPrompt ?? ""), skillSession.catalog]
          .filter(Boolean)
          .join("\n\n")
      : params.request.systemPrompt;
    if (systemPrompt !== undefined) {
      promptDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-node-claude-prompt-"));
      const promptPath = path.join(promptDir, "system-prompt.md");
      await fs.writeFile(promptPath, systemPrompt, { mode: 0o600 });
      argv = [...argv, "--append-system-prompt-file", promptPath];
    }
    if (params.signal?.aborted) {
      return cancelledResult();
    }
    const supervisor = getProcessSupervisor();
    const runId = randomUUID();
    let cancelled = false;
    let truncated = false;
    let outputBytes = 0;
    let stderr = "";
    let terminalLineBuffer = "";
    let terminalLineTouchesTruncation = false;
    let terminalResultLine: string | undefined;
    const decoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const terminalDecoder = new StringDecoder("utf8");
    const progress = createNodeInvokeProgressWriter({
      client: params.client,
      frame: params.frame,
      idleTimeoutMs: params.request.idleTimeoutMs,
      onError: () => supervisor.cancel(runId),
    });
    // The runtime owns one progress sequence for duplex invocations. Do not
    // interleave a second raw stdout sequence with its framed messages.
    let stdoutQueue = Promise.resolve();
    const writeProgress = (text: string) => {
      if (!skillSession) {
        return progress.write(text);
      }
      stdoutQueue = stdoutQueue.then(() => skillSession!.writeStdout(text));
      void stdoutQueue.catch(() => supervisor.cancel(runId));
      return stdoutQueue;
    };
    const abortRun = () => {
      cancelled = true;
      supervisor.cancel(runId);
    };
    const retain = (chunk: Buffer) => {
      const remaining = Math.max(0, OUTPUT_CAP_BYTES - outputBytes);
      const retained = chunk.subarray(0, remaining);
      outputBytes += retained.length;
      truncated ||= retained.length !== chunk.length;
      return retained;
    };
    const captureTerminalLines = (raw: Buffer, touchesTruncation: boolean) => {
      terminalLineBuffer += terminalDecoder.write(raw);
      terminalLineTouchesTruncation ||= touchesTruncation;
      for (let newline = terminalLineBuffer.indexOf("\n"); newline >= 0;) {
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
        newline = terminalLineBuffer.indexOf("\n");
      }
      if (Buffer.byteLength(terminalLineBuffer, "utf8") > TERMINAL_EVENT_MAX_BYTES) {
        terminalLineBuffer = "";
        terminalLineTouchesTruncation = false;
      }
    };

    let exit: RunExit | undefined;
    let runError: Error | undefined;
    params.signal?.addEventListener("abort", abortRun, { once: true });
    try {
      const runPromise = supervisor.spawn({
        runId,
        sessionId: params.request.sessionKey ?? params.frame.id,
        backendId: "node-host-claude",
        mode: "child",
        argv,
        cwd: params.cwd,
        env: params.env,
        exactEnv: true,
        input:
          skillSession?.rewriteReferences(params.request.stdin ?? "") ?? params.request.stdin ?? "",
        secretInput: params.secretInput,
        timeoutMs: params.timeoutMs ?? params.request.timeoutMs,
        noOutputTimeoutMs: params.request.idleTimeoutMs,
        captureOutput: false,
        onStdoutRaw: (raw) => {
          const retained = retain(raw);
          captureTerminalLines(retained, false);
          if (retained.length < raw.length) {
            captureTerminalLines(raw.subarray(retained.length), true);
          }
          if (retained.length === 0) {
            if (!skillSession) {
              progress.queueHeartbeat();
            }
            return;
          }
          void writeProgress(decoder.write(retained));
        },
        onStderrRaw: (raw) => {
          retain(raw);
          stderr = truncateUtf8Suffix(`${stderr}${stderrDecoder.write(raw)}`, STDERR_TAIL_BYTES);
          if (!skillSession) {
            progress.queueHeartbeat();
          }
        },
      });
      if (params.signal?.aborted) {
        abortRun();
      }
      const run = await runPromise;
      if ((promptDir || cleanupSkillArtifacts) && run.waitForExtinction) {
        const ownedPromptDir = promptDir;
        const ownedSkillCleanup = cleanupSkillArtifacts;
        promptDir = undefined;
        cleanupSkillArtifacts = undefined;
        // Descendants may still own this file after their root result is already visible.
        void run
          .waitForExtinction()
          .then(async () => {
            if (ownedPromptDir) {
              await fs.rm(ownedPromptDir, { recursive: true, force: true });
            }
            await ownedSkillCleanup?.();
          })
          .catch((error: unknown) => {
            logWarn(`Claude CLI system prompt cleanup failed: ${String(error)}`);
          });
      }
      exit = await run.wait();
    } catch (error) {
      runError = error instanceof Error ? error : new Error(String(error));
    } finally {
      params.signal?.removeEventListener("abort", abortRun);
      progress.stopHeartbeats();
    }

    void writeProgress(decoder.end());
    terminalLineBuffer += terminalDecoder.end();
    stderr = truncateUtf8Suffix(`${stderr}${stderrDecoder.end()}`, STDERR_TAIL_BYTES);
    if (
      terminalLineTouchesTruncation &&
      Buffer.byteLength(terminalLineBuffer, "utf8") <= TERMINAL_EVENT_MAX_BYTES &&
      isClaudeResultLine(terminalLineBuffer)
    ) {
      terminalResultLine = terminalLineBuffer;
    }
    if (truncated && terminalResultLine) {
      void writeProgress(`\n${terminalResultLine}\n`);
    }
    await stdoutQueue.catch((error: unknown) => {
      runError = error instanceof Error ? error : new Error(String(error));
    });
    await progress.flush();
    progress.stop();

    const idleTimedOut = !cancelled && exit?.noOutputTimedOut === true;
    const timedOut = !cancelled && exit?.timedOut === true;
    const timeoutMessage = idleTimedOut
      ? "Claude CLI produced no output before the idle timeout"
      : timedOut
        ? "Claude CLI exceeded the hard timeout"
        : "";
    const finalError = progress.error ?? runError;
    return {
      exitCode: cancelled ? 130 : (exit?.exitCode ?? (timedOut ? 124 : 1)),
      timedOut,
      noOutputTimedOut: idleTimedOut,
      success: exit?.exitCode === 0 && !timedOut && !cancelled && !finalError,
      stdout: "",
      stderr: truncateUtf8Suffix(
        [
          stderr,
          timeoutMessage,
          cancelled ? "Claude CLI invocation cancelled" : "",
          finalError?.message,
        ]
          .filter(Boolean)
          .join("\n"),
        STDERR_TAIL_BYTES,
      ),
      error: finalError?.message ?? null,
      truncated,
    };
  } finally {
    try {
      await skillSession?.close();
    } finally {
      try {
        await cleanupSkillArtifacts?.();
      } finally {
        if (promptDir) {
          await fs.rm(promptDir, { recursive: true, force: true });
        }
      }
    }
  }
}
