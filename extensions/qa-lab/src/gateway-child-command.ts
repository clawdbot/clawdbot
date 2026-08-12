// Qa Lab plugin module owns gateway child command bootstrap behavior.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { formatErrorMessage, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  appendQaChildOutput,
  appendQaChildOutputTail,
  createQaChildOutputCapture,
  createQaChildOutputTail,
  formatQaChildOutputTail,
  readQaChildOutput,
} from "./child-output.js";
import { hasQaGatewayChildExited, monitorQaChildFailure } from "./gateway-child-process.js";
import { redactQaGatewayDebugText } from "./gateway-log-redaction.js";
import type { QaGatewayProcessBoundaryConfig } from "./gateway-process-boundary.js";
import { buildQaMockProfileId } from "./providers/shared/mock-auth.js";

const QA_PACKAGE_AUTH_FAILURE_MAX_CHARS = 2_048;

type QaGatewayChildDirectCommand = {
  executablePath: string;
  argsPrefix?: string[];
  argsSuffix?: string[];
  cwd?: string;
  tempParentDir?: string;
  usePackagedPlugins?: boolean;
  processBoundary?: undefined;
};

type QaGatewayChildVerifiedCommand = Omit<QaGatewayChildDirectCommand, "processBoundary"> & {
  processBoundary: QaGatewayProcessBoundaryConfig;
};

export type QaGatewayChildCommand = QaGatewayChildDirectCommand | QaGatewayChildVerifiedCommand;

export function resolveQaGatewayChildCommand(repoRoot: string): QaGatewayChildCommand {
  for (const relativePath of ["scripts/run-node.mjs", "dist/index.mjs", "dist/index.js"]) {
    const entryPath = path.join(repoRoot, relativePath);
    if (existsSync(entryPath)) {
      return {
        executablePath: process.execPath,
        argsPrefix: [entryPath],
        cwd: repoRoot,
        usePackagedPlugins: true,
      };
    }
  }

  throw new Error(
    "OpenClaw CLI entry not found: expected scripts/run-node.mjs or dist/index.(m)js",
  );
}

export async function runQaGatewayCliCommand(params: {
  executablePath: string;
  argsPrefix: readonly string[];
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
}): Promise<string> {
  const hasStdin = params.stdin !== undefined;
  const child = spawn(params.executablePath, [...params.argsPrefix, ...params.args], {
    cwd: params.cwd,
    env: { ...params.env, OPENCLAW_CLI: "1" },
    stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const result = readQaGatewayCliCommand(child);
  if (hasStdin) {
    child.stdin?.once("error", () => {});
    child.stdin?.end(params.stdin);
  }
  return await result;
}

function createQaPackagedMockApiKey(): string {
  const prefix = ["s", "k"].join("");
  return `${prefix}-${["qa", "mock", randomUUID().replaceAll("-", "")].join("-")}`;
}

export async function stageQaPackagedMockAuthProfiles(params: {
  command: QaGatewayChildCommand;
  cwd: string;
  env: NodeJS.ProcessEnv;
  providers: readonly string[];
}): Promise<void> {
  for (const provider of uniqueStrings(params.providers)) {
    try {
      await runQaGatewayCliCommand({
        executablePath: params.command.executablePath,
        argsPrefix: params.command.argsPrefix ?? [],
        args: [
          "models",
          "auth",
          "--agent",
          "qa",
          "paste-api-key",
          "--provider",
          provider,
          "--profile-id",
          buildQaMockProfileId(provider),
        ],
        cwd: params.command.cwd ?? params.cwd,
        env: params.env,
        stdin: `${createQaPackagedMockApiKey()}\n`,
      });
    } catch (error) {
      const errorMessage = toErrorObject(error, "installed package auth command failed").message;
      const details = sliceUtf16Safe(
        redactQaGatewayDebugText(errorMessage),
        0,
        QA_PACKAGE_AUTH_FAILURE_MAX_CHARS,
      );
      // oxlint-disable-next-line preserve-caught-error -- Candidate CLI errors can contain the submitted API key; only the redacted message crosses this boundary.
      throw new Error(`installed package mock auth bootstrap failed for ${provider}: ${details}`);
    }
  }
}

async function readQaGatewayCliCommand(child: ChildProcess): Promise<string> {
  const stdout = createQaChildOutputCapture();
  const stderr = createQaChildOutputTail();
  child.stdout?.on("data", (chunk) => appendQaChildOutput(stdout, chunk));
  child.stderr?.on("data", (chunk) => appendQaChildOutputTail(stderr, chunk));
  const exitCode = await new Promise<number>((resolve, reject) => {
    monitorQaChildFailure(child, (failure) => {
      if (failure.source === "process") {
        reject(toErrorObject(failure.error, "OpenClaw CLI process failed"));
        return;
      }
      if (!hasQaGatewayChildExited(child) && !child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child exited between the state check and signal.
        }
      }
      reject(
        new Error(
          `qa gateway cli ${failure.source} stream failed: ${formatErrorMessage(failure.error)}`,
          { cause: failure.error },
        ),
      );
    });
    child.once("close", (code) => resolve(code ?? 1));
  });
  const stdoutText = readQaChildOutput(stdout);
  if (exitCode !== 0) {
    const stderrText = formatQaChildOutputTail(stderr, "stderr");
    throw new Error(`OpenClaw CLI exited ${exitCode}: ${stderrText || stdoutText}`);
  }
  return stdoutText;
}
