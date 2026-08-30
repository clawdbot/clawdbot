// Qa Lab plugin module owns gateway child command bootstrap behavior.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  appendQaChildOutput,
  appendQaChildOutputTail,
  createQaChildOutputCapture,
  createQaChildOutputTail,
  formatQaChildOutputTail,
  readQaChildOutput,
} from "./child-output.js";
import type { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import { monitorQaChildFailure } from "./gateway-child-process.js";
import { createQaGatewayCliError } from "./gateway-log-redaction.js";
import type { QaGatewayProcessBoundaryConfig } from "./gateway-process-boundary.js";

type QaGatewayChildDirectCommand = {
  executablePath: string;
  argsPrefix?: string[];
  argsSuffix?: string[];
  cwd?: string;
  tempParentDir?: string;
  usePackagedPlugins?: boolean;
  processBoundary?: undefined;
};

const QA_GATEWAY_CLI_EXECUTION_TIMEOUT_MS = 120_000;
const QA_GATEWAY_CLI_DRAIN_TIMEOUT_MS = 1_000;

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
  lifetime: QaGatewayChildLifecycle;
  executablePath: string;
  argsPrefix: readonly string[];
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
}): Promise<string> {
  params.lifetime.assertOpen();
  const hasStdin = params.stdin !== undefined;
  const child = spawn(params.executablePath, [...params.argsPrefix, ...params.args], {
    cwd: params.cwd,
    env: { ...params.env, OPENCLAW_CLI: "1" },
    detached: process.platform !== "win32",
    stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
  // Admission, spawn, and registration share one synchronous turn, before any
  // stdin or process events can race a stop request.
  const owned = params.lifetime.register(child, null, "cli");
  const result = readQaGatewayCliCommand(child, params.lifetime, owned);
  params.lifetime.completeCli(owned, result);
  if (hasStdin) {
    child.stdin?.end(params.stdin);
  }
  return await result;
}

async function readQaGatewayCliCommand(
  child: ChildProcess,
  lifetime: QaGatewayChildLifecycle,
  owned: ReturnType<QaGatewayChildLifecycle["register"]>,
): Promise<string> {
  const stdout = createQaChildOutputCapture();
  const stderr = createQaChildOutputTail();
  child.stdout?.on("data", (chunk) => appendQaChildOutput(stdout, chunk));
  child.stderr?.on("data", (chunk) => appendQaChildOutputTail(stderr, chunk));
  let failure: Error | undefined;
  let finish!: (code: number | undefined) => void;
  const terminal = new Promise<number | undefined>((resolve) => {
    finish = resolve;
  });
  const fail = (error: unknown) => {
    failure ??= createQaGatewayCliError(error);
    finish(undefined);
  };
  monitorQaChildFailure(child, ({ source, error }) => {
    fail(`qa gateway cli ${source} failed: ${createQaGatewayCliError(error).message}`);
  });
  child.stdin?.once("error", (error) =>
    fail(`qa gateway cli stdin failed: ${createQaGatewayCliError(error).message}`),
  );
  child.once("exit", (code) => finish(code ?? 1));
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  const onAbort = () => fail("qa gateway CLI cancelled: lifecycle is closed");
  lifetime.signal.addEventListener("abort", onAbort, { once: true });
  const executionTimer = setTimeout(
    () => fail(`qa gateway CLI exceeded ${QA_GATEWAY_CLI_EXECUTION_TIMEOUT_MS}ms`),
    QA_GATEWAY_CLI_EXECUTION_TIMEOUT_MS,
  );
  let drainTimer: NodeJS.Timeout | undefined;
  let exitCode: number | undefined;
  let stopped: Awaited<ReturnType<QaGatewayChildLifecycle["stopProcess"]>>;
  try {
    exitCode = await terminal;
    clearTimeout(executionTimer);
    // Leader exit is not group settlement or pipe closure. Settle the owned tree
    // even after success/errors; never wait for close after unconfirmed shutdown.
    stopped = await lifetime.stopProcess(owned);
    if (stopped.process !== "unconfirmed") {
      await Promise.race([
        closed,
        new Promise<void>((resolve) => {
          drainTimer = setTimeout(() => {
            fail("qa gateway CLI stdio did not close after process-tree shutdown");
            resolve();
          }, QA_GATEWAY_CLI_DRAIN_TIMEOUT_MS);
        }),
      ]);
    }
  } finally {
    clearTimeout(executionTimer);
    clearTimeout(drainTimer);
    lifetime.signal.removeEventListener("abort", onAbort);
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  const stdoutText = readQaChildOutput(stdout);
  if (exitCode !== 0 && !failure) {
    const stderrText = formatQaChildOutputTail(stderr, "stderr");
    failure = createQaGatewayCliError(
      `OpenClaw CLI exited ${exitCode}: ${stderrText || stdoutText}`,
    );
  }
  if (stopped.errors.length) {
    throw new AggregateError(
      failure ? [failure, ...stopped.errors] : stopped.errors,
      failure?.message ?? "qa gateway CLI cleanup failed",
      { cause: failure },
    );
  }
  if (failure) {
    throw failure;
  }
  lifetime.assertOpen();
  return stdoutText;
}
