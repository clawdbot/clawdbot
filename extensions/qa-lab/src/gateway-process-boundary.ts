import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PROCESS_BOUNDARY_VERSION = 1;
const PROCESS_BOUNDARY_START_TIMEOUT_MS = 30_000;
const PROCESS_BOUNDARY_CONTROL_TIMEOUT_MS = 10_000;
const PROCESS_BOUNDARY_TERMINATE_TIMEOUT_MS = 45_000;
const PROCESS_BOUNDARY_TERMINATE_RETRY_INTERVAL_MS = 1_000;
export const QA_GATEWAY_PROCESS_BOUNDARY_MIN_QUARANTINE_TTL_MS = 2 * 60 * 60 * 1_000;
export const QA_GATEWAY_PROCESS_BOUNDARY_RETAIN_LEASE_PREFIX = "retain-credential-lease-";

export type QaGatewayLinuxProcessBoundary = {
  kind: "linux-proc-v1";
  evidenceDir: string;
  expectedGid: number;
  expectedUid: number;
  forwardedEnvKeys: readonly string[];
  runtimeArgsPrefix: readonly string[];
  runtimeExecutablePath: string;
  terminationRetryTimeoutMs: number;
};

export type QaGatewayProcessBoundaryConfig = QaGatewayLinuxProcessBoundary;

type QaGatewayProcessCommand = {
  version: 1;
  generation: string;
  executable: string;
  argv: string[];
  cwdRelative: string;
  envKeys: string[];
};

type QaGatewayProcessHandoff = {
  version: 1;
  generation: string;
  pid: number;
  uid: number;
  gid: number;
  procStartTicks: string;
  pgrp: number;
  commandFile: {
    path: string;
    sha256: string;
  };
};

type QaGatewayProcessSandboxProof = {
  version: 1;
  generation: string;
  status: "pass";
  envKeys: string[];
};

type QaGatewayProcessRuntimeProof = {
  version: 1;
  generation: string;
  status: "pass";
  pid: number;
  uid: number;
  gid: number;
  procStartTicks: string;
  pgrp: number;
  state: string;
  cwd: string;
  executablePath: string;
  cmdlineSha256: string;
};

export type QaGatewayVerifiedProcessIdentity = {
  generation: string;
  pid: number;
  procStartTicks: string;
  pgrp: number;
  cwd: string;
  executablePath: string;
  commandSha256: string;
  commandFilePath: string;
  identityFilePath: string;
  sandboxFilePath: string;
  preEntryCmdlineSha256: string;
};

export type QaGatewayProcessBoundaryPreparedSpawn = {
  command: QaGatewayProcessCommand;
  commandBytes: Buffer;
  commandFilePath: string;
  commandSha256: string;
  env: NodeJS.ProcessEnv;
  generation: string;
  identityFilePath: string;
  sandboxFilePath: string;
};

type QaGatewayProcessBoundaryEvidenceLaunch = {
  generation: string;
  pid: number;
  procStartTicks: string;
  pgrp: number;
  executablePath: string;
  preEntryCmdlineSha256: string;
  commandFile: {
    path: string;
    sha256: string;
  };
  identityFile: string;
  sandboxFile: string;
  acceptedAt: string;
  readyAt?: string;
  exitedAt?: string;
  quiescedAt?: string;
  terminalState?: "failed-before-ready" | "ready-exited";
};

type QaGatewayProcStat = {
  pgrp: number;
  startTicks: string;
  state: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function compareStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeEnvKeys(keys: readonly string[]) {
  const normalized = [...new Set(keys)];
  for (const key of normalized) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new Error(`invalid process-boundary environment key: ${key}`);
    }
  }
  return normalized.toSorted();
}

function parsePositiveInteger(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 1) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function parseNonNegativeInteger(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function parseNonEmptyString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function parseSha256(value: unknown, label: string) {
  const digest = parseNonEmptyString(value, label);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`invalid ${label}`);
  }
  return digest;
}

function parseQaGatewayProcessHandoff(value: unknown): QaGatewayProcessHandoff {
  if (!isRecord(value) || value.version !== PROCESS_BOUNDARY_VERSION) {
    throw new Error("invalid process-boundary identity");
  }
  const commandFile = value.commandFile;
  if (!isRecord(commandFile)) {
    throw new Error("invalid process-boundary command file identity");
  }
  return {
    version: PROCESS_BOUNDARY_VERSION,
    generation: parseNonEmptyString(value.generation, "process-boundary generation"),
    pid: parsePositiveInteger(value.pid, "process-boundary pid"),
    uid: parseNonNegativeInteger(value.uid, "process-boundary uid"),
    gid: parseNonNegativeInteger(value.gid, "process-boundary gid"),
    procStartTicks: parseNonEmptyString(
      value.procStartTicks,
      "process-boundary process start ticks",
    ),
    pgrp: parsePositiveInteger(value.pgrp, "process-boundary process group"),
    commandFile: {
      path: parseNonEmptyString(commandFile.path, "process-boundary command path"),
      sha256: parseSha256(commandFile.sha256, "process-boundary command digest"),
    },
  };
}

function parseQaGatewayProcessSandboxProof(value: unknown): QaGatewayProcessSandboxProof {
  if (
    !isRecord(value) ||
    value.version !== PROCESS_BOUNDARY_VERSION ||
    value.status !== "pass" ||
    !Array.isArray(value.envKeys) ||
    !value.envKeys.every((key) => typeof key === "string")
  ) {
    throw new Error("invalid process-boundary sandbox proof");
  }
  return {
    version: PROCESS_BOUNDARY_VERSION,
    generation: parseNonEmptyString(value.generation, "sandbox generation"),
    status: "pass",
    envKeys: normalizeEnvKeys(value.envKeys),
  };
}

function parseQaGatewayProcessRuntimeProof(value: unknown): QaGatewayProcessRuntimeProof {
  if (!isRecord(value) || value.version !== PROCESS_BOUNDARY_VERSION || value.status !== "pass") {
    throw new Error("invalid process-boundary runtime proof");
  }
  const state = parseNonEmptyString(value.state, "runtime state");
  if (!/^[A-Za-z]$/u.test(state)) {
    throw new Error("invalid process-boundary runtime state");
  }
  return {
    version: PROCESS_BOUNDARY_VERSION,
    generation: parseNonEmptyString(value.generation, "runtime generation"),
    status: "pass",
    pid: parsePositiveInteger(value.pid, "runtime pid"),
    uid: parseNonNegativeInteger(value.uid, "runtime uid"),
    gid: parseNonNegativeInteger(value.gid, "runtime gid"),
    procStartTicks: parseNonEmptyString(value.procStartTicks, "runtime process start ticks"),
    pgrp: parsePositiveInteger(value.pgrp, "runtime process group"),
    state,
    cwd: parseNonEmptyString(value.cwd, "runtime cwd"),
    executablePath: parseNonEmptyString(value.executablePath, "runtime executable path"),
    cmdlineSha256: parseSha256(value.cmdlineSha256, "runtime command line digest"),
  };
}

export function parseQaGatewayProcStat(raw: string): QaGatewayProcStat {
  const closeParen = raw.lastIndexOf(")");
  if (closeParen < 0) {
    throw new Error("invalid /proc stat command name");
  }
  const fields = raw
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/u);
  if (fields.length < 20) {
    throw new Error("invalid /proc stat field count");
  }
  const state = fields[0];
  const pgrpText = fields[2];
  const startTicks = fields[19];
  if (!state || !pgrpText || !startTicks) {
    throw new Error("invalid /proc stat process identity");
  }
  const pgrp = Number(pgrpText);
  if (!Number.isSafeInteger(pgrp) || pgrp <= 1 || !/^[0-9]+$/.test(startTicks)) {
    throw new Error("invalid /proc stat process identity");
  }
  return {
    state,
    pgrp,
    startTicks,
  };
}

async function assertContainedPath(root: string, target: string, label: string) {
  const rootPath = await fs.realpath(root);
  const targetPath = await fs.realpath(target);
  const relative = path.relative(rootPath, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escaped its trusted root`);
  }
  return targetPath;
}

async function assertRegularFile(params: {
  pathName: string;
  root: string;
  mode: number;
  label: string;
}) {
  const stats = await fs.lstat(params.pathName);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== params.mode) {
    throw new Error(`${params.label} is not a regular mode ${params.mode.toString(8)} file`);
  }
  return await assertContainedPath(params.root, params.pathName, params.label);
}

async function writeAtomicFile(pathName: string, contents: Buffer | string, mode: number) {
  const temporaryPath = `${pathName}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await fs.open(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    mode,
  );
  let closed = false;
  try {
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    closed = true;
    await fs.rename(temporaryPath, pathName);
  } finally {
    if (!closed) {
      await handle.close().catch(() => {});
    }
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function readJsonFile(pathName: string) {
  return JSON.parse(await fs.readFile(pathName, "utf8")) as unknown;
}

async function waitForJsonFile(params: {
  child: ChildProcess;
  pathName: string;
  timeoutMs?: number;
}) {
  const deadline = Date.now() + (params.timeoutMs ?? PROCESS_BOUNDARY_START_TIMEOUT_MS);
  let lastError: unknown;
  while (Date.now() <= deadline) {
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      throw new Error("process-boundary launcher exited before writing its identity");
    }
    try {
      return await readJsonFile(params.pathName);
    } catch (error) {
      lastError = error;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for process-boundary identity: ${String(lastError)}`);
}

async function runBoundaryLauncherCommand(params: {
  args: readonly string[];
  label: string;
  launcherPath: string;
  timeoutMs: number;
}) {
  const child = spawn(params.launcherPath, params.args, {
    env: {
      HOME: process.env.HOME,
      LANG: process.env.LANG ?? "C.UTF-8",
      PATH: process.env.PATH,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process-boundary ${params.label} proxy timed out`));
    }, params.timeoutMs);
  });
  let exitCode: number;
  try {
    exitCode = await Promise.race([
      new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
  if (exitCode !== 0) {
    throw new Error(
      `process-boundary ${params.label} proxy exited ${exitCode}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
    );
  }
  return Buffer.concat(stdout).toString("utf8");
}

async function runBoundaryVerification(params: {
  launcherPath: string;
  identityFilePath: string;
  mode: "preentry" | "live";
}) {
  const output = await runBoundaryLauncherCommand({
    args: ["--verify", params.mode, params.identityFilePath],
    label: `${params.mode} verification`,
    launcherPath: params.launcherPath,
    timeoutMs: PROCESS_BOUNDARY_START_TIMEOUT_MS,
  });
  return parseQaGatewayProcessRuntimeProof(JSON.parse(output) as unknown);
}

async function runBoundaryControl(params: {
  launcherPath: string;
  identityFilePath: string;
  signal: "SIGCONT" | "SIGUSR1" | "SIGUSR2";
}) {
  await runBoundaryLauncherCommand({
    args: ["--signal", params.signal, params.identityFilePath],
    label: "signal",
    launcherPath: params.launcherPath,
    timeoutMs: PROCESS_BOUNDARY_CONTROL_TIMEOUT_MS,
  });
}

async function runBoundaryTermination(params: { launcherPath: string; identityFilePath: string }) {
  await runBoundaryLauncherCommand({
    args: ["--terminate", params.identityFilePath],
    label: "termination",
    launcherPath: params.launcherPath,
    timeoutMs: PROCESS_BOUNDARY_TERMINATE_TIMEOUT_MS,
  });
}

async function runBoundaryUidTermination(launcherPath: string) {
  await runBoundaryLauncherCommand({
    args: ["--terminate-uid"],
    label: "UID termination",
    launcherPath,
    timeoutMs: PROCESS_BOUNDARY_TERMINATE_TIMEOUT_MS,
  });
}

function commandLineBytes(executable: string, argv: readonly string[]) {
  return Buffer.from(`${[executable, ...argv].join("\0")}\0`);
}

async function copyBoundaryEvidenceFile(params: {
  evidenceDir: string;
  generation: string;
  sourcePath: string;
  targetName: string;
}) {
  const launchDir = path.join(params.evidenceDir, `launch-${params.generation}`);
  await fs.mkdir(launchDir, { recursive: true, mode: 0o700 });
  const targetPath = path.join(launchDir, params.targetName);
  await fs.copyFile(params.sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
  await fs.chmod(targetPath, 0o600);
  return path.relative(params.evidenceDir, targetPath);
}

export async function createQaGatewayProcessBoundaryController(params: {
  config: QaGatewayProcessBoundaryConfig;
  launcherPath: string;
  tempRoot: string;
}) {
  if (process.platform !== "linux") {
    throw new Error("verified QA gateway process boundaries require Linux");
  }
  const tempRoot = await fs.realpath(params.tempRoot);
  const controlDir = path.join(tempRoot, "process-boundary");
  await fs.mkdir(controlDir, { recursive: true, mode: 0o700 });
  const evidenceDir = await fs.realpath(params.config.evidenceDir);
  const evidenceStats = await fs.lstat(evidenceDir);
  if (!evidenceStats.isDirectory() || evidenceStats.isSymbolicLink()) {
    throw new Error("process-boundary evidence path is not a trusted directory");
  }
  const forwardedEnvKeys = normalizeEnvKeys(params.config.forwardedEnvKeys);
  const controllerId = randomUUID();
  const evidencePath = path.join(evidenceDir, `runtime-boundary-${randomUUID()}.json`);
  const retainCredentialLeasePath = path.join(
    evidenceDir,
    `${QA_GATEWAY_PROCESS_BOUNDARY_RETAIN_LEASE_PREFIX}${controllerId}.json`,
  );
  const launches: QaGatewayProcessBoundaryEvidenceLaunch[] = [];
  if (
    !Number.isSafeInteger(params.config.terminationRetryTimeoutMs) ||
    params.config.terminationRetryTimeoutMs < PROCESS_BOUNDARY_TERMINATE_TIMEOUT_MS
  ) {
    throw new Error("invalid process-boundary termination retry timeout");
  }

  const writeEvidence = async () => {
    await writeAtomicFile(
      evidencePath,
      `${JSON.stringify(
        {
          version: PROCESS_BOUNDARY_VERSION,
          kind: "qa-gateway-process-boundary",
          launches,
        },
        null,
        2,
      )}\n`,
      0o600,
    );
  };

  const findLaunch = (generation: string) => {
    const launch = launches.find((candidate) => candidate.generation === generation);
    if (!launch) {
      throw new Error(`unknown process-boundary generation: ${generation}`);
    }
    return launch;
  };

  const retainCredentialLease = async () => {
    await writeAtomicFile(
      retainCredentialLeasePath,
      `${JSON.stringify({
        version: PROCESS_BOUNDARY_VERSION,
        kind: "qa-gateway-process-boundary-retain-credential-lease",
        recordedAt: new Date().toISOString(),
      })}\n`,
      0o600,
    );
  };

  const clearCredentialLeaseRetention = async () => {
    await fs.rm(retainCredentialLeasePath, { force: true });
  };

  const terminateUidUntilQuiescent = async () => {
    for (;;) {
      try {
        await runBoundaryUidTermination(params.launcherPath);
        return;
      } catch {
        await sleep(PROCESS_BOUNDARY_TERMINATE_RETRY_INTERVAL_MS);
      }
    }
  };

  const terminateWithRetry = async (identityFilePath: string) => {
    const deadline = Date.now() + params.config.terminationRetryTimeoutMs;
    let lastError: unknown;
    while (Date.now() <= deadline) {
      try {
        await runBoundaryTermination({
          launcherPath: params.launcherPath,
          identityFilePath,
        });
        return undefined;
      } catch (error) {
        lastError = error;
      }
      await sleep(
        Math.min(PROCESS_BOUNDARY_TERMINATE_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now())),
      );
    }
    await terminateUidUntilQuiescent();
    return {
      identityVerified: false as const,
      error: new Error("process-boundary cleanup used the isolated UID fallback", {
        cause: lastError,
      }),
    };
  };

  const prepare = async (spawnParams: {
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): Promise<QaGatewayProcessBoundaryPreparedSpawn> => {
    const cwd = await fs.realpath(spawnParams.cwd);
    const cwdRelative = path.relative(tempRoot, cwd) || ".";
    if (cwdRelative.startsWith("..") || path.isAbsolute(cwdRelative)) {
      throw new Error("process-boundary runtime cwd escaped the gateway temp root");
    }
    const generation = randomUUID();
    const commandFilePath = path.join(controlDir, `command-${generation}.json`);
    const identityFilePath = path.join(controlDir, `identity-${generation}.json`);
    const sandboxFilePath = path.join(controlDir, `sandbox-${generation}.json`);
    const envKeys = normalizeEnvKeys([
      ...forwardedEnvKeys.filter((key) => spawnParams.env[key] !== undefined),
      "OPENCLAW_QA_SUT_PREENTRY_STOP",
    ]);
    const command: QaGatewayProcessCommand = {
      version: PROCESS_BOUNDARY_VERSION,
      generation,
      executable: params.config.runtimeExecutablePath,
      argv: [...params.config.runtimeArgsPrefix, ...spawnParams.args],
      cwdRelative,
      envKeys,
    };
    const commandBytes = Buffer.from(`${JSON.stringify(command)}\n`);
    const commandSha256 = sha256(commandBytes);
    await writeAtomicFile(commandFilePath, commandBytes, 0o600);
    await retainCredentialLease();
    return {
      command,
      commandBytes,
      commandFilePath,
      commandSha256,
      env: {
        ...spawnParams.env,
        OPENCLAW_QA_SUT_BOUNDARY_COMMAND_FILE: commandFilePath,
        OPENCLAW_QA_SUT_BOUNDARY_COMMAND_SHA256: commandSha256,
        OPENCLAW_QA_SUT_BOUNDARY_GENERATION: generation,
        OPENCLAW_QA_SUT_BOUNDARY_IDENTITY_FILE: identityFilePath,
        OPENCLAW_QA_SUT_BOUNDARY_SANDBOX_FILE: sandboxFilePath,
      },
      generation,
      identityFilePath,
      sandboxFilePath,
    };
  };

  const accept = async (acceptParams: {
    child: ChildProcess;
    prepared: QaGatewayProcessBoundaryPreparedSpawn;
  }): Promise<QaGatewayVerifiedProcessIdentity> => {
    const launcherPid = acceptParams.child.pid;
    if (!launcherPid || launcherPid <= 1) {
      throw new Error("process-boundary launcher has no valid pid");
    }
    const handoff = parseQaGatewayProcessHandoff(
      await waitForJsonFile({
        child: acceptParams.child,
        pathName: acceptParams.prepared.identityFilePath,
      }),
    );
    const sandbox = parseQaGatewayProcessSandboxProof(
      await waitForJsonFile({
        child: acceptParams.child,
        pathName: acceptParams.prepared.sandboxFilePath,
      }),
    );
    if (
      handoff.generation !== acceptParams.prepared.generation ||
      sandbox.generation !== acceptParams.prepared.generation
    ) {
      throw new Error("process-boundary generation mismatch");
    }
    if (handoff.uid !== params.config.expectedUid || handoff.gid !== params.config.expectedGid) {
      throw new Error("process-boundary runtime uid/gid mismatch");
    }
    if (handoff.pgrp !== launcherPid) {
      throw new Error("process-boundary runtime escaped the launcher process group");
    }
    const commandPath = await assertRegularFile({
      pathName: acceptParams.prepared.commandFilePath,
      root: controlDir,
      mode: 0o600,
      label: "process-boundary command file",
    });
    await assertRegularFile({
      pathName: acceptParams.prepared.identityFilePath,
      root: controlDir,
      mode: 0o640,
      label: "process-boundary identity file",
    });
    await assertRegularFile({
      pathName: acceptParams.prepared.sandboxFilePath,
      root: controlDir,
      mode: 0o640,
      label: "process-boundary sandbox proof",
    });
    if (
      handoff.commandFile.path !== commandPath ||
      handoff.commandFile.sha256 !== acceptParams.prepared.commandSha256 ||
      sha256(await fs.readFile(commandPath)) !== acceptParams.prepared.commandSha256
    ) {
      throw new Error("process-boundary command digest mismatch");
    }
    if (!compareStrings(sandbox.envKeys, acceptParams.prepared.command.envKeys)) {
      throw new Error("process-boundary runtime environment mismatch");
    }

    const runtimeProof = await runBoundaryVerification({
      launcherPath: params.launcherPath,
      identityFilePath: acceptParams.prepared.identityFilePath,
      mode: "preentry",
    });
    const expectedCwd = path.resolve(tempRoot, acceptParams.prepared.command.cwdRelative);
    const expectedExecutablePath = await fs.realpath(acceptParams.prepared.command.executable);
    const expectedCmdlineSha256 = sha256(
      commandLineBytes(
        acceptParams.prepared.command.executable,
        acceptParams.prepared.command.argv,
      ),
    );
    if (
      runtimeProof.generation !== handoff.generation ||
      runtimeProof.pid !== handoff.pid ||
      runtimeProof.uid !== handoff.uid ||
      runtimeProof.gid !== handoff.gid ||
      runtimeProof.procStartTicks !== handoff.procStartTicks ||
      runtimeProof.pgrp !== handoff.pgrp ||
      (runtimeProof.state !== "T" && runtimeProof.state !== "t")
    ) {
      throw new Error("process-boundary root verification changed runtime identity");
    }
    if (
      runtimeProof.cwd !== expectedCwd ||
      runtimeProof.executablePath !== expectedExecutablePath ||
      runtimeProof.cmdlineSha256 !== expectedCmdlineSha256
    ) {
      throw new Error("process-boundary root verification changed runtime command");
    }
    const preEntryCmdlineSha256 = runtimeProof.cmdlineSha256;

    const evidenceCommandFile = await copyBoundaryEvidenceFile({
      evidenceDir,
      generation: handoff.generation,
      sourcePath: acceptParams.prepared.commandFilePath,
      targetName: "command.json",
    });
    const evidenceIdentityFile = await copyBoundaryEvidenceFile({
      evidenceDir,
      generation: handoff.generation,
      sourcePath: acceptParams.prepared.identityFilePath,
      targetName: "identity.json",
    });
    const evidenceSandboxFile = await copyBoundaryEvidenceFile({
      evidenceDir,
      generation: handoff.generation,
      sourcePath: acceptParams.prepared.sandboxFilePath,
      targetName: "sandbox.json",
    });
    launches.push({
      generation: handoff.generation,
      pid: handoff.pid,
      procStartTicks: handoff.procStartTicks,
      pgrp: handoff.pgrp,
      executablePath: expectedExecutablePath,
      preEntryCmdlineSha256,
      commandFile: {
        path: evidenceCommandFile,
        sha256: acceptParams.prepared.commandSha256,
      },
      identityFile: evidenceIdentityFile,
      sandboxFile: evidenceSandboxFile,
      acceptedAt: new Date().toISOString(),
    });
    await writeEvidence();
    return {
      generation: handoff.generation,
      pid: handoff.pid,
      procStartTicks: handoff.procStartTicks,
      pgrp: handoff.pgrp,
      cwd: expectedCwd,
      executablePath: expectedExecutablePath,
      commandSha256: acceptParams.prepared.commandSha256,
      commandFilePath: acceptParams.prepared.commandFilePath,
      identityFilePath: acceptParams.prepared.identityFilePath,
      sandboxFilePath: acceptParams.prepared.sandboxFilePath,
      preEntryCmdlineSha256,
    };
  };

  const abort = async (abortParams: {
    child: ChildProcess;
    prepared: QaGatewayProcessBoundaryPreparedSpawn;
  }) => {
    try {
      const handoff = parseQaGatewayProcessHandoff(
        await waitForJsonFile({
          child: abortParams.child,
          pathName: abortParams.prepared.identityFilePath,
        }),
      );
      if (handoff.generation !== abortParams.prepared.generation) {
        throw new Error("process-boundary abort generation mismatch");
      }
      const termination = await terminateWithRetry(abortParams.prepared.identityFilePath);
      await clearCredentialLeaseRetention();
      if (termination && !termination.identityVerified) {
        throw termination.error;
      }
    } catch (error) {
      await terminateUidUntilQuiescent();
      // The unique SUT UID is the terminal isolation boundary. The fallback only
      // returns after repeated empty UID probes, so lease quarantine can end.
      await clearCredentialLeaseRetention();
      throw error;
    }
  };

  const signal = async (
    identity: QaGatewayVerifiedProcessIdentity,
    signalName: "SIGCONT" | "SIGUSR1" | "SIGUSR2",
  ) => {
    await runBoundaryControl({
      launcherPath: params.launcherPath,
      identityFilePath: identity.identityFilePath,
      signal: signalName,
    });
  };

  const markReady = async (identity: QaGatewayVerifiedProcessIdentity) => {
    const runtimeProof = await runBoundaryVerification({
      launcherPath: params.launcherPath,
      identityFilePath: identity.identityFilePath,
      mode: "live",
    });
    // The SUT invokes dist/index.js through the gateway fast path, which preserves
    // argv. A changed digest means it exec'd or retitled before readiness.
    if (
      runtimeProof.generation !== identity.generation ||
      runtimeProof.pid !== identity.pid ||
      runtimeProof.uid !== params.config.expectedUid ||
      runtimeProof.gid !== params.config.expectedGid ||
      runtimeProof.procStartTicks !== identity.procStartTicks ||
      runtimeProof.pgrp !== identity.pgrp ||
      runtimeProof.cwd !== identity.cwd ||
      runtimeProof.executablePath !== identity.executablePath ||
      runtimeProof.cmdlineSha256 !== identity.preEntryCmdlineSha256
    ) {
      throw new Error("process-boundary runtime identity changed before readiness");
    }
    findLaunch(identity.generation).readyAt = new Date().toISOString();
    await writeEvidence();
  };

  const markExited = async (identity: QaGatewayVerifiedProcessIdentity) => {
    const termination = await terminateWithRetry(identity.identityFilePath);
    if (termination && !termination.identityVerified) {
      // Identity evidence degraded, but the unique SUT UID reached verified
      // quiescence before this fallback result was returned.
      await clearCredentialLeaseRetention();
      throw termination.error;
    }
    const launch = findLaunch(identity.generation);
    launch.exitedAt = new Date().toISOString();
    launch.quiescedAt = launch.exitedAt;
    launch.terminalState = launch.readyAt ? "ready-exited" : "failed-before-ready";
    await writeEvidence();
    await clearCredentialLeaseRetention();
  };

  return {
    prepare,
    accept,
    abort,
    signal,
    markReady,
    markExited,
    evidencePath,
    retainCredentialLeasePath,
    retainCredentialLease,
  };
}

export function assertQaGatewayCredentialLeaseQuarantine(
  lease: { leaseTtlMs: number; source: string },
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!env.OPENCLAW_QA_TELEGRAM_SUT_PROCESS_BOUNDARY_DIR?.trim() || lease.source !== "convex") {
    return;
  }
  if (lease.leaseTtlMs < QA_GATEWAY_PROCESS_BOUNDARY_MIN_QUARANTINE_TTL_MS) {
    throw new Error(
      `verified Telegram SUT isolation requires a credential lease TTL of at least ${QA_GATEWAY_PROCESS_BOUNDARY_MIN_QUARANTINE_TTL_MS}ms`,
    );
  }
}

export async function shouldRetainQaGatewayCredentialLease(env: NodeJS.ProcessEnv = process.env) {
  const evidenceDir = env.OPENCLAW_QA_TELEGRAM_SUT_PROCESS_BOUNDARY_DIR?.trim();
  if (!evidenceDir || !path.isAbsolute(evidenceDir)) {
    return false;
  }
  try {
    const markerNames = (await fs.readdir(evidenceDir)).filter(
      (name) =>
        name.startsWith(QA_GATEWAY_PROCESS_BOUNDARY_RETAIN_LEASE_PREFIX) && name.endsWith(".json"),
    );
    for (const markerName of markerNames) {
      const stats = await fs.lstat(path.join(evidenceDir, markerName));
      if (stats.isFile() && !stats.isSymbolicLink()) {
        return true;
      }
    }
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    return true;
  }
}

const testing = {
  commandLineBytes,
  normalizeEnvKeys,
  parseQaGatewayProcessHandoff,
  parseQaGatewayProcessRuntimeProof,
  parseQaGatewayProcessSandboxProof,
  parseQaGatewayProcStat,
};

export { testing as __testing };
