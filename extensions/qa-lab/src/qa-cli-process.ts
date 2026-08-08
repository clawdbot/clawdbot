// Qa Lab plugin module runs CLI processes and parses their structured output.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  appendQaChildOutput,
  appendQaChildOutputTail,
  createQaChildOutputCapture,
  createQaChildOutputTail,
  formatQaChildOutputTail,
  QA_CHILD_STDOUT_MAX_BYTES,
  readQaChildOutput,
} from "./child-output.js";
import { QaSuiteInfraError } from "./errors.js";
import { resolveQaNodeExecPath } from "./node-exec.js";
import { createQaPosixCommandSettlement } from "./posix-command-settlement.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import { resolveQaWindowsSystem32ExePath } from "./windows-system-tools.js";

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\x1B\[[0-?]*[ -/]*[@-~]`, "g");

function stripAnsiCodes(text: string) {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function findBalancedJsonEnd(text: string, startIndex: number) {
  const opening = text[startIndex];
  const firstClosing = opening === "{" ? "}" : opening === "[" ? "]" : "";
  if (!firstClosing) {
    return -1;
  }

  const stack = [firstClosing];
  let inString = false;
  let escaping = false;
  for (let index = startIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
    } else if (char === "}" || char === "]") {
      if (stack.at(-1) !== char) {
        return -1;
      }
      stack.pop();
      if (stack.length === 0) {
        return index;
      }
    }
  }
  return -1;
}

function parseBalancedJsonPayloadStart(text: string) {
  const trimmedStart = text.search(/\S/u);
  if (trimmedStart < 0) {
    return undefined;
  }
  const char = text[trimmedStart];
  if (char !== "{" && char !== "[") {
    return undefined;
  }
  const end = findBalancedJsonEnd(text, trimmedStart);
  if (end <= trimmedStart) {
    return undefined;
  }
  try {
    return JSON.parse(text.slice(trimmedStart, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStructuredDiagnosticJson(value: unknown) {
  if (!isJsonRecord(value)) {
    return false;
  }
  const level = value.level ?? value.logLevel ?? value.severity;
  if (typeof level !== "string") {
    return false;
  }
  return (
    typeof value.message === "string" ||
    typeof value.msg === "string" ||
    typeof value.time === "string" ||
    typeof value.timestamp === "string"
  );
}

function isMemorySearchJsonPayload(value: unknown) {
  return isJsonRecord(value) && Array.isArray(value.results);
}

function isMemoryStatusJsonPayload(value: unknown) {
  if (Array.isArray(value)) {
    return true;
  }
  return isJsonRecord(value) && value.command === "memory" && value.subcommand === "status";
}

function resolveQaCliJsonPayloadMatcher(args: readonly string[]) {
  if (!args.includes("--json")) {
    return undefined;
  }
  if (args[0] === "memory" && args[1] === "search") {
    return isMemorySearchJsonPayload;
  }
  if (args[0] === "memory" && args[1] === "status") {
    return isMemoryStatusJsonPayload;
  }
  return undefined;
}

function parseQaCliJsonOutput(text: string, args: readonly string[]) {
  const cleaned = stripAnsiCodes(text).trim();
  if (!cleaned) {
    return {};
  }
  const matchesExpectedPayload = resolveQaCliJsonPayloadMatcher(args);
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    // Some startup repair logs are emitted on stdout before command JSON.
    const lines = cleaned.split(/\r?\n/);
    const candidates: unknown[] = [];
    for (const [index, line] of lines.entries()) {
      const candidate = line.trimStart();
      if (candidate !== line || (!candidate.startsWith("{") && !candidate.startsWith("["))) {
        continue;
      }
      const jsonTail = lines.slice(index).join("\n");
      try {
        candidates.push(JSON.parse(jsonTail) as unknown);
      } catch {
        const balanced = parseBalancedJsonPayloadStart(jsonTail);
        if (balanced !== undefined) {
          candidates.push(balanced);
        }
      }
    }
    const expectedPayload = candidates.find((value) => matchesExpectedPayload?.(value) === true);
    if (expectedPayload !== undefined) {
      return expectedPayload;
    }
    const payload = candidates.toReversed().find((value) => !isStructuredDiagnosticJson(value));
    if (payload !== undefined) {
      return payload;
    }
    const diagnosticOnly = candidates.at(-1);
    if (diagnosticOnly !== undefined) {
      return diagnosticOnly;
    }

    // Keep a line-oriented fallback for compact payloads followed by diagnostics.
    for (const line of lines.toReversed()) {
      const candidate = line.trim();
      if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
        continue;
      }
      try {
        return JSON.parse(candidate) as unknown;
      } catch {
        // Keep looking for the actual payload line.
      }
    }
    throw new Error(`qa cli returned non-JSON stdout: ${truncateUtf16Safe(cleaned, 240)}`);
  }
}

function killQaCliWindowsProcessTree(child: Pick<ChildProcessWithoutNullStreams, "kill" | "pid">) {
  if (child.pid) {
    const result = spawnSync(
      resolveQaWindowsSystem32ExePath("taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5_000,
      },
    );
    if (!result.error && result.status === 0) {
      return;
    }
  }
  child.kill("SIGKILL");
}

async function runQaCli(
  env: Pick<
    QaSuiteRuntimeEnv,
    "gateway" | "repoRoot" | "primaryModel" | "alternateModel" | "providerMode"
  >,
  args: string[],
  opts?: { timeoutMs?: number; json?: boolean; env?: NodeJS.ProcessEnv },
) {
  const stdout = createQaChildOutputCapture();
  const stdoutTail = createQaChildOutputTail();
  const stderr = createQaChildOutputTail();
  const distEntryPath = path.join(env.repoRoot, "dist", "index.js");
  const nodeExecPath = await resolveQaNodeExecPath();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(nodeExecPath, [distEntryPath, ...args], {
      cwd: env.gateway.tempRoot,
      env: {
        ...env.gateway.runtimeEnv,
        ...opts?.env,
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeoutMs = resolveTimerTimeoutMs(opts?.timeoutMs, 60_000);
    const rejectTimeout = () => {
      const stdoutText = formatQaChildOutputTail(stdoutTail, "qa cli stdout");
      const stderrText = formatQaChildOutputTail(stderr, "qa cli stderr");
      const diagnostics = [
        stdoutText ? `stdout:\n${stdoutText}` : "",
        stderrText ? `stderr:\n${stderrText}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return new QaSuiteInfraError(
        "qa_cli_timeout",
        `qa cli timed out: openclaw ${args.join(" ")}${diagnostics ? `\n${diagnostics}` : ""}`,
      );
    };
    const getExitError = (code: number | null) => {
      if (code === 0) {
        if (stdout.exceeded) {
          return new Error(
            `qa cli stdout exceeded ${QA_CHILD_STDOUT_MAX_BYTES} bytes; refusing to parse truncated output`,
          );
        }
        return undefined;
      }
      const stderrText = formatQaChildOutputTail(stderr, "qa cli stderr");
      return new Error(`qa cli failed (${code ?? "unknown"}): ${stderrText}`);
    };
    if (process.platform !== "win32") {
      createQaPosixCommandSettlement({
        child,
        settlementFailureMessage: "qa cli settlement failed",
        executionTimeoutMs: timeoutMs,
        forceKillAfterMs: 0,
        initialSignal: "SIGKILL",
        onSettled: (outcome) => {
          const primary = outcome.primary;
          const primaryError =
            primary.type === "spawn-error" || primary.type === "stream-error"
              ? primary.error
              : primary.type === "timeout"
                ? rejectTimeout()
                : getExitError(primary.type === "exit" ? primary.exitCode : 1);
          if (outcome.settlementFailure) {
            reject(
              primaryError
                ? new AggregateError(
                    [primaryError, outcome.settlementFailure],
                    "qa cli command and settlement failed",
                  )
                : outcome.settlementFailure,
            );
            return;
          }
          if (primaryError) {
            reject(primaryError);
            return;
          }
          resolve();
        },
        onStderrData: (chunk) => appendQaChildOutputTail(stderr, chunk),
        onStdoutData: (chunk) => {
          appendQaChildOutput(stdout, chunk);
          appendQaChildOutputTail(stdoutTail, chunk);
        },
        processGroupId: child.pid,
        verifyAfterMs: 500,
      });
      return;
    }
    const timeout = setTimeout(() => {
      killQaCliWindowsProcessTree(child);
      reject(rejectTimeout());
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      appendQaChildOutput(stdout, chunk);
      appendQaChildOutputTail(stdoutTail, chunk);
    });
    child.stderr.on("data", (chunk) => appendQaChildOutputTail(stderr, chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const error = getExitError(code);
      return error ? reject(error) : resolve();
    });
  });
  const text = readQaChildOutput(stdout).trim();
  if (!opts?.json) {
    return text;
  }
  return parseQaCliJsonOutput(text, args);
}

export { runQaCli };
