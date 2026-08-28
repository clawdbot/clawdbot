#!/usr/bin/env -S node --import tsx

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { coerceErrorMessage } from "../lib/error-format.mts";
import { sleep } from "../lib/sleep.mjs";
import { telegramBotApi } from "./telegram-bot-api.ts";
import {
  RECORDER_AUTHORIZATION_FAILURE_FILENAME,
  recorderAuthorizationFailureSchema,
  recorderAuthorizationFailureFactSchema,
  type RecorderAuthorizationFailure,
} from "./telegram-desktop-recorder-contract.ts";
import {
  destroyMantisSut,
  execMantisSut,
  type MantisSutRecovery,
  preserveMantisSutRuntimeArtifacts,
  readMantisLifecycleEvidence,
  readReadyMantisLifecycleGeneration,
  runMantisSutLifecycleAction,
  startMantisSut,
  stopMantisSut,
} from "./telegram-mantis-sut.ts";

const execFileAsync = promisify(execFile);
const MAX_MOCK_DELAY_MS = 15 * 60_000;
const laneSchema = z.enum(["baseline", "candidate"]);
const configSchema = z.object({
  configPatch: z.record(z.string(), z.unknown()).optional(),
  mockResponse: z.string().min(1).max(100_000),
  mockResponseChunkDelayMs: z.number().int().positive().max(MAX_MOCK_DELAY_MS).optional(),
});
const mockFailureSchema = z
  .object({
    mode: z.literal("drop").optional(),
    status: z.number().int().min(400).max(599).optional(),
  })
  .superRefine((value, context) => {
    if (value.mode === "drop" && value.status !== undefined) {
      context.addIssue({ code: "custom", message: "fail cannot combine status and drop" });
    }
  });
const mockControlEntrySchema = z.object({
  chunkDelayMs: z.number().int().min(0).max(MAX_MOCK_DELAY_MS).optional(),
  events: z.array(z.record(z.string(), z.unknown())).min(1).optional(),
  fail: mockFailureSchema.optional(),
  text: z.string().min(1).max(100_000).optional(),
});
const mockResponseControlSchema = z.object({
  chunkDelayMs: z.number().int().min(0).max(MAX_MOCK_DELAY_MS).optional(),
  default: mockControlEntrySchema.optional(),
  events: z.array(z.record(z.string(), z.unknown())).min(1).optional(),
  hold: z.boolean().optional(),
  responses: z.array(mockControlEntrySchema).min(1).optional(),
  scriptVersion: z.string().min(1).optional(),
  text: z.string().min(1).max(100_000).optional(),
});
const mockScriptEntrySchema = z
  .object({
    chunkDelayMs: z.number().int().min(0).max(MAX_MOCK_DELAY_MS).optional(),
    eventsFile: z.string().min(1).max(4_096).optional(),
    fail: mockFailureSchema.optional(),
    text: z.string().min(1).max(100_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const variants = [value.eventsFile, value.fail, value.text].filter(
      (entry) => entry !== undefined,
    );
    if (variants.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "each scripted response needs exactly one of text, eventsFile, or fail",
      });
    }
  });
const mockScriptSchema = z
  .object({
    default: mockScriptEntrySchema.optional(),
    responses: z.array(mockScriptEntrySchema).min(1).max(100),
  })
  .strict();
const credentialSchema = z.object({
  groupId: z.string().regex(/^-100\d+$/u),
  sutToken: z.string().min(1),
  testerUserId: z.union([z.string(), z.number()]).transform(String),
});
const sutRecoverySchema = z.object({
  containerName: z.string(),
  gatewayLog: z.string(),
  lifecycleEvidence: z.string(),
  mockLog: z.string(),
  mockResponseControl: z.string(),
  proxyControl: z.string(),
  proxyRequestLog: z.string(),
  requestLog: z.string(),
  tempRoot: z.string(),
});
const sutRuntimeSchema = sutRecoverySchema
  .extend({
    sutAttestation: z.object({ lane: laneSchema, sha: z.string().regex(/^[0-9a-f]{40}$/u) }),
  })
  .passthrough();
const startupSessionSchema = z.object({
  attempt: z.number().int().positive(),
  lane: laneSchema,
  observerPidFile: z.string(),
  observerRequested: z.boolean(),
  observerSocket: z.string(),
  privateDir: z.string(),
  recorderRequested: z.boolean(),
  recorderSession: z.string(),
  repoRoot: z.string(),
  startedAt: z.string(),
  sut: sutRecoverySchema.optional(),
});
const invocationSchema = z.object({
  args: z.record(z.string(), z.unknown()),
  at: z.string(),
  command: z.string(),
  cursor: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  stderrBytes: z.number().int().nonnegative().optional(),
  stdoutBytes: z.number().int().nonnegative().optional(),
});
const recorderArtifactsSchema = z.object({
  artifacts: z.record(z.string(), z.string()),
});
const desktopRecorderFailureBudgetSchema = z.object({
  attemptCount: z.number().int().positive(),
  classification: recorderAuthorizationFailureSchema.shape.classification,
  loginScreenshotPath: z.string().optional(),
  schemaVersion: z.literal(1),
  unavailable: z.boolean(),
});
const activeSessionSchema = z.object({
  attempt: z.number().int().positive(),
  config: configSchema,
  invocations: z.array(invocationSchema),
  lane: laneSchema,
  lastCursor: z.number().int().nonnegative(),
  lastViewedMessageId: z.string().optional(),
  inspectionScreenshots: z.array(z.string()).default([]),
  observeSeconds: z.number().nonnegative(),
  observerJournal: z.string(),
  observerLog: z.string(),
  observerPidFile: z.string(),
  observerSocket: z.string(),
  privateDir: z.string(),
  recorderSession: z.string(),
  repoRoot: z.string(),
  sendCount: z.number().int().nonnegative(),
  startedAt: z.string(),
  sut: sutRuntimeSchema,
});
type ActiveSession = z.infer<typeof activeSessionSchema>;
type StartupSession = z.infer<typeof startupSessionSchema>;
type Lane = z.infer<typeof laneSchema>;
type Roots = { credentialFile: string; outputRoot: string; sessionRoot: string };
type SutAttestation = z.infer<typeof sutRuntimeSchema>["sutAttestation"];
type ObserverResponse = {
  cursor?: number;
  error?: string;
  events?: unknown[];
  ok: boolean;
  truncated?: boolean;
} & Record<string, unknown>;
type DesktopRecorderFailureBudget = z.infer<typeof desktopRecorderFailureBudgetSchema>;

// Shared-QA-bot flood-safety ceiling; this is not a scenario or feasibility bound.
const MAX_SENDS = 40;
const MAX_EXEC_COMMAND_BYTES = 64 * 1024;
const MAX_RPC_BYTES = 4 * 1024 * 1024;
const commandOptions: Record<string, readonly string[]> = {
  abort: ["--lane"],
  block: ["--lane", "--missing-primitive", "--reason"],
  "botapi-clear": ["--lane"],
  "botapi-fail": ["--lane", "--method", "--times", "--status", "--drop"],
  "botapi-requests": ["--lane", "--method", "--limit"],
  delete: ["--lane", "--message-id"],
  desktop: ["--lane", "--actions-file", "--timeout-seconds"],
  exec: ["--lane", "--timeout-seconds", "--command", "--command-file"],
  finish: ["--lane", "--focus-message-id"],
  lifecycle: ["--lane", "--mode", "--timeout-seconds"],
  mock: [
    "--lane",
    "--response-file",
    "--response-events-file",
    "--chunk-delay-ms",
    "--script",
    "--script-sha256",
  ],
  observe: [
    "--lane",
    "--seconds",
    "--since",
    "--until-events",
    "--until-text",
    "--until-provider-requests",
  ],
  press: ["--lane", "--message-id", "--button"],
  requests: ["--lane"],
  restart: ["--lane", "--ready-timeout-seconds"],
  screenshot: ["--lane"],
  send: ["--lane", "--text", "--text-file", "--media", "--reply-to"],
  start: ["--lane", "--repo-root", "--config"],
  turn: ["--lane", "--text", "--text-file", "--media", "--reply-to", "--observe-seconds"],
  view: ["--lane", "--message-id"],
};
// Observed 2026-08: a hand-maintained advertised list omitted `turn`, discarding a 68s lane.
const commandNames = Object.keys(commandOptions);

function usageText(): string {
  return [
    "Usage: openclaw-telegram-mantis-lane <command> --lane <baseline|candidate> ...",
    `Commands: ${commandNames.join(", ")}`,
  ].join("\n");
}

function commandEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    ["HOME", "LANG", "LC_ALL", "PATH", "TEMP", "TMP", "TMPDIR"].flatMap((name) => {
      const value = process.env[name];
      return value ? [[name, value]] : [];
    }),
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function recorderRelativePath(file: string): string {
  const root = path.resolve(requiredEnv("OPENCLAW_MANTIS_SESSION_ROOT"));
  const relative = path.relative(root, path.resolve(file));
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Recorder paths must stay inside the private Mantis session root.");
  }
  return relative;
}

function parseCli(argv: string[]): { command: string; values: Map<string, string> } {
  const [command, ...rawArgs] = argv;
  if (!command || command.startsWith("--")) {
    throw new Error(usageText());
  }
  const args = [...rawArgs];
  const values = new Map<string, string>();
  if (command === "botapi-fail" && args[0] && !args[0].startsWith("--")) {
    values.set("--method", args.shift() ?? "");
  }
  for (let index = 0; index < args.length;) {
    const name = args[index];
    if (!name?.startsWith("--") || values.has(name)) {
      throw new Error(usageText());
    }
    if (name === "--drop") {
      values.set(name, "true");
      index += 1;
      continue;
    }
    if (command === "mock" && name === "--script") {
      const file = args[index + 1];
      const sha256 = args[index + 2];
      if (!file || !sha256 || sha256.startsWith("--")) {
        throw new Error("mock --script needs a file and sha256.");
      }
      values.set(name, file);
      values.set("--script-sha256", sha256);
      index += 3;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(usageText());
    }
    values.set(name, value);
    index += 2;
  }
  const allowed = commandOptions[command];
  if (!allowed) {
    throw new Error(usageText());
  }
  for (const name of values.keys()) {
    if (!allowed.includes(name)) {
      throw new Error(`${command} does not accept ${name}.`);
    }
  }
  return { command, values };
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function laneFrom(values: Map<string, string>): Lane {
  return laneSchema.parse(required(values, "--lane"));
}

function numberOption(
  values: Map<string, string>,
  name: string,
  maximum: number,
  minimum = 0,
): number {
  const value = Number(required(values, name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temp, file);
  fs.chmodSync(file, mode);
}

function desktopRecorderFailureBudgetFile(sessionRoot: string): string {
  return path.join(sessionRoot, "desktop-recorder-failures.json");
}

function readDesktopRecorderFailureBudget(
  sessionRoot: string,
): DesktopRecorderFailureBudget | undefined {
  const file = desktopRecorderFailureBudgetFile(sessionRoot);
  return fs.existsSync(file) ? desktopRecorderFailureBudgetSchema.parse(readJson(file)) : undefined;
}

function desktopUnavailableMessage(fact: DesktopRecorderFailureBudget, factFile: string): string {
  const screenshotDetail = fact.loginScreenshotPath
    ? `, loginScreenshotPath=${fact.loginScreenshotPath}`
    : "";
  return (
    `desktop-unavailable: stop retrying; this run's desktop is unavailable ` +
    `(attemptCount=${fact.attemptCount}, classification=${fact.classification}${screenshotDetail}, ` +
    `fact=${factFile})`
  );
}

function assertDesktopRecorderAvailable(sessionRoot: string): void {
  const fact = readDesktopRecorderFailureBudget(sessionRoot);
  if (fact?.unavailable) {
    throw new Error(desktopUnavailableMessage(fact, desktopRecorderFailureBudgetFile(sessionRoot)));
  }
}

function recordDesktopRecorderFailures(
  sessionRoot: string,
  failures: RecorderAuthorizationFailure[],
): DesktopRecorderFailureBudget | undefined {
  if (failures.length === 0) {
    return readDesktopRecorderFailureBudget(sessionRoot);
  }
  const prior = readDesktopRecorderFailureBudget(sessionRoot);
  const latest = failures.at(-1);
  if (!latest) {
    return prior;
  }
  const attemptCount = (prior?.attemptCount ?? 0) + failures.length;
  const fact = desktopRecorderFailureBudgetSchema.parse({
    attemptCount,
    classification: latest.classification,
    loginScreenshotPath: latest.loginScreenshotPath,
    schemaVersion: 1,
    unavailable: attemptCount >= 2,
  });
  writeJsonAtomic(desktopRecorderFailureBudgetFile(sessionRoot), fact);
  return fact;
}

export async function startDesktopRecorder(params: {
  chat: string;
  outputDir: string;
  recorderCommand: string;
  sessionPath: string;
  sessionRoot: string;
  userDriver: string;
}): Promise<void> {
  assertDesktopRecorderAvailable(params.sessionRoot);
  try {
    await runCommand(params.recorderCommand, [
      "start",
      "--provider",
      "docker",
      "--session",
      recorderRelativePath(params.sessionPath),
      "--output-dir",
      recorderRelativePath(params.outputDir),
      "--chat",
      params.chat,
      "--user-driver",
      params.userDriver,
    ]);
  } catch (startError) {
    const failureFile = path.join(params.outputDir, RECORDER_AUTHORIZATION_FAILURE_FILENAME);
    const failures = fs.existsSync(failureFile)
      ? recorderAuthorizationFailureFactSchema.parse(readJson(failureFile)).failures
      : [];
    const budget = recordDesktopRecorderFailures(params.sessionRoot, failures);
    if (budget?.unavailable) {
      throw new Error(
        `${desktopUnavailableMessage(budget, desktopRecorderFailureBudgetFile(params.sessionRoot))}\n${coerceErrorMessage(startError)}`,
        { cause: startError },
      );
    }
    throw startError;
  }
}

function publicRelativePath(root: string, file: string, label: string): string {
  const resolvedRoot = fs.realpathSync(root);
  const relative = path.relative(resolvedRoot, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the Mantis output directory.`);
  }
  // Node has no openat(2), so containment is re-proven component by component: a directory
  // swapped for a symlink after the caller resolved the path would otherwise route an
  // already-open descriptor outside the root, which O_NOFOLLOW only prevents for the leaf.
  let cursor = resolvedRoot;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`${label} must be inside the Mantis output directory.`);
    }
  }
  return relative;
}

function readPublicFile(
  root: string,
  input: string,
  label: string,
  maxBytes: number,
): { relative: string; resolved: string; text: string } {
  const resolved = fs.realpathSync(input);
  const expected = fs.lstatSync(resolved);
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    // Bind the read to the path inspected before open so a concurrent swap cannot redirect it.
    if (stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw new Error(`${label} must be inside the Mantis output directory.`);
    }
    // Linux pins the opened path directly; other platforms reject pre-open inode swaps.
    const opened =
      process.platform === "linux"
        ? fs.realpathSync(`/proc/self/fd/${descriptor}`)
        : fs.realpathSync(resolved);
    const relative = publicRelativePath(root, opened, label);
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error(`${label} must be a regular file no larger than ${maxBytes} bytes.`);
    }
    return { relative, resolved, text: fs.readFileSync(descriptor, "utf8") };
  } finally {
    fs.closeSync(descriptor);
  }
}

function resolvePublicFilePath(root: string, input: string, label: string): string {
  const resolved = fs.realpathSync(input);
  publicRelativePath(root, resolved, label);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
  return resolved;
}

function activeFile(sessionRoot: string, lane: Lane): string {
  return path.join(sessionRoot, `${lane}.active.json`);
}

function startupFile(sessionRoot: string, lane: Lane): string {
  return path.join(sessionRoot, `${lane}.starting.json`);
}

function saveStartup(sessionRoot: string, startup: StartupSession): void {
  writeJsonAtomic(startupFile(sessionRoot, startup.lane), startup);
}

function readStartup(sessionRoot: string, lane: Lane): StartupSession {
  return startupSessionSchema.parse(readJson(startupFile(sessionRoot, lane)));
}

function readActive(sessionRoot: string, lane: Lane): ActiveSession {
  const file = activeFile(sessionRoot, lane);
  if (!fs.existsSync(file)) {
    throw new Error(`No active ${lane} lane. Run start first.`);
  }
  return activeSessionSchema.parse(readJson(file));
}

function saveActive(sessionRoot: string, state: ActiveSession): void {
  writeJsonAtomic(activeFile(sessionRoot, state.lane), state);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists under another user; only ESRCH proves the lock owner is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireHarnessLock(sessionRoot: string): () => void {
  const lock = path.join(sessionRoot, "harness.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = fs.openSync(lock, "wx", 0o600);
      fs.writeFileSync(handle, `${process.pid}\n`);
      fs.closeSync(handle);
      return () => {
        if (fs.existsSync(lock) && fs.readFileSync(lock, "utf8").trim() === String(process.pid)) {
          fs.rmSync(lock);
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const owner = Number(fs.readFileSync(lock, "utf8").trim());
      if (Number.isInteger(owner) && owner > 0 && processIsAlive(owner)) {
        throw new Error("The shared Telegram harness already has a command in progress.", {
          cause: error,
        });
      }
      fs.rmSync(lock, { force: true });
    }
  }
  throw new Error("Could not acquire the shared Telegram harness command lock.");
}

function appendInvocation(
  state: ActiveSession,
  command: string,
  args: Record<string, unknown>,
  cursor?: number,
  result?: { exitCode: number; stderrBytes: number; stdoutBytes: number },
): void {
  state.invocations.push({
    args,
    at: new Date().toISOString(),
    command,
    ...(cursor === undefined ? {} : { cursor }),
    ...result,
  });
  if (cursor !== undefined) {
    state.lastCursor = cursor;
  }
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await runCommandOutput(command, args);
}

async function runCommandOutput(command: string, args: string[]): Promise<string> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    env: commandEnv(),
    maxBuffer: MAX_RPC_BYTES,
  });
  return result.stdout;
}

async function observerCall(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<ObserverResponse> {
  return await new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let bytes = "";
    const timeout = setTimeout(
      () => client.destroy(new Error("Telegram observer timed out.")),
      75_000,
    );
    client.setEncoding("utf8");
    client.on("connect", () => client.end(`${JSON.stringify(request)}\n`));
    client.on("data", (chunk) => {
      bytes += chunk.toString();
      if (Buffer.byteLength(bytes) > MAX_RPC_BYTES) {
        client.destroy(new Error("Telegram observer response exceeded 4 MiB."));
      }
    });
    client.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    client.on("close", () => {
      clearTimeout(timeout);
      try {
        const response = z
          .object({ ok: z.boolean(), error: z.string().optional(), cursor: z.number().optional() })
          .passthrough()
          .parse(JSON.parse(bytes));
        if (!response.ok) {
          reject(new Error(response.error ?? "Telegram observer command failed."));
        } else {
          resolve(response as ObserverResponse);
        }
      } catch (error) {
        reject(new Error(coerceErrorMessage(error)));
      }
    });
  });
}

async function waitForObserver(socketPath: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (fs.existsSync(socketPath)) {
      try {
        await observerCall(socketPath, { command: "ping" });
        return;
      } catch {}
    }
    await sleep(100);
  }
  throw new Error("Telegram observer did not become ready.");
}

async function terminateObserverProcess(
  pidFile: string,
  socketPath: string,
): Promise<string | undefined> {
  try {
    await runCommand(requiredEnv("OPENCLAW_TELEGRAM_USER_DRIVER_CMD"), [
      "terminate-observer",
      "--pid-file",
      pidFile,
      "--socket",
      socketPath,
    ]);
  } catch (error) {
    return coerceErrorMessage(error);
  }
  return undefined;
}

function artifact(file: string): { bytes: number; file: string; sha256: string } {
  return {
    bytes: fs.statSync(file).size,
    file: path.basename(file),
    sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  };
}

function validateMedia(file: string): void {
  if (fs.statSync(file).size <= 10_000) {
    throw new Error(`Recorder artifact is too small: ${path.basename(file)}.`);
  }
  if (
    file.endsWith(".png") &&
    !fs.readFileSync(file).subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    throw new Error("Recorder screenshot is not a PNG.");
  }
}

function redact(value: unknown, secret: string): unknown {
  if (typeof value === "string") {
    return secret ? value.replaceAll(secret, "[redacted]") : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, secret));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /^(?:authorization|token|secret|api[_-]?key)$/iu.test(key) ||
        /(?:^|_)(?:auth|secret|token|api_key)(?:$|_)/iu.test(key)
          ? "[redacted]"
          : redact(entry, secret),
      ]),
    );
  }
  return value;
}

function redactSutValue(value: unknown, sutToken: string): unknown {
  const botId = sutToken.split(":", 1)[0] ?? "";
  const aliasToken = botId ? `${botId}:${"A".repeat(35)}` : "";
  return redact(redact(value, sutToken), aliasToken);
}

function providerRequests(state: ActiveSession, secret: string): unknown[] {
  // Tail window, like botApiRequests: a long session must surface its newest
  // provider turns. Entries carry a producer-stamped `seq` ordinal, so the
  // window keeps absolute order without rereading the whole file.
  return boundedNdjson(state.sut.requestLog, 128).map(
    (entry) => redact(entry, secret) as Record<string, unknown>,
  );
}

function boundedNdjson(file: string, limit: number): unknown[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  const stat = fs.statSync(file);
  const readBytes = Math.min(stat.size, MAX_RPC_BYTES);
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(readBytes);
    fs.readSync(descriptor, buffer, 0, readBytes, stat.size - readBytes);
    let text = buffer.toString("utf8");
    if (readBytes < stat.size) {
      text = text.slice(text.indexOf("\n") + 1);
    }
    return text
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line));
  } finally {
    fs.closeSync(descriptor);
  }
}

function botApiRequests(
  state: ActiveSession,
  secret: string,
  options: { limit?: number; method?: string } = {},
): unknown[] {
  const method = options.method;
  const limit = options.limit ?? 100;
  const requests = boundedNdjson(state.sut.proxyRequestLog, 128).filter(
    (entry) =>
      !method ||
      (entry !== null && typeof entry === "object" && "method" in entry && entry.method === method),
  );
  return requests
    .slice(-limit)
    .map((entry, index) =>
      Object.assign({ index: index + 1 }, redact(entry, secret) as Record<string, unknown>),
    );
}

function outputJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function writeAttemptFacts(roots: Roots, lane: Lane, attempt: number, facts: unknown): void {
  const filename = `attempt-${attempt}-facts.json`;
  writeJsonAtomic(path.join(roots.sessionRoot, "published", lane, filename), facts, 0o644);
  writeJsonAtomic(path.join(roots.outputRoot, lane, filename), facts, 0o644);
}

function publishTerminalLaneFacts(params: {
  artifacts: Record<string, ReturnType<typeof artifact>>;
  attempt: number;
  facts: unknown;
  lane: Lane;
  roots: Roots;
  status: "blocked" | "fail" | "pass";
  sutAttestation?: SutAttestation;
}): void {
  const privatePublished = path.join(params.roots.sessionRoot, "published", params.lane);
  const publicOutput = path.join(params.roots.outputRoot, params.lane);
  writeAttemptFacts(params.roots, params.lane, params.attempt, params.facts);
  writeJsonAtomic(path.join(privatePublished, "mantis-lane-facts.json"), params.facts, 0o644);
  writeJsonAtomic(path.join(publicOutput, "mantis-lane-facts.json"), params.facts, 0o644);
  writeJsonAtomic(path.join(params.roots.sessionRoot, `${params.lane}.json`), params.facts);
  writeJsonAtomic(
    path.join(publicOutput, "telegram-user-crabbox-session-summary.json"),
    {
      artifacts: Object.fromEntries(
        Object.entries(params.artifacts).map(([name, record]) => [
          name,
          path.join(publicOutput, record.file),
        ]),
      ),
      status: params.status,
      ...(params.sutAttestation ? { sutAttestation: params.sutAttestation } : {}),
    },
    0o644,
  );
}

export function publishStartupFailure(params: {
  cleanupErrors: string[];
  configRelative: string;
  error: unknown;
  roots: Roots;
  secret: string;
  startup: StartupSession;
  sutAttestation?: SutAttestation;
}): void {
  let lifecycleEvents: unknown[] = [];
  let lifecycleEvidenceError: string | undefined;
  if (params.startup.sut) {
    const preservedEvidence = path.join(
      params.startup.privateDir,
      path.basename(params.startup.sut.lifecycleEvidence),
    );
    if (fs.existsSync(preservedEvidence)) {
      try {
        lifecycleEvents = readMantisLifecycleEvidence(preservedEvidence);
      } catch (error) {
        lifecycleEvidenceError = coerceErrorMessage(error);
      }
    }
  }
  const facts = redact(
    {
      artifacts: {},
      attempt: params.startup.attempt,
      botApiRequests: [],
      cleanupErrors: params.cleanupErrors,
      completedAt: new Date().toISOString(),
      error: coerceErrorMessage(params.error),
      invocations: [
        {
          args: { config: params.configRelative, repoRoot: params.startup.repoRoot },
          at: params.startup.startedAt,
          command: "start",
          cursor: 0,
        },
      ],
      lane: params.startup.lane,
      lifecycleEvents,
      lifecycleEvidenceError,
      observation: {
        cursor: 0,
        events: [],
        observedSeconds: 0,
        truncated: false,
        uptimeMs: Date.now() - Date.parse(params.startup.startedAt),
      },
      providerRequests: [],
      schemaVersion: 2,
      sendCount: 0,
      startedAt: params.startup.startedAt,
      status: "infra-error",
      ...(params.sutAttestation ? { sutAttestation: params.sutAttestation } : {}),
    },
    params.secret,
  );
  publishTerminalLaneFacts({
    artifacts: {},
    attempt: params.startup.attempt,
    facts,
    lane: params.startup.lane,
    roots: params.roots,
    status: "fail",
    sutAttestation: params.sutAttestation,
  });
}

function teardownSut(sut: MantisSutRecovery, outputDir: string): string[] {
  const errors: string[] = [];
  for (const action of [
    () => stopMantisSut(sut),
    () => preserveMantisSutRuntimeArtifacts(sut, outputDir),
    () => destroyMantisSut(sut),
  ]) {
    try {
      action();
    } catch (error) {
      errors.push(coerceErrorMessage(error));
    }
  }
  return errors;
}

async function recoverStartupResources(
  startup: StartupSession,
  sut: MantisSutRecovery | undefined = startup.sut,
): Promise<string[]> {
  const errors: string[] = [];
  if (startup.observerRequested) {
    for (let attempt = 0; attempt < 50 && !fs.existsSync(startup.observerPidFile); attempt += 1) {
      await sleep(100);
    }
    const observerError = await terminateObserverProcess(
      startup.observerPidFile,
      startup.observerSocket,
    );
    if (observerError) {
      errors.push(observerError);
    }
  }
  if (startup.recorderRequested) {
    const recorderCommand = fs.existsSync(startup.recorderSession) ? "stop" : "recover";
    await runCommand(requiredEnv("OPENCLAW_TELEGRAM_DESKTOP_RECORDER_CMD"), [
      recorderCommand,
      "--session",
      recorderRelativePath(startup.recorderSession),
    ]).catch((error: unknown) => errors.push(coerceErrorMessage(error)));
  }
  if (sut) {
    errors.push(...teardownSut(sut, startup.privateDir));
  }
  return errors;
}

async function startLane(values: Map<string, string>, roots: Roots): Promise<void> {
  const lane = laneFrom(values);
  const repoRoot = path.resolve(required(values, "--repo-root"));
  const configFile = readPublicFile(
    roots.outputRoot,
    required(values, "--config"),
    "--config",
    1024 * 1024,
  );
  const config = configSchema.parse(JSON.parse(configFile.text));
  const credential = credentialSchema.parse(readJson(roots.credentialFile));
  if (fs.existsSync(activeFile(roots.sessionRoot, lane))) {
    throw new Error(`${lane} already has an active session.`);
  }
  if (fs.existsSync(startupFile(roots.sessionRoot, lane))) {
    throw new Error(`${lane} has an interrupted startup; run abort before retrying.`);
  }
  const otherLane: Lane = lane === "baseline" ? "candidate" : "baseline";
  if (
    fs.existsSync(activeFile(roots.sessionRoot, otherLane)) ||
    fs.existsSync(startupFile(roots.sessionRoot, otherLane))
  ) {
    throw new Error(`Finish or abort the active ${otherLane} session first.`);
  }
  assertDesktopRecorderAvailable(roots.sessionRoot);
  const attemptsRoot = path.join(roots.sessionRoot, "attempts", lane);
  fs.mkdirSync(attemptsRoot, { recursive: true });
  const attempt = fs.readdirSync(attemptsRoot).filter((entry) => /^\d+$/u.test(entry)).length + 1;
  const privateDir = path.join(attemptsRoot, String(attempt));
  fs.mkdirSync(privateDir, { mode: 0o770 });
  const recorderSession = path.join(roots.sessionRoot, "desktop-recorder.json");
  const observerSocket = path.join(privateDir, "observer.sock");
  const observerJournal = path.join(privateDir, "telegram-events.ndjson");
  const observerLog = path.join(privateDir, "observer.log");
  const observerPidFile = path.join(privateDir, "observer.pid.json");
  const startup: StartupSession = {
    attempt,
    lane,
    observerPidFile,
    observerRequested: false,
    observerSocket,
    privateDir,
    recorderRequested: false,
    recorderSession,
    repoRoot,
    startedAt: new Date().toISOString(),
  };
  // The workflow cleanup runs in a later process. Publish recovery paths before
  // starting any credential-bearing service, then refine them as handles exist.
  saveStartup(roots.sessionRoot, startup);
  const ports =
    lane === "baseline" ? { gateway: 19_879, mock: 19_882 } : { gateway: 19_979, mock: 19_982 };
  let sut: Awaited<ReturnType<typeof startMantisSut>> | undefined;
  try {
    // Observed 2026-08: TDLib 1.8.0 returned CHANNEL_INVALID when asked to clear
    // this QA supergroup locally. Keep shared history; narrow published evidence.
    startup.recorderRequested = true;
    saveStartup(roots.sessionRoot, startup);
    const [botResult, sutResult, recorderResult] = await Promise.allSettled([
      telegramBotApi(credential.sutToken, "getMe"),
      startMantisSut({
        configPatch: config.configPatch,
        fixturePluginsDir: path.join(roots.sessionRoot, "fixture-plugins", lane),
        gatewayPort: ports.gateway,
        groupId: credential.groupId,
        mockPort: ports.mock,
        mockResponseChunkDelayMs: config.mockResponseChunkDelayMs,
        mockResponseText: config.mockResponse,
        outputDir: privateDir,
        repoRoot,
        sutLane: lane,
        sutToken: credential.sutToken,
        testerId: credential.testerUserId,
        onRuntimeCreated: (runtime) => {
          startup.sut = runtime;
          saveStartup(roots.sessionRoot, startup);
        },
        onRuntimeDisposed: () => {
          startup.sut = undefined;
          saveStartup(roots.sessionRoot, startup);
        },
      }),
      startDesktopRecorder({
        chat: credential.groupId,
        outputDir: privateDir,
        recorderCommand: requiredEnv("OPENCLAW_TELEGRAM_DESKTOP_RECORDER_CMD"),
        sessionPath: recorderSession,
        sessionRoot: roots.sessionRoot,
        userDriver: requiredEnv("OPENCLAW_TELEGRAM_USER_DRIVER_CMD"),
      }),
    ]);
    if (sutResult.status === "fulfilled") {
      sut = sutResult.value;
    }
    if (botResult.status === "rejected") {
      throw botResult.reason;
    }
    if (sutResult.status === "rejected") {
      throw sutResult.reason;
    }
    if (recorderResult.status === "rejected") {
      throw recorderResult.reason;
    }
    const bot = z
      .object({
        id: z.union([z.string(), z.number()]).transform(String),
        username: z.string().min(1),
      })
      .parse(botResult.value);
    const logFd = fs.openSync(observerLog, "a", 0o600);
    let observer: ReturnType<typeof spawn>;
    startup.observerRequested = true;
    saveStartup(roots.sessionRoot, startup);
    try {
      observer = spawn(
        requiredEnv("OPENCLAW_TELEGRAM_USER_DRIVER_CMD"),
        [
          "serve",
          "--chat",
          credential.groupId,
          "--sut-user-id",
          bot.id,
          "--sut-username",
          bot.username,
          "--socket",
          observerSocket,
          "--pid-file",
          observerPidFile,
          "--journal",
          observerJournal,
          "--media-root",
          roots.outputRoot,
        ],
        { detached: true, env: commandEnv(), stdio: ["ignore", logFd, logFd] },
      );
    } finally {
      fs.closeSync(logFd);
    }
    if (!observer.pid) {
      throw new Error("Telegram observer started without a process id.");
    }
    observer.unref();
    await waitForObserver(observerSocket);
    const state: ActiveSession = {
      attempt,
      config,
      inspectionScreenshots: [],
      invocations: [],
      lane,
      lastCursor: 0,
      observeSeconds: 0,
      observerJournal,
      observerLog,
      observerPidFile,
      observerSocket,
      privateDir,
      recorderSession,
      repoRoot,
      sendCount: 0,
      startedAt: startup.startedAt,
      sut: sutRuntimeSchema.parse(sut),
    };
    appendInvocation(state, "start", { config: configFile.relative, repoRoot }, 0);
    saveActive(roots.sessionRoot, state);
    fs.rmSync(startupFile(roots.sessionRoot, lane));
    outputJson({
      attempt,
      lane,
      status: "ready",
      budgets: {
        maxSends: MAX_SENDS,
      },
      commands: commandNames.filter((command) => command !== "start"),
    });
  } catch (error) {
    const cleanupErrors = await recoverStartupResources(startup, sut ?? startup.sut);
    const sutAttestation = sut?.sutAttestation;
    publishStartupFailure({
      cleanupErrors,
      configRelative: configFile.relative,
      error,
      roots,
      secret: credential.sutToken,
      startup,
      sutAttestation,
    });
    if (cleanupErrors.length === 0) {
      fs.rmSync(startupFile(roots.sessionRoot, lane), { force: true });
    }
    throw new Error(
      [
        coerceErrorMessage(error),
        ...cleanupErrors.map((entry) => `Cleanup failure: ${entry}`),
      ].join("\n"),
      { cause: error },
    );
  }
}

async function abortStartup(startup: StartupSession, roots: Roots): Promise<void> {
  const errors = await recoverStartupResources(startup);
  if (errors.length) {
    throw new Error(`Mantis startup recovery completed with errors:\n${errors.join("\n")}`);
  }
  fs.rmSync(startupFile(roots.sessionRoot, startup.lane), { force: true });
  outputJson({ attempt: startup.attempt, lane: startup.lane, status: "aborted-startup" });
}

function readMessage(
  values: Map<string, string>,
  outputRoot: string,
): { media?: string; text: string } {
  const direct = values.get("--text");
  const textFile = values.get("--text-file");
  if (direct !== undefined && textFile !== undefined) {
    throw new Error("Use only one of --text or --text-file.");
  }
  const text = textFile
    ? readPublicFile(outputRoot, textFile, "--text-file", 16 * 1024).text
    : (direct ?? "");
  const mediaInput = values.get("--media");
  const media = mediaInput
    ? path.relative(outputRoot, resolvePublicFilePath(outputRoot, mediaInput, "--media"))
    : undefined;
  if (!text && !media) {
    throw new Error("send needs --text, --text-file, or --media.");
  }
  if (text.length > 4_000) {
    throw new Error("Telegram message text exceeds 4000 characters.");
  }
  return { text, ...(media ? { media } : {}) };
}

async function send(
  state: ActiveSession,
  values: Map<string, string>,
  outputRoot: string,
  secret: string,
): Promise<ObserverResponse> {
  if (state.sendCount >= MAX_SENDS) {
    throw new Error(`The ${MAX_SENDS}-message session budget is exhausted.`);
  }
  const message = readMessage(values, outputRoot);
  const replyTo = values.get("--reply-to");
  const response = await observerCall(state.observerSocket, {
    command: "send",
    ...message,
    ...(replyTo ? { replyTo } : {}),
  });
  state.sendCount += 1;
  appendInvocation(
    state,
    "send",
    { media: message.media, replyTo, text: message.text },
    response.cursor,
  );
  return redact(response, secret) as ObserverResponse;
}

async function revealSentMessage(
  state: ActiveSession,
  response: ObserverResponse,
): Promise<string> {
  const sent = response.sent;
  if (
    sent === null ||
    typeof sent !== "object" ||
    !("actor" in sent) ||
    sent.actor !== "user" ||
    !("messageId" in sent) ||
    typeof sent.messageId !== "string" ||
    !/^\d+$/u.test(sent.messageId)
  ) {
    throw new Error("Telegram send did not return a session-owned server message id.");
  }
  await runCommand(requiredEnv("OPENCLAW_TELEGRAM_DESKTOP_RECORDER_CMD"), [
    "view",
    "--session",
    recorderRelativePath(state.recorderSession),
    "--message-id",
    sent.messageId,
  ]);
  state.lastViewedMessageId = sent.messageId;
  appendInvocation(state, "reveal", { messageId: sent.messageId }, response.cursor);
  return sent.messageId;
}

async function sendVisibleMessage(
  state: ActiveSession,
  values: Map<string, string>,
  roots: Roots,
  secret: string,
): Promise<{ response: ObserverResponse; revealedMessageId: string }> {
  setMockResponseHold(state, true);
  try {
    const response = await send(state, values, roots.outputRoot, secret);
    saveActive(roots.sessionRoot, state);
    const revealedMessageId = await revealSentMessage(state, response);
    saveActive(roots.sessionRoot, state);
    return { response, revealedMessageId };
  } finally {
    setMockResponseHold(state, false);
  }
}

async function observe(
  state: ActiveSession,
  values: Map<string, string>,
  secret: string,
): Promise<ObserverResponse> {
  const seconds = numberOption(values, "--seconds", 60);
  const since = values.has("--since")
    ? numberOption(values, "--since", Number.MAX_SAFE_INTEGER)
    : state.lastCursor;
  const untilEvents = values.has("--until-events")
    ? numberOption(values, "--until-events", 500)
    : undefined;
  const untilProviderRequests = values.has("--until-provider-requests")
    ? numberOption(values, "--until-provider-requests", 100)
    : undefined;
  const untilText = values.get("--until-text");
  if (untilText !== undefined && (untilText.length < 1 || untilText.length > 1_000)) {
    throw new Error("--until-text must contain 1 to 1000 characters.");
  }
  const conditions =
    untilEvents !== undefined || untilProviderRequests !== undefined || untilText !== undefined;
  if (!conditions) {
    const response = await observerCall(state.observerSocket, {
      command: "events",
      seconds,
      since,
    });
    state.observeSeconds += seconds;
    appendInvocation(state, "observe", { seconds, since }, response.cursor);
    return redact(response, secret) as ObserverResponse;
  }

  const startedAt = Date.now();
  const deadline = startedAt + seconds * 1_000;
  let timeline: ObserverResponse;
  while (true) {
    timeline = await observerCall(state.observerSocket, {
      command: "events",
      seconds: 0,
      since: 0,
    });
    const events = Array.isArray(timeline.events) ? timeline.events : [];
    // Event predicates scope to post-`since` events so stale timeline history
    // (a reused marker, prior turns) cannot satisfy an early return before the
    // observed action produces evidence. Provider counts stay cumulative: the
    // provider log has no per-observe cursor and requests can land before the
    // observe starts, so a relative baseline would miss them.
    const newEvents = events.slice(since);
    const textMatched =
      untilText === undefined || newEvents.some((event) => valueContainsText(event, untilText));
    const eventCountMatched = untilEvents === undefined || newEvents.length >= untilEvents;
    const providerCountMatched =
      untilProviderRequests === undefined ||
      providerRequests(state, secret).length >= untilProviderRequests;
    if (textMatched && eventCountMatched && providerCountMatched) {
      break;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    await observerCall(state.observerSocket, {
      command: "events",
      seconds: Math.min(1.5, remainingMs / 1_000),
      since: 0,
    });
  }
  const cursor = timeline.cursor ?? 0;
  if (since > cursor) {
    throw new Error("Observation cursor is outside this session's timeline.");
  }
  const response = {
    ...timeline,
    events: Array.isArray(timeline.events) ? timeline.events.slice(since) : [],
  };
  state.observeSeconds += (Date.now() - startedAt) / 1_000;
  appendInvocation(
    state,
    "observe",
    { seconds, since, untilEvents, untilProviderRequests, untilText },
    response.cursor,
  );
  return redact(response, secret) as ObserverResponse;
}

function valueContainsText(value: unknown, text: string): boolean {
  if (typeof value === "string") {
    return value.includes(text);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => valueContainsText(entry, text));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) => valueContainsText(entry, text));
  }
  return false;
}

function updateMockResponse(
  state: ActiveSession,
  values: Map<string, string>,
  outputRoot: string,
): Record<string, unknown> {
  if (values.has("--script")) {
    if (
      values.has("--response-file") ||
      values.has("--response-events-file") ||
      values.has("--chunk-delay-ms")
    ) {
      throw new Error("mock --script cannot be combined with single-response options.");
    }
    const scriptFile = readPublicFile(
      outputRoot,
      required(values, "--script"),
      "--script",
      512 * 1024,
    );
    const expectedSha256 = required(values, "--script-sha256").toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(expectedSha256)) {
      throw new Error("mock --script sha256 must be 64 lowercase hexadecimal characters.");
    }
    const scriptSha256 = createHash("sha256").update(scriptFile.text).digest("hex");
    if (scriptSha256 !== expectedSha256) {
      throw new Error("mock --script sha256 mismatch.");
    }
    const script = mockScriptSchema.parse(JSON.parse(scriptFile.text));
    const eventFiles: Array<{ bytes: number; file: string; sha256: string }> = [];
    let eventFileBytes = 0;
    const materialize = (entry: z.infer<typeof mockScriptEntrySchema>) => {
      if (!entry.eventsFile) {
        return {
          ...(entry.chunkDelayMs === undefined ? {} : { chunkDelayMs: entry.chunkDelayMs }),
          ...(entry.fail === undefined ? {} : { fail: entry.fail }),
          ...(entry.text === undefined ? {} : { text: entry.text }),
        };
      }
      const eventsPath = path.resolve(path.dirname(scriptFile.resolved), entry.eventsFile);
      const eventsFile = readPublicFile(outputRoot, eventsPath, "script eventsFile", MAX_RPC_BYTES);
      eventFileBytes += Buffer.byteLength(eventsFile.text);
      if (eventFileBytes > MAX_RPC_BYTES) {
        throw new Error("mock --script event files exceed 4 MiB in total.");
      }
      const events = z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .parse(JSON.parse(eventsFile.text));
      eventFiles.push({
        bytes: Buffer.byteLength(eventsFile.text),
        file: eventsFile.relative,
        sha256: createHash("sha256").update(eventsFile.text).digest("hex"),
      });
      return {
        ...(entry.chunkDelayMs === undefined ? {} : { chunkDelayMs: entry.chunkDelayMs }),
        events,
      };
    };
    const current = readMockResponseControl(state);
    writeJsonAtomic(state.sut.mockResponseControl, {
      ...(script.default === undefined ? {} : { default: materialize(script.default) }),
      hold: current.hold,
      responses: script.responses.map(materialize),
      scriptVersion: `${scriptSha256}:${state.invocations.length + 1}`,
    });
    appendInvocation(state, "mock", {
      bytes: Buffer.byteLength(scriptFile.text),
      eventFiles,
      responses: script.responses.length,
      scriptFile: scriptFile.relative,
      scriptSha256,
    });
    return {
      eventFiles: eventFiles.length,
      responses: script.responses.length,
      scriptSha256,
    };
  }
  if (values.has("--response-events-file")) {
    if (values.has("--response-file") || values.has("--chunk-delay-ms")) {
      throw new Error("Use one mock response form at a time.");
    }
    const eventsFile = readPublicFile(
      outputRoot,
      required(values, "--response-events-file"),
      "--response-events-file",
      MAX_RPC_BYTES,
    );
    const events = z
      .array(z.record(z.string(), z.unknown()))
      .min(1)
      .parse(JSON.parse(eventsFile.text));
    const current = readMockResponseControl(state);
    writeJsonAtomic(state.sut.mockResponseControl, { events, hold: current.hold });
    const eventsSha256 = createHash("sha256").update(eventsFile.text).digest("hex");
    appendInvocation(state, "mock", {
      bytes: Buffer.byteLength(eventsFile.text),
      eventsFile: eventsFile.relative,
      eventsSha256,
    });
    return { bytes: Buffer.byteLength(eventsFile.text), events: events.length, eventsSha256 };
  }
  const responseFile = readPublicFile(
    outputRoot,
    required(values, "--response-file"),
    "--response-file",
    128 * 1024,
  );
  const text = responseFile.text;
  if (!text || text.length > 100_000) {
    throw new Error("--response-file must contain 1 to 100000 characters.");
  }
  const chunkDelayMs = values.has("--chunk-delay-ms")
    ? numberOption(values, "--chunk-delay-ms", MAX_MOCK_DELAY_MS)
    : 0;
  const current = readMockResponseControl(state);
  writeJsonAtomic(state.sut.mockResponseControl, { chunkDelayMs, hold: current.hold, text });
  const textSha256 = createHash("sha256").update(text).digest("hex");
  appendInvocation(state, "mock", {
    bytes: Buffer.byteLength(text),
    chunkDelayMs,
    responseFile: responseFile.relative,
    textSha256,
  });
  return { bytes: Buffer.byteLength(text), chunkDelayMs, textSha256 };
}

function requireBotApiMethod(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value)) {
    throw new Error("Bot API method is invalid.");
  }
  return value;
}

function validateProxyControlFile(state: ActiveSession): void {
  const control = fs.lstatSync(state.sut.proxyControl);
  if (!control.isFile() || control.nlink !== 1) {
    throw new Error("The private Telegram proxy control is no longer a regular file.");
  }
}

function updateBotApiFault(
  state: ActiveSession,
  values: Map<string, string>,
): Record<string, unknown> {
  validateProxyControlFile(state);
  const method = requireBotApiMethod(required(values, "--method"));
  if (values.has("--drop") && values.has("--status")) {
    throw new Error("Use only one of --status or --drop.");
  }
  const times = values.has("--times") ? numberOption(values, "--times", 100, 1) : undefined;
  const status = values.has("--status") ? numberOption(values, "--status", 599, 400) : undefined;
  const rule = {
    method,
    ...(times === undefined ? {} : { times }),
    ...(values.has("--drop") ? { mode: "drop" } : { status: status ?? 500 }),
  };
  writeJsonAtomic(state.sut.proxyControl, { rules: [rule] });
  appendInvocation(state, "botapi-fail", rule);
  return rule;
}

function clearBotApiFaults(state: ActiveSession): Record<string, unknown> {
  validateProxyControlFile(state);
  writeJsonAtomic(state.sut.proxyControl, { rules: [] });
  appendInvocation(state, "botapi-clear", {});
  return { rules: 0 };
}

function runGatewayLifecycle(
  state: ActiveSession,
  values: Map<string, string>,
): Record<string, unknown> {
  const mode = z.enum(["crash", "graceful"]).parse(required(values, "--mode"));
  const readinessTimeoutSeconds = values.has("--timeout-seconds")
    ? numberOption(values, "--timeout-seconds", 120, 5)
    : 60;
  // Root evidence, not the lane JSON cache, owns generation identity. If the lane
  // process died after replacement but before saving state, the next process still
  // resumes from the exact ready generation rather than issuing a stale action.
  const previousGeneration = readReadyMantisLifecycleGeneration(state.sut.lifecycleEvidence);
  const result = runMantisSutLifecycleAction({
    containerName: state.sut.containerName,
    expectedGeneration: previousGeneration,
    lifecycleEvidence: state.sut.lifecycleEvidence,
    mode,
    readinessTimeoutSeconds,
    runtimeRoot: state.sut.tempRoot,
  });
  const lifecycleEvents = result.events.filter((event) => event.requestId === result.requestId);
  appendInvocation(state, "lifecycle", {
    eventSequences: lifecycleEvents.map((event) => event.sequence),
    mode,
    previousGeneration,
    readinessTimeoutSeconds,
    requestId: result.requestId,
    successorGeneration: result.generation,
  });
  return {
    events: lifecycleEvents,
    generation: result.generation,
    mockContainerId: result.mockContainerId,
    mode,
    previousGeneration,
    proxyContainerId: result.proxyContainerId,
    requestId: result.requestId,
    status: "ready",
  };
}

function readMockResponseControl(state: ActiveSession): z.infer<typeof mockResponseControlSchema> {
  const control = fs.lstatSync(state.sut.mockResponseControl);
  if (!control.isFile() || control.nlink !== 1) {
    throw new Error("The private mock response control is no longer a regular file.");
  }
  return mockResponseControlSchema.parse(readJson(state.sut.mockResponseControl));
}

function setMockResponseHold(state: ActiveSession, hold: boolean): void {
  writeJsonAtomic(state.sut.mockResponseControl, { ...readMockResponseControl(state), hold });
}

async function observerAction(
  state: ActiveSession,
  command: "delete" | "press",
  values: Map<string, string>,
): Promise<ObserverResponse> {
  const messageId = required(values, "--message-id");
  const request: Record<string, unknown> = { command, messageId };
  if (command === "press") {
    request.button = numberOption(values, "--button", 100);
  }
  const response = await observerCall(state.observerSocket, request);
  appendInvocation(
    state,
    command,
    {
      messageId,
      ...(request.button === undefined ? {} : { button: request.button }),
    },
    response.cursor,
  );
  return response;
}

async function runDesktopActions(
  state: ActiveSession,
  values: Map<string, string>,
  roots: Roots,
): Promise<Record<string, unknown>> {
  const actions = readPublicFile(
    roots.outputRoot,
    required(values, "--actions-file"),
    "--actions-file",
    64 * 1024,
  );
  if (!actions.text.trim()) {
    throw new Error("--actions-file must not be empty.");
  }
  const timeoutSeconds = values.has("--timeout-seconds")
    ? numberOption(values, "--timeout-seconds", 300, 1)
    : 60;
  const privateActions = path.join(
    state.privateDir,
    `desktop-actions-${state.invocations.length + 1}.json`,
  );
  fs.mkdirSync(state.privateDir, { recursive: true });
  fs.writeFileSync(privateActions, actions.text, { mode: 0o640 });
  const actionsSha256 = createHash("sha256").update(actions.text).digest("hex");
  appendInvocation(state, "desktop", {
    actionsFile: actions.relative,
    actionsSha256,
    timeoutSeconds,
  });
  saveActive(roots.sessionRoot, state);
  const result = z
    .object({
      results: z.array(z.object({ command: z.string(), stderr: z.string(), stdout: z.string() })),
    })
    .parse(
      JSON.parse(
        await runCommandOutput(requiredEnv("OPENCLAW_TELEGRAM_DESKTOP_RECORDER_CMD"), [
          "actions",
          "--session",
          recorderRelativePath(state.recorderSession),
          "--actions-file",
          recorderRelativePath(privateActions),
          "--timeout-seconds",
          String(timeoutSeconds),
        ]),
      ),
    );
  return { ...result, actionsSha256 };
}

function readExecCommand(values: Map<string, string>, outputRoot: string): string {
  const direct = values.get("--command");
  const commandFile = values.get("--command-file");
  if ((direct === undefined) === (commandFile === undefined)) {
    throw new Error("exec needs exactly one of --command or --command-file.");
  }
  const command =
    commandFile !== undefined
      ? readPublicFile(outputRoot, commandFile, "--command-file", MAX_EXEC_COMMAND_BYTES).text
      : (direct ?? "");
  const bytes = Buffer.byteLength(command);
  if (bytes < 1 || bytes > MAX_EXEC_COMMAND_BYTES) {
    throw new Error(`exec command must contain 1 to ${MAX_EXEC_COMMAND_BYTES} bytes.`);
  }
  return command;
}

async function runSutExec(
  state: ActiveSession,
  values: Map<string, string>,
  roots: Roots,
  sutToken: string,
): Promise<Record<string, unknown>> {
  const command = readExecCommand(values, roots.outputRoot);
  const timeoutSeconds = values.has("--timeout-seconds")
    ? numberOption(values, "--timeout-seconds", 1_800, 1)
    : 120;
  const result = await execMantisSut(state.sut, command, timeoutSeconds);
  const redactedCommand = redactSutValue(command, sutToken) as string;
  appendInvocation(state, "exec", { command: redactedCommand, timeoutSeconds }, undefined, {
    exitCode: result.exitCode,
    stderrBytes: result.stderrBytes,
    stdoutBytes: result.stdoutBytes,
  });
  return redactSutValue(
    {
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
      truncated: result.truncated,
    },
    sutToken,
  ) as Record<string, unknown>;
}

function restartSutGateway(
  state: ActiveSession,
  values: Map<string, string>,
  roots: Roots,
): Record<string, unknown> {
  const readyTimeoutSeconds = values.has("--ready-timeout-seconds")
    ? numberOption(values, "--ready-timeout-seconds", 120, 5)
    : 60;
  const restartedAt = new Date().toISOString();
  const startedAt = Date.now();
  const previousGeneration = readReadyMantisLifecycleGeneration(state.sut.lifecycleEvidence);
  let successorGeneration: number;
  let requestId: string;
  try {
    const result = runMantisSutLifecycleAction({
      containerName: state.sut.containerName,
      expectedGeneration: previousGeneration,
      lifecycleEvidence: state.sut.lifecycleEvidence,
      mode: "graceful",
      readinessTimeoutSeconds: readyTimeoutSeconds,
      runtimeRoot: state.sut.tempRoot,
    });
    successorGeneration = result.generation;
    requestId = result.requestId;
  } catch (error) {
    appendInvocation(state, "restart", {
      previousGeneration,
      readyAfterMs: Date.now() - startedAt,
      readyTimeoutSeconds,
      status: "failed",
    });
    saveActive(roots.sessionRoot, state);
    throw error;
  }
  const readyAfterMs = Date.now() - startedAt;
  appendInvocation(state, "restart", {
    previousGeneration,
    readyAfterMs,
    readyTimeoutSeconds,
    requestId,
    successorGeneration,
  });
  return { readyAfterMs, restartedAt, status: "ready" };
}

async function focusMessage(state: ActiveSession, messageId: string): Promise<void> {
  if (!/^\d+$/u.test(messageId) || BigInt(messageId) < 1n) {
    throw new Error("--message-id must be a positive Telegram server message id.");
  }
  const timeline = await observerCall(state.observerSocket, {
    command: "events",
    seconds: 0,
    since: 0,
  });
  const observed = Array.isArray(timeline.events)
    ? timeline.events.some(
        (event) =>
          event !== null &&
          typeof event === "object" &&
          "messageId" in event &&
          event.messageId === messageId &&
          "actor" in event &&
          (event.actor === "user" || event.actor === "bot"),
      )
    : false;
  if (!observed) {
    throw new Error(`Message ${messageId} was not observed in this proof session.`);
  }
  await runCommand(requiredEnv("OPENCLAW_TELEGRAM_DESKTOP_RECORDER_CMD"), [
    "view",
    "--session",
    recorderRelativePath(state.recorderSession),
    "--message-id",
    messageId,
  ]);
  state.lastViewedMessageId = messageId;
  appendInvocation(state, "view", { messageId }, timeline.cursor);
}

async function screenshot(
  state: ActiveSession,
  outputRoot: string,
): Promise<ReturnType<typeof artifact> & { publicFile: string }> {
  const output = path.join(
    state.privateDir,
    `telegram-desktop-screenshot-${state.invocations.length + 1}.png`,
  );
  await runCommand(requiredEnv("OPENCLAW_TELEGRAM_DESKTOP_RECORDER_CMD"), [
    "screenshot",
    "--session",
    recorderRelativePath(state.recorderSession),
    "--output",
    recorderRelativePath(output),
  ]);
  validateMedia(output);
  const publicFile = path.join(
    outputRoot,
    state.lane,
    `inspection-${state.invocations.length + 1}.png`,
  );
  fs.mkdirSync(path.dirname(publicFile), { recursive: true });
  fs.copyFileSync(output, publicFile);
  state.inspectionScreenshots.push(output);
  appendInvocation(state, "screenshot", { afterMessageId: state.lastViewedMessageId });
  return { ...artifact(output), publicFile };
}

function copyArtifacts(
  files: Record<string, string>,
  privatePublished: string,
  publicOutput: string,
  attempt: number,
): Record<string, ReturnType<typeof artifact>> {
  fs.mkdirSync(privatePublished, { recursive: true });
  fs.mkdirSync(publicOutput, { recursive: true });
  const result: Record<string, ReturnType<typeof artifact>> = {};
  for (const [name, source] of Object.entries(files)) {
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      continue;
    }
    const filename = `attempt-${attempt}-${path.basename(source)}`;
    const privateTarget = path.join(privatePublished, filename);
    fs.copyFileSync(source, privateTarget);
    fs.copyFileSync(source, path.join(publicOutput, filename));
    result[name] = artifact(privateTarget);
  }
  return result;
}

export function publishableRecorderArtifacts(
  files: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).filter(
      ([name]) =>
        name === "previewGifCropped" ||
        name === "screenshot" ||
        name === "trimmedVideoCropped" ||
        /^inspection\d+$/u.test(name),
    ),
  );
}

async function stopActiveLane(
  state: ActiveSession,
  secret: string,
  crop: boolean,
): Promise<{
  botApiRequests: unknown[];
  cleanupErrors: string[];
  cursor?: number;
  events: unknown[];
  evidenceErrors: unknown[];
  lifecycleEvents: unknown[];
  requests: unknown[];
  truncated: boolean;
}> {
  const cleanupErrors: string[] = [];
  const evidenceErrors: unknown[] = [];
  let cursor: number | undefined;
  let recordedBotApiRequests: unknown[] = [];
  let events: unknown[] = [];
  let lifecycleEvents: unknown[] = [];
  let requests: unknown[] = [];
  let truncated = false;
  try {
    const response = await observerCall(state.observerSocket, {
      command: "events",
      seconds: crop ? 1 : 0,
      since: 0,
    });
    cursor = response.cursor;
    events = Array.isArray(response.events) ? response.events : [];
    truncated = response.truncated === true;
  } catch (error) {
    evidenceErrors.push(error);
  }
  try {
    await observerCall(state.observerSocket, { command: "shutdown", settleSeconds: 0 });
  } catch (error) {
    evidenceErrors.push(error);
  }
  await sleep(100);
  const observerCleanupError = await terminateObserverProcess(
    state.observerPidFile,
    state.observerSocket,
  );
  if (observerCleanupError) {
    cleanupErrors.push(observerCleanupError);
  }
  try {
    requests = providerRequests(state, secret);
  } catch (error) {
    evidenceErrors.push(error);
  }
  try {
    recordedBotApiRequests = botApiRequests(state, secret);
  } catch (error) {
    evidenceErrors.push(error);
  }
  // Recorder export and SUT teardown are independent; start export before the
  // synchronous container calls so both cleanup paths make progress together.
  const finalSendAt = state.invocations.findLast((invocation) => invocation.command === "send")?.at;
  const recorderStop = runCommand(requiredEnv("OPENCLAW_TELEGRAM_DESKTOP_RECORDER_CMD"), [
    "stop",
    "--session",
    recorderRelativePath(state.recorderSession),
    ...(crop ? ["--crop", "telegram-window"] : []),
    ...(crop && finalSendAt ? ["--since", finalSendAt] : []),
  ]);
  cleanupErrors.push(...teardownSut(state.sut, state.privateDir));
  try {
    lifecycleEvents = readMantisLifecycleEvidence(
      path.join(state.privateDir, path.basename(state.sut.lifecycleEvidence)),
    );
  } catch (error) {
    evidenceErrors.push(error);
  }
  try {
    await recorderStop;
  } catch (error) {
    cleanupErrors.push(coerceErrorMessage(error));
  }
  return {
    botApiRequests: recordedBotApiRequests,
    cleanupErrors,
    cursor,
    events,
    evidenceErrors,
    lifecycleEvents,
    requests,
    truncated,
  };
}

async function finalize(
  state: ActiveSession,
  roots: Roots,
  options: {
    blocked?: { name?: string; reason: string };
    focusMessageId?: string;
  },
): Promise<void> {
  let primaryError: unknown;
  let secret = "";
  try {
    secret = credentialSchema.parse(readJson(roots.credentialFile)).sutToken;
  } catch (error) {
    primaryError ??= error;
  }
  const cleanupErrors: string[] = [];
  const focusMessageId = options.focusMessageId ?? state.lastViewedMessageId;
  try {
    if (focusMessageId) {
      await focusMessage(state, focusMessageId);
    }
  } catch (error) {
    primaryError ??= error;
  }
  const stopped = await stopActiveLane(state, secret, true);
  primaryError ??= stopped.evidenceErrors[0];
  cleanupErrors.push(...stopped.cleanupErrors);
  appendInvocation(state, "finish", { focusMessageId }, stopped.cursor);

  let recorderArtifacts: Record<string, string> = {};
  try {
    recorderArtifacts = recorderArtifactsSchema.parse(
      JSON.parse(
        await runCommandOutput(requiredEnv("OPENCLAW_TELEGRAM_DESKTOP_RECORDER_CMD"), [
          "artifacts",
          "--session",
          recorderRelativePath(state.recorderSession),
        ]),
      ),
    ).artifacts;
  } catch (error) {
    primaryError ??= error;
  }
  recorderArtifacts = {
    ...recorderArtifacts,
    ...Object.fromEntries(
      state.inspectionScreenshots.map((file, index) => [`inspection${index + 1}`, file]),
    ),
  };
  if (!options.blocked && !primaryError) {
    if (state.sendCount < 1) {
      primaryError ??= new Error("The session did not send a Telegram message.");
    }
    if (!state.lastViewedMessageId) {
      primaryError ??= new Error("The session did not focus the evaluated message.");
    }
    for (const name of ["screenshot", "previewGifCropped", "trimmedVideoCropped"] as const) {
      const file = recorderArtifacts[name];
      if (!file) {
        primaryError ??= new Error(`Recorder did not produce ${name}.`);
      } else {
        try {
          validateMedia(file);
        } catch (error) {
          primaryError ??= error;
        }
      }
    }
  }

  const privatePublished = path.join(roots.sessionRoot, "published", state.lane);
  const publicOutput = path.join(roots.outputRoot, state.lane);
  let artifactRecords: Record<string, ReturnType<typeof artifact>> = {};
  try {
    artifactRecords = copyArtifacts(
      publishableRecorderArtifacts(recorderArtifacts),
      privatePublished,
      publicOutput,
      state.attempt,
    );
  } catch (error) {
    primaryError ??= error;
  }
  const status =
    primaryError || cleanupErrors.length ? "infra-error" : options.blocked ? "blocked" : "complete";
  const factsRaw = {
    artifacts: artifactRecords,
    attempt: state.attempt,
    botApiRequests: stopped.botApiRequests,
    blocked: options.blocked,
    cleanupErrors: cleanupErrors.map((entry) => redact(entry, secret)),
    completedAt: new Date().toISOString(),
    error: primaryError ? redact(coerceErrorMessage(primaryError), secret) : undefined,
    focusMessageId: state.lastViewedMessageId,
    invocations: state.invocations,
    lane: state.lane,
    lifecycleEvents: stopped.lifecycleEvents,
    observation: {
      cursor: state.lastCursor,
      events: stopped.events,
      observedSeconds: state.observeSeconds,
      truncated: stopped.truncated,
      uptimeMs: Date.now() - Date.parse(state.startedAt),
    },
    providerRequests: stopped.requests,
    schemaVersion: 2,
    sendCount: state.sendCount,
    startedAt: state.startedAt,
    status,
    sutAttestation: state.sut.sutAttestation,
  };
  const facts = redact(factsRaw, secret) as typeof factsRaw;
  publishTerminalLaneFacts({
    artifacts: artifactRecords,
    attempt: state.attempt,
    facts,
    lane: state.lane,
    roots,
    status: status === "complete" ? "pass" : status === "blocked" ? "blocked" : "fail",
    sutAttestation: state.sut.sutAttestation,
  });
  fs.rmSync(activeFile(roots.sessionRoot, state.lane), { force: true });
  fs.rmSync(startupFile(roots.sessionRoot, state.lane), { force: true });
  outputJson({ attempt: state.attempt, lane: state.lane, status });
  if (status === "infra-error") {
    process.exitCode = 1;
  }
}

async function abort(state: ActiveSession, roots: Roots): Promise<void> {
  let secret = "";
  const errors: string[] = [];
  try {
    secret = credentialSchema.parse(readJson(roots.credentialFile)).sutToken;
  } catch (error) {
    errors.push(coerceErrorMessage(error));
  }
  const stopped = await stopActiveLane(state, secret, false);
  errors.push(
    ...stopped.evidenceErrors.map((error) => coerceErrorMessage(error)),
    ...stopped.cleanupErrors,
  );
  appendInvocation(state, "abort", {}, stopped.cursor);
  let recorderArtifacts: Record<string, string> = {};
  try {
    if (fs.existsSync(state.recorderSession)) {
      recorderArtifacts = recorderArtifactsSchema.parse(
        JSON.parse(
          await runCommandOutput(requiredEnv("OPENCLAW_TELEGRAM_DESKTOP_RECORDER_CMD"), [
            "artifacts",
            "--session",
            recorderRelativePath(state.recorderSession),
          ]),
        ),
      ).artifacts;
    }
    Object.assign(
      recorderArtifacts,
      Object.fromEntries(
        state.inspectionScreenshots.map((file, index) => [`inspection${index + 1}`, file]),
      ),
    );
  } catch (error) {
    errors.push(coerceErrorMessage(error));
  }
  const privatePublished = path.join(roots.sessionRoot, "published", state.lane);
  const publicOutput = path.join(roots.outputRoot, state.lane);
  let artifactRecords: Record<string, ReturnType<typeof artifact>> = {};
  try {
    artifactRecords = copyArtifacts(
      publishableRecorderArtifacts(recorderArtifacts),
      privatePublished,
      publicOutput,
      state.attempt,
    );
  } catch (error) {
    errors.push(coerceErrorMessage(error));
  }
  const status = errors.length ? "infra-error" : "aborted";
  const facts = redact(
    {
      artifacts: artifactRecords,
      attempt: state.attempt,
      botApiRequests: stopped.botApiRequests,
      cleanupErrors: errors,
      completedAt: new Date().toISOString(),
      invocations: state.invocations,
      lane: state.lane,
      lifecycleEvents: stopped.lifecycleEvents,
      observation: {
        cursor: state.lastCursor,
        events: stopped.events,
        observedSeconds: state.observeSeconds,
        truncated: stopped.truncated,
      },
      providerRequests: stopped.requests,
      schemaVersion: 2,
      sendCount: state.sendCount,
      startedAt: state.startedAt,
      status,
      sutAttestation: state.sut.sutAttestation,
    },
    secret,
  );
  publishTerminalLaneFacts({
    artifacts: artifactRecords,
    attempt: state.attempt,
    facts,
    lane: state.lane,
    roots,
    status: "fail",
    sutAttestation: state.sut.sutAttestation,
  });
  fs.rmSync(activeFile(roots.sessionRoot, state.lane), { force: true });
  fs.rmSync(startupFile(roots.sessionRoot, state.lane), { force: true });
  outputJson({ errors, lane: state.lane, status });
  if (errors.length) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (["--help", "-h"].includes(process.argv[2] ?? "")) {
    console.log(usageText());
    return;
  }
  const cli = parseCli(process.argv.slice(2));
  const roots: Roots = {
    credentialFile: requiredEnv("OPENCLAW_MANTIS_CREDENTIAL_FILE"),
    outputRoot: path.resolve(requiredEnv("OPENCLAW_MANTIS_OUTPUT_ROOT")),
    sessionRoot: path.resolve(requiredEnv("OPENCLAW_MANTIS_SESSION_ROOT")),
  };
  fs.mkdirSync(roots.outputRoot, { recursive: true });
  fs.mkdirSync(roots.sessionRoot, { recursive: true });
  const lane = laneFrom(cli.values);
  const releaseLock = acquireHarnessLock(roots.sessionRoot);
  try {
    if (cli.command === "start") {
      await startLane(cli.values, roots);
      return;
    }
    if (
      cli.command === "abort" &&
      !fs.existsSync(activeFile(roots.sessionRoot, lane)) &&
      fs.existsSync(startupFile(roots.sessionRoot, lane))
    ) {
      await abortStartup(readStartup(roots.sessionRoot, lane), roots);
      return;
    }
    const state = readActive(roots.sessionRoot, lane);
    const credential = credentialSchema.parse(readJson(roots.credentialFile));
    if (cli.command === "mock") {
      outputJson(updateMockResponse(state, cli.values, roots.outputRoot));
    } else if (cli.command === "botapi-fail") {
      outputJson(updateBotApiFault(state, cli.values));
    } else if (cli.command === "botapi-clear") {
      outputJson(clearBotApiFaults(state));
    } else if (cli.command === "botapi-requests") {
      const method = cli.values.has("--method")
        ? requireBotApiMethod(required(cli.values, "--method"))
        : undefined;
      const limit = cli.values.has("--limit") ? numberOption(cli.values, "--limit", 100, 1) : 100;
      const requests = botApiRequests(state, credential.sutToken, { limit, method });
      appendInvocation(state, "botapi-requests", { count: requests.length, limit, method });
      outputJson({ count: requests.length, requests });
    } else if (cli.command === "desktop") {
      outputJson(await runDesktopActions(state, cli.values, roots));
    } else if (cli.command === "exec") {
      outputJson(await runSutExec(state, cli.values, roots, credential.sutToken));
    } else if (cli.command === "restart") {
      outputJson(restartSutGateway(state, cli.values, roots));
    } else if (cli.command === "lifecycle") {
      outputJson(runGatewayLifecycle(state, cli.values));
    } else if (cli.command === "send") {
      const sent = await sendVisibleMessage(state, cli.values, roots, credential.sutToken);
      outputJson({ ...sent.response, revealedMessageId: sent.revealedMessageId });
    } else if (cli.command === "turn") {
      const sent = await sendVisibleMessage(state, cli.values, roots, credential.sutToken);
      cli.values.set("--seconds", cli.values.get("--observe-seconds") ?? "15");
      outputJson({
        sent: { ...sent.response, revealedMessageId: sent.revealedMessageId },
        observed: await observe(state, cli.values, credential.sutToken),
      });
    } else if (cli.command === "observe") {
      outputJson(await observe(state, cli.values, credential.sutToken));
    } else if (cli.command === "requests") {
      const requests = providerRequests(state, credential.sutToken);
      appendInvocation(state, "requests", { count: requests.length });
      outputJson({ count: requests.length, requests });
    } else if (cli.command === "view") {
      await focusMessage(state, required(cli.values, "--message-id"));
      outputJson({ messageId: state.lastViewedMessageId, status: "focused" });
    } else if (cli.command === "screenshot") {
      outputJson(await screenshot(state, roots.outputRoot));
    } else if (["delete", "press"].includes(cli.command)) {
      outputJson(await observerAction(state, cli.command as "delete" | "press", cli.values));
    } else if (cli.command === "finish") {
      await finalize(state, roots, {
        focusMessageId: cli.values.get("--focus-message-id"),
      });
      return;
    } else if (cli.command === "block") {
      await finalize(state, roots, {
        blocked: {
          name: cli.values.get("--missing-primitive"),
          reason: required(cli.values, "--reason"),
        },
      });
      return;
    } else if (cli.command === "abort") {
      await abort(state, roots);
      return;
    } else {
      throw new Error(usageText());
    }
    saveActive(roots.sessionRoot, state);
  } finally {
    releaseLock();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(coerceErrorMessage(error));
    process.exitCode = 1;
  });
}
