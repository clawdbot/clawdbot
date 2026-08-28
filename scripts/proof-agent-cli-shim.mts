#!/usr/bin/env node
// Runs the generated Gateway agent CLI shim from an external working directory.
// Usage: node --import ./scripts/tsx.mjs scripts/proof-agent-cli-shim.mts
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(process.env.OPENCLAW_SHIM_REPO ?? process.cwd());
const importSource = async (relativePath: string) =>
  import(pathToFileURL(path.join(repoRoot, relativePath)).href);
const { prepareGatewayAgentCliShim, clearGatewayAgentCliShim } = await importSource(
  "src/infra/openclaw-cli-shim.ts",
);
const { resolveCurrentOpenClawCliInvocation } = await importSource(
  "src/infra/openclaw-cli-invocation.ts",
);

type ShimResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function runShim(shimPath: string, cwd: string, env: NodeJS.ProcessEnv): Promise<ShimResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(shimPath, [], {
      cwd,
      env,
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const outsideCwdPath = await mkdtemp(path.join(os.tmpdir(), "openclaw-agent-cli-proof-cwd-"));
const outsideCwd = await realpath(outsideCwdPath);
const stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-agent-cli-proof-state-"));
const negativeStateDir = await mkdtemp(
  path.join(os.tmpdir(), "openclaw-agent-cli-proof-negative-state-"),
);
const entryPath = path.join(stateDir, "gateway-entry.ts");

try {
  await writeFile(
    entryPath,
    'import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";\n' +
      'console.log(JSON.stringify({ cwd: process.cwd(), source: normalizeUniqueStringEntries(["gateway"])[0] }));\n',
  );

  const sourceEntry = path.join(repoRoot, "src", "entry.ts");
  const sourceInvocation = resolveCurrentOpenClawCliInvocation([], {
    argv1: sourceEntry,
    cwd: repoRoot,
    execArgv: process.execArgv,
    execPath: process.execPath,
  });
  if (!sourceInvocation.tsxConfigPath) {
    throw new Error("source-mode invocation did not carry tsxConfigPath");
  }
  const invocation = {
    ...sourceInvocation,
    args: sourceInvocation.args.map((arg) => (arg === sourceEntry ? entryPath : arg)),
  };
  await prepareGatewayAgentCliShim({ env: {}, invocation, stateDir });

  const childEnv = { ...process.env };
  delete childEnv.TSX_TSCONFIG_PATH;
  const shimName = process.platform === "win32" ? "openclaw.cmd" : "openclaw";
  const positive = await runShim(path.join(stateDir, "tmp", "agent-cli", shimName), outsideCwd, {
    ...childEnv,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
  });
  const positiveOutput = JSON.parse(positive.stdout.trim()) as {
    cwd?: string;
    source?: string;
  };

  const negativeInvocation = { ...invocation, tsxConfigPath: undefined };
  await prepareGatewayAgentCliShim({
    env: {},
    invocation: negativeInvocation,
    stateDir: negativeStateDir,
  });
  const negative = await runShim(
    path.join(negativeStateDir, "tmp", "agent-cli", shimName),
    outsideCwd,
    {
      ...childEnv,
      OPENCLAW_STATE_DIR: negativeStateDir,
    },
  );
  const negativeImportFailure =
    negative.stderr.includes("ERR_MODULE_NOT_FOUND") ||
    negative.stderr.includes("Cannot find module '@openclaw/normalization-core");

  if (
    positive.code !== 0 ||
    positiveOutput.cwd !== outsideCwd ||
    positiveOutput.source !== "gateway" ||
    negative.code === 0 ||
    !negativeImportFailure
  ) {
    throw new Error(
      `proof failed: positive=${positive.code}/${positiveOutput.cwd}/${positiveOutput.source} ` +
        `negative=${negative.code}/${negativeImportFailure}`,
    );
  }

  console.log(`openclaw-cli-shim-live-proof: pass (${process.platform})`);
  console.log("positive: exit=0 cwd=<outside-temp> source=gateway");
  console.log("negative: exit=1 missing-package=true");
} finally {
  clearGatewayAgentCliShim();
  await Promise.all([
    rm(outsideCwdPath, { recursive: true, force: true }),
    rm(stateDir, { recursive: true, force: true }),
    rm(negativeStateDir, { recursive: true, force: true }),
  ]);
}
