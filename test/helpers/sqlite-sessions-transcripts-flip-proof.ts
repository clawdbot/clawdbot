// SQLite sessions/transcripts flip proof runner exercises an isolated live gateway lifecycle.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readSessionArchiveContentSync,
  stripSessionArchiveCompressionSuffix,
} from "../../src/config/sessions/archive-compression.js";
import { formatSqliteSessionFileMarker } from "../../src/config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  type TranscriptEvent,
} from "../../src/config/sessions/session-accessor.js";
import { importSqliteSessionRows } from "../../src/config/sessions/session-accessor.sqlite-import.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../src/gateway/test-helpers.e2e.js";
import { listKnownProviderAuthEnvVarNames } from "../../src/secrets/provider-env-vars.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
} from "../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../src/state/openclaw-state-db.js";
import { sleep } from "../../src/utils.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";

type DoctorMode = "fix" | "import" | "inspect" | "validate" | "restore";
type ProofChildProcess = ChildProcessByStdio<null, Readable, Readable>;

const SQLITE_FLIP_PROOF_OPERATION_TIMEOUT_MS = 60_000;

type DoctorCommandEvidence = Awaited<ReturnType<typeof runDoctor>>;

type FileInventoryEntry = Awaited<ReturnType<typeof inventoryFile>>;

type ProofCheckpoint = Awaited<ReturnType<typeof captureCheckpoint>>;
type ScaleMigrationEvidence = ReturnType<typeof requireScaleMigrationProof>;
type DowngradeReupgradeEvidence = Awaited<ReturnType<typeof runDowngradeReupgradeProof>>;
type BusyContentionEvidence = Awaited<ReturnType<typeof runSqliteBusyContentionProof>>;
type SecondStartupAfterResetEvidence = Awaited<ReturnType<typeof runSecondStartupAfterResetProof>>;
type RollbackRestoreEvidence = Awaited<ReturnType<typeof runRollbackRestoreProof>>;
type StartupRefusalEvidence = Awaited<ReturnType<typeof requireLegacyStartupRefusal>>;

type ProofContext = ReturnType<typeof buildProofContext>;
type GatewayClient = Awaited<ReturnType<typeof connectGatewayClient>>;
type OpenClawTestInstance = Awaited<ReturnType<typeof createOpenClawTestInstance>>;

type RunOptions = {
  print?: boolean;
  requireBuiltCli?: boolean;
};

const AGENT_ID = "main";
const RESET_SESSION_KEY = "agent:main:main";
const DELETE_SESSION_KEY = "agent:main:dashboard:sqlite-delete";
const CONCURRENT_SEND_SESSION_KEY = "agent:main:dashboard:sqlite-concurrent-send";
const CONCURRENT_RESET_SESSION_KEY = "agent:main:dashboard:sqlite-concurrent-reset";
const CONCURRENT_DELETE_SESSION_KEY = "agent:main:dashboard:sqlite-concurrent-delete";
const CONCURRENT_SEND_TEXT = "sqlite concurrent send history reset";
const CONCURRENT_DELETE_TEXT = "sqlite concurrent delete while send is active";
const FULL_TURN_ASSISTANT_TEXT = "OPENCLAW_E2E_OK_12";
const FULL_TURN_SESSION_KEY = "agent:main:sqlite-full-turn";
const DOWNGRADE_REUPGRADE_SESSION_ID = "sqlite-downgrade-reupgrade";
const DOWNGRADE_REUPGRADE_SESSION_KEY = "agent:main:dashboard:sqlite-downgrade-reupgrade";
const DOWNGRADE_REUPGRADE_TEXT = "sqlite downgrade wrote file-backed state";
const SQLITE_BUSY_SESSION_ID = "sqlite-busy-contention";
const SQLITE_BUSY_SESSION_KEY = "agent:main:dashboard:sqlite-busy-contention";
const SQLITE_BUSY_TEXT = "sqlite busy writer contention";
const SECOND_STARTUP_APPEND_TEXT = "sqlite appended after reset and restart";
const SCALE_SESSION_COUNT = 24;
const SCALE_EVENTS_PER_SESSION = 4;
const SCALE_SESSION_KEYS = Array.from(
  { length: SCALE_SESSION_COUNT },
  (_, index) => `agent:main:dashboard:sqlite-scale-${String(index + 1).padStart(2, "0")}`,
);
const SHARED_SESSION_KEYS = [
  "agent:main:dashboard:sqlite-shared-a",
  "agent:main:dashboard:sqlite-shared-b",
] as const;
const OLD_STATE_SESSION_KEYS = [
  "agent:main:+15551234567",
  "agent:main:partial-direct",
  "agent:main:unknown:group:legacy-room",
] as const;

/** Runs the isolated live gateway SQLite flip proof and returns structured evidence. */
export async function runSqliteSessionsTranscriptsFlipProof(options: RunOptions = {}) {
  const print = options.print ?? false;
  const mockOpenAiPort = await getFreeTcpPort();
  const inst = await createOpenClawTestInstance({
    name: `sqlite-sessions-transcripts-flip-${randomUUID()}`,
    config: buildMockOpenAiConfig(mockOpenAiPort),
    env: {
      ...Object.fromEntries(listKnownProviderAuthEnvVarNames().map((name) => [name, undefined])),
      ALL_PROXY: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      NO_PROXY: "127.0.0.1,localhost",
      ...(options.requireBuiltCli !== true
        ? {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          }
        : {}),
      OPENAI_API_KEY: "sk-openclaw-e2e-mock",
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      no_proxy: "127.0.0.1,localhost",
    },
    startTimeoutMs: 90_000,
    stopTimeoutMs: 3_000,
  });
  // Doctor commands and the gateway must resolve the same isolated database.
  inst.state.applyEnv();
  const context = buildProofContext(inst.stateDir);
  const checkpoints: ProofCheckpoint[] = [];
  const failures: string[] = [];
  let bundledPlugins: Array<{ id: string; source: string }> = [];
  let gatewayEntrypoint: string[] = [];
  let busyContention: BusyContentionEvidence | undefined;
  let downgradeReupgrade: DowngradeReupgradeEvidence | undefined;
  let mockOpenAi: ProofChildProcess | undefined;
  let rollbackRestore: RollbackRestoreEvidence | undefined;
  let scaleMigration: ScaleMigrationEvidence | undefined;
  let secondStartupAfterReset: SecondStartupAfterResetEvidence | undefined;
  let startupRefusal: StartupRefusalEvidence | undefined;

  const record = async (label: string, doctor?: DoctorCommandEvidence) => {
    const checkpoint = await captureCheckpoint(context, label, {
      doctor,
      gatewayLogTail: inst.logs(),
    });
    checkpoints.push(checkpoint);
    validateCheckpointInvariants(context, checkpoint, failures);
    if (print) {
      printCheckpoint(checkpoint);
    }
    return checkpoint;
  };

  try {
    gatewayEntrypoint = await inst.entrypoint();
    if (options.requireBuiltCli === true && !isBuiltCliEntrypoint(gatewayEntrypoint)) {
      throw new Error(`expected built CLI entrypoint, got ${gatewayEntrypoint.join(" ")}`);
    }
    if (options.requireBuiltCli === true) {
      const inventory = await inst.cli(["plugins", "list", "--json"]);
      const plugins = parseJsonObject(inventory.stdout)?.plugins;
      if (inventory.code !== 0 || !Array.isArray(plugins)) {
        throw new Error("built CLI could not list bundled plugin artifacts");
      }
      bundledPlugins = plugins.flatMap((value) => {
        const plugin = asRecord(value);
        if (plugin?.origin !== "bundled") {
          return [];
        }
        if (typeof plugin.id !== "string" || typeof plugin.source !== "string") {
          throw new Error("bundled plugin inventory omitted its identity or source artifact");
        }
        return [{ id: plugin.id, source: plugin.source }];
      });
    }

    mockOpenAi = await startMockOpenAiServer({
      port: mockOpenAiPort,
      requestLogPath: context.mockOpenAiRequestLog,
      responseText: context.fullTurnAssistantText,
    });

    await seedLegacySessionStore(context);
    await record("seeded-legacy-store");

    startupRefusal = await requireLegacyStartupRefusal(inst, context);
    await record("after-startup-refusal");

    const doctorImportStartedAt = Date.now();
    const fixDoctor = await runDoctor(inst, "fix", context.storePath);
    await record("after-doctor-fix", fixDoctor);
    scaleMigration = requireScaleMigrationProof(context, Date.now() - doctorImportStartedAt);

    await inst.startGateway();
    await record("after-gateway-start");

    const inspectDoctor = await runDoctor(inst, "inspect", context.storePath);
    await record("after-doctor-inspect", inspectDoctor);

    const validateDoctor = await runDoctor(inst, "validate", context.storePath);
    await record("after-doctor-validate", validateDoctor);

    const client = await connectProofClient(inst, "sqlite-sessions-transcripts-flip-proof");
    try {
      await waitForHistoryContains(client, context.resetSessionKey, "legacy hello");
    } finally {
      await disconnectGatewayClient(client);
    }

    await inst.stopGateway();
    // Destructive Doctor maintenance owns the stopped Gateway epoch; inspect/validate stay live.
    rollbackRestore = await runRollbackRestoreProof(inst, context);
    await record("after-rollback-restore");
    await inst.startGateway();
    await record("after-gateway-restart");

    let restartedClient = await connectProofClient(
      inst,
      "sqlite-sessions-transcripts-flip-proof-restart",
    );
    let restartedClientConnected = true;
    try {
      await waitForHistoryContains(restartedClient, context.resetSessionKey, "legacy hello");
      const resetPreludeRunId = await sendGatewayUserMessage(
        restartedClient,
        context.resetSessionKey,
        "sqlite user-facing send before reset",
      );
      await waitForAgentRunOk(restartedClient, resetPreludeRunId);
      await waitForSqliteMessageContains(
        context.agentDbPath,
        context.legacySessionId,
        "user",
        "sqlite user-facing send before reset",
      );
      await record("after-chat-send");

      const fullTurnRunId = await sendGatewayUserMessage(
        restartedClient,
        context.fullTurnSessionKey,
        `Reply with exactly ${context.fullTurnAssistantText}.`,
      );
      await waitForAgentRunOk(restartedClient, fullTurnRunId);
      const fullTurnSessionId = await waitForSqliteSessionId(
        context.agentDbPath,
        context.fullTurnSessionKey,
      );
      await waitForSqliteMessageContains(
        context.agentDbPath,
        fullTurnSessionId,
        "user",
        context.fullTurnAssistantText,
      );
      await waitForSqliteMessageContains(
        context.agentDbPath,
        fullTurnSessionId,
        "assistant",
        context.fullTurnAssistantText,
      );
      await waitForHistoryRoleContains(
        restartedClient,
        context.fullTurnSessionKey,
        "assistant",
        context.fullTurnAssistantText,
      );
      await requireMockOpenAiRequest(context.mockOpenAiRequestLog);
      await record("after-full-agent-turn");

      await disconnectGatewayClient(restartedClient);
      restartedClientConnected = false;
      await inst.stopGateway();
      const idempotentImportDoctor = await runDoctorIdempotenceProof(inst, context);
      await record("after-doctor-import-idempotence", idempotentImportDoctor);

      downgradeReupgrade = await runDowngradeReupgradeProof(inst, context);
      await record("after-downgrade-reupgrade-import");

      busyContention = await runSqliteBusyContentionProof(context);
      await record("after-sqlite-busy-contention");

      await inst.startGateway();
      restartedClient = await connectProofClient(
        inst,
        "sqlite-sessions-transcripts-flip-proof-maintained",
      );
      restartedClientConnected = true;
      await runConcurrentMultiClientLifecycle(inst, context, restartedClient);
      await record("after-concurrent-multi-client");

      const resetSessionId = await resetSession(restartedClient, context.resetSessionKey);
      await record("after-sessions-reset");

      await disconnectGatewayClient(restartedClient);
      restartedClientConnected = false;
      await inst.stopGateway();
      await inst.startGateway();
      await record("after-second-startup-after-reset");

      const postResetClient = await connectProofClient(
        inst,
        "sqlite-sessions-transcripts-flip-proof-post-reset-restart",
      );
      try {
        secondStartupAfterReset = await runSecondStartupAfterResetProof(
          postResetClient,
          context,
          resetSessionId,
        );
        await record("after-transcript-append");

        await deleteSession(postResetClient, context.deleteSessionKey);
        await record("after-sessions-delete");

        const firstSharedSessionKey = expectDefined(
          context.sharedSessionKeys[0],
          "first shared SQLite proof session key",
        );
        const secondSharedSessionKey = expectDefined(
          context.sharedSessionKeys[1],
          "second shared SQLite proof session key",
        );
        await deleteSession(postResetClient, firstSharedSessionKey);
        await requireTrackedSession(postResetClient, secondSharedSessionKey);
        await record("after-shared-first-delete");

        await deleteSession(postResetClient, secondSharedSessionKey);
        await record("after-shared-final-delete");
      } finally {
        await disconnectGatewayClient(postResetClient);
      }
    } finally {
      if (restartedClientConnected) {
        await disconnectGatewayClient(restartedClient);
      }
    }

    const finalInspectDoctor = await runDoctor(inst, "inspect", context.storePath);
    await record("after-final-doctor-inspect", finalInspectDoctor);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${message}\nGateway diagnostics:\n${tail(inst.logs(), 6_000)}`);
    await record("failure");
  } finally {
    await stopChildProcess(mockOpenAi);
    await inst.stopGateway();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await inst.cleanup();
  }

  const report = {
    ok: failures.length === 0,
    agentId: context.agentId,
    bundledPlugins,
    checkpoints,
    concurrentDeleteSessionKey: context.concurrentDeleteSessionKey,
    concurrentResetSessionKey: context.concurrentResetSessionKey,
    concurrentSendSessionKey: context.concurrentSendSessionKey,
    deleteSessionKey: context.deleteSessionKey,
    failures,
    fullTurnAssistantText: context.fullTurnAssistantText,
    fullTurnSessionKey: context.fullTurnSessionKey,
    gatewayEntrypoint,
    legacySessionId: context.legacySessionId,
    mockOpenAiRequestLog: context.mockOpenAiRequestLog,
    oldStateSessionKeys: [...context.oldStateSessionKeys],
    resetSessionKey: context.resetSessionKey,
    ...(rollbackRestore ? { rollbackRestore } : {}),
    ...(busyContention ? { busyContention } : {}),
    ...(downgradeReupgrade ? { downgradeReupgrade } : {}),
    ...(scaleMigration ? { scaleMigration } : {}),
    ...(secondStartupAfterReset ? { secondStartupAfterReset } : {}),
    ...(startupRefusal ? { startupRefusal } : {}),
    sharedSessionKeys: [...context.sharedSessionKeys],
    stateDir: context.stateDir,
  };
  if (print) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function isBuiltCliEntrypoint(entrypoint: readonly string[]): boolean {
  const [first, ...rest] = entrypoint;
  return rest.length === 0 && (first === "dist/index.js" || first === "dist/index.mjs");
}

function buildProofContext(stateDir: string) {
  const agentDir = path.join(stateDir, "agents", AGENT_ID);
  const activeSessionsDir = path.join(agentDir, "sessions");
  const legacySessionsDir = path.join(stateDir, "sessions");
  return {
    activeSessionsDir,
    agentDbPath: path.join(agentDir, "agent", "openclaw-agent.sqlite"),
    agentId: AGENT_ID,
    archiveRoots: [path.join(agentDir, "session-sqlite-import-archive"), activeSessionsDir],
    concurrentDeleteSessionKey: CONCURRENT_DELETE_SESSION_KEY,
    concurrentResetSessionKey: CONCURRENT_RESET_SESSION_KEY,
    concurrentSendSessionKey: CONCURRENT_SEND_SESSION_KEY,
    deleteSessionKey: DELETE_SESSION_KEY,
    fullTurnAssistantText: FULL_TURN_ASSISTANT_TEXT,
    fullTurnSessionKey: FULL_TURN_SESSION_KEY,
    legacySessionsDir,
    legacySessionId: "sqlite-legacy-main",
    mockOpenAiRequestLog: path.join(stateDir, "mock-openai-requests.ndjson"),
    oldStateSessionKeys: [...OLD_STATE_SESSION_KEYS],
    resetSessionKey: RESET_SESSION_KEY,
    sharedSessionKeys: [...SHARED_SESSION_KEYS],
    stateDir,
    storePath: path.join(activeSessionsDir, "sessions.json"),
    trackedSessionKeys: [
      RESET_SESSION_KEY,
      DELETE_SESSION_KEY,
      CONCURRENT_SEND_SESSION_KEY,
      CONCURRENT_RESET_SESSION_KEY,
      CONCURRENT_DELETE_SESSION_KEY,
      FULL_TURN_SESSION_KEY,
      DOWNGRADE_REUPGRADE_SESSION_KEY,
      SQLITE_BUSY_SESSION_KEY,
      ...SHARED_SESSION_KEYS,
      ...OLD_STATE_SESSION_KEYS,
      ...SCALE_SESSION_KEYS,
    ],
  };
}

function buildMockOpenAiConfig(mockPort: number): Record<string, unknown> {
  const modelRef = "openai/gpt-5.5";
  const modelId = "gpt-5.5";
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    agents: {
      defaults: {
        model: { primary: modelRef },
        modelPolicy: { allow: [modelRef] },
        models: {
          [modelRef]: {
            agentRuntime: { id: "openclaw" },
            params: { openaiWsWarmup: false, transport: "sse" },
          },
        },
      },
      entries: { main: {} },
    },
    gateway: { mode: "local" },
    models: {
      mode: "merge",
      providers: {
        openai: {
          agentRuntime: { id: "openclaw" },
          api: "openai-responses",
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          models: [
            {
              agentRuntime: { id: "openclaw" },
              api: "openai-responses",
              contextTokens: 96_000,
              contextWindow: 128_000,
              cost,
              id: modelId,
              input: ["text", "image"],
              maxTokens: 4_096,
              name: modelId,
              reasoning: false,
            },
          ],
          request: { allowPrivateNetwork: true },
        },
      },
    },
    plugins: { enabled: true },
  };
}

async function getFreeTcpPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  const addr = srv.address();
  if (!addr || typeof addr === "string") {
    srv.close();
    throw new Error("failed to bind ephemeral mock OpenAI port");
  }
  await new Promise<void>((resolve) => {
    srv.close(() => resolve());
  });
  return addr.port;
}

async function connectProofClient(
  inst: OpenClawTestInstance,
  clientDisplayName: string,
): Promise<GatewayClient> {
  return await connectGatewayClient({
    url: inst.url,
    token: inst.gatewayToken,
    clientDisplayName,
    requestTimeoutMs: SQLITE_FLIP_PROOF_OPERATION_TIMEOUT_MS,
    timeoutMs: SQLITE_FLIP_PROOF_OPERATION_TIMEOUT_MS,
  });
}

async function startMockOpenAiServer(params: {
  port: number;
  requestLogPath: string;
  responseText: string;
}): Promise<ProofChildProcess> {
  const child = spawn("node", ["scripts/e2e/mock-openai-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOCK_PORT: String(params.port),
      MOCK_REQUEST_LOG: params.requestLogPath,
      SUCCESS_MARKER: params.responseText,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const childOutput = captureChildOutput(child);
  const deadline = Date.now() + SQLITE_FLIP_PROOF_OPERATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `mock OpenAI exited before listening (code=${String(child.exitCode)} signal=${String(
          child.signalCode,
        )})\n${tail(childOutput())}`,
      );
    }
    if (childOutput().includes("mock-openai listening")) {
      return child;
    }
    await sleep(25);
  }
  await stopChildProcess(child);
  throw new Error(`timeout waiting for mock OpenAI server\n${tail(childOutput())}`);
}

function captureChildOutput(child: ProofChildProcess): () => string {
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += String(chunk);
    });
  }
  return () => output;
}

async function stopChildProcess(child: ProofChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      child.once("exit", () => resolve(true));
    }),
    sleep(2_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function seedLegacySessionStore(context: ProofContext): Promise<void> {
  await fs.mkdir(context.activeSessionsDir, { recursive: true });
  await fs.mkdir(context.legacySessionsDir, { recursive: true });
  await fs.mkdir(path.join(context.stateDir, "agent"), { recursive: true });
  const now = Date.now();
  const firstSharedSessionKey = expectDefined(
    context.sharedSessionKeys[0],
    "first legacy shared SQLite proof session key",
  );
  const secondSharedSessionKey = expectDefined(
    context.sharedSessionKeys[1],
    "second legacy shared SQLite proof session key",
  );
  const entries: Record<string, ReturnType<typeof legacyEntry>> = {
    [context.concurrentDeleteSessionKey]: legacyEntry("sqlite-concurrent-delete", now - 8_000),
    [context.concurrentResetSessionKey]: legacyEntry("sqlite-concurrent-reset", now - 9_000),
    [context.deleteSessionKey]: legacyEntry("sqlite-delete-session", now - 1_000),
    [firstSharedSessionKey]: legacyEntry("sqlite-shared-session", now - 2_000, {
      sessionFile: "sqlite-shared-a.jsonl",
    }),
    [secondSharedSessionKey]: legacyEntry("sqlite-shared-session", now - 3_000, {
      sessionFile: "sqlite-shared-b.jsonl",
    }),
  };
  const oldStateEntries = {
    main: legacyEntry(context.legacySessionId, now - 4_000),
    "+15551234567": legacyEntry("sqlite-old-direct", now - 5_000),
    "group:legacy-room": legacyEntry("sqlite-old-group", now - 6_000, {
      room: "legacy-room",
    }),
    "partial-direct": legacyEntry("sqlite-partial-import", now - 7_000),
  };
  for (const [index, sessionKey] of SCALE_SESSION_KEYS.entries()) {
    entries[sessionKey] = legacyEntry(scaleSessionId(index), now - 20_000 - index);
  }
  await writeJsonFile(context.storePath, entries, 2);
  await writeJsonFile(path.join(context.legacySessionsDir, "sessions.json"), oldStateEntries, 2);
  await writeJsonFile(path.join(context.stateDir, "agent", "old-settings.json"), {
    source: "old-agent-layout",
  });
  const legacyDir = context.legacySessionsDir;
  const activeDir = context.activeSessionsDir;
  await writeMessageTranscript(legacyDir, context.legacySessionId, "sqlite-user-1", "legacy hello");
  await writeMessageTranscript(legacyDir, "sqlite-old-direct", "sqlite-old-direct-1", "old dm");
  await writeMessageTranscript(legacyDir, "sqlite-old-group", "sqlite-old-group-1", "old group");
  await writeMessageTranscript(activeDir, "sqlite-delete-session", "sqlite-delete-1", "delete me");
  await writeMessageTranscript(
    activeDir,
    "sqlite-concurrent-reset",
    "sqlite-concurrent-reset-1",
    "concurrent reset seed",
  );
  await writeMessageTranscript(
    activeDir,
    "sqlite-concurrent-delete",
    "sqlite-concurrent-delete-1",
    "concurrent delete seed",
  );
  await writeMessageTranscript(
    activeDir,
    "sqlite-shared-a",
    "sqlite-shared-1",
    "shared",
    "sqlite-shared-session",
  );
  await writeMessageTranscript(
    activeDir,
    "sqlite-shared-b",
    "sqlite-shared-2",
    "shared b",
    "sqlite-shared-session",
  );
  for (const [index] of SCALE_SESSION_KEYS.entries()) {
    const sessionId = scaleSessionId(index);
    await writeTranscript(context.activeSessionsDir, sessionId, [
      legacySessionEvent(sessionId),
      ...Array.from({ length: SCALE_EVENTS_PER_SESSION - 1 }, (_, eventIndex) =>
        messageEvent(
          `${sessionId}-${eventIndex + 1}`,
          eventIndex % 2 === 0 ? "user" : "assistant",
          `sqlite scale ${index + 1} event ${eventIndex + 1}`,
        ),
      ),
    ]);
  }
  await writeJsonFile(
    path.join(context.legacySessionsDir, `${context.legacySessionId}.trajectory.jsonl`),
    { type: "trajectory", sessionId: context.legacySessionId },
  );
  await writeJsonFile(path.join(context.legacySessionsDir, "old-orphan.deleted.jsonl"), {
    type: "event",
    id: "old-orphan",
  });
  const archiveDir = path.join(context.activeSessionsDir, "archive-fixture");
  await fs.mkdir(archiveDir, { recursive: true });
  await writeJsonFile(path.join(archiveDir, "cold-archive.jsonl"), {
    type: "event",
    id: "cold-archive",
  });
  await importProofSession(
    context,
    "agent:main:partial-direct",
    "sqlite-partial-import",
    {
      ...legacyEntry("sqlite-partial-import", now - 7_000),
      sessionFile: formatSqliteSessionFileMarker({
        agentId: context.agentId,
        sessionId: "sqlite-partial-import",
        storePath: context.storePath,
      }),
    },
    [messageEvent("sqlite-partial-import-1", "user", "already imported")],
  );
}

function scaleSessionId(index: number): string {
  return `sqlite-scale-${String(index + 1).padStart(2, "0")}`;
}

function legacyEntry(
  sessionId: string,
  updatedAt: number,
  options: { room?: string; sessionFile?: string } = {},
): SessionEntry & { channel: string; chatType: string; room?: string } {
  return {
    channel: "cli",
    chatType: "direct",
    ...(options.room ? { room: options.room } : {}),
    sessionFile: options.sessionFile ?? `${sessionId}.jsonl`,
    sessionId,
    sessionStartedAt: updatedAt - 500,
    updatedAt,
  };
}

function legacySessionEvent(sessionId: string): TranscriptEvent {
  return { type: "session", sessionId };
}

function messageEvent(id: string, role: "assistant" | "user", content: string): TranscriptEvent {
  return { type: "message", id, message: { role, content } };
}

async function writeJsonFile(filePath: string, value: unknown, indent?: number): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, indent)}\n`, { mode: 0o600 });
}

async function writeMessageTranscript(
  sessionsDir: string,
  fileId: string,
  messageId: string,
  content: string,
  sessionId = fileId,
): Promise<void> {
  await writeTranscript(sessionsDir, fileId, [
    legacySessionEvent(sessionId),
    messageEvent(messageId, "user", content),
  ]);
}

async function writeTranscript(
  sessionsDir: string,
  sessionId: string,
  events: TranscriptEvent[],
): Promise<void> {
  const body = events.map((event) => JSON.stringify(event)).join("\n");
  await fs.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), `${body}\n`, { mode: 0o600 });
}

async function importProofSession(
  context: ProofContext,
  sessionKey: string,
  sessionId: string,
  entry: SessionEntry,
  events: TranscriptEvent[],
) {
  try {
    return await importSqliteSessionRows({
      agentId: context.agentId,
      entry,
      readTranscriptEvents(append) {
        append(legacySessionEvent(sessionId));
        events.forEach(append);
      },
      sessionKey,
      storePath: context.storePath,
    });
  } finally {
    // The fixture's writer lease must not outlive its import into child maintenance.
    closeOpenClawAgentDatabaseByPath(context.agentDbPath);
  }
}

async function requireLegacyStartupRefusal(inst: OpenClawTestInstance, context: ProofContext) {
  const sources = new Map<string, Buffer>();
  for (const directory of [context.activeSessionsDir, context.legacySessionsDir]) {
    await walkFiles(directory, async (filePath) => {
      sources.set(filePath, await fs.readFile(filePath));
    });
    if (!sources.has(path.join(directory, "sessions.json"))) {
      throw new Error(`missing seeded legacy session store in ${directory}`);
    }
  }
  let message = "";
  try {
    await inst.startGateway();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (
    !message.startsWith("gateway exited before readiness (code=1 signal=null)") ||
    !message.includes("Gateway failed to start: Legacy session store requires migration:") ||
    !message.includes(path.join(context.legacySessionsDir, "sessions.json")) ||
    !message.includes('Run "openclaw doctor --fix"')
  ) {
    throw new Error(
      `expected legacy session migration refusal, got: ${message || "ready Gateway"}`,
    );
  }
  for (const [filePath, bytes] of sources) {
    if (!(await fs.readFile(filePath)).equals(bytes)) {
      throw new Error(`Gateway changed legacy source bytes before Doctor migration: ${filePath}`);
    }
  }
  return {
    message,
    preservedSourceFiles: [...sources.keys()]
      .map((filePath) => path.relative(context.stateDir, filePath))
      .toSorted(),
  };
}

async function runDoctor(inst: OpenClawTestInstance, mode: DoctorMode, storePath: string) {
  const result = await inst.cli(
    mode === "fix"
      ? ["doctor", "--fix", "--non-interactive"]
      : ["doctor", "--session-sqlite", mode, "--session-sqlite-store", storePath, "--json"],
    { timeoutMs: 60_000 },
  );
  const parsed = mode === "fix" ? undefined : parseJsonObject(result.stdout);
  return {
    code: result.code,
    mode,
    ...(parsed ? parseDoctorMigrationRun(parsed) : {}),
    ...(parsed ? parseDoctorRestore(parsed) : {}),
    stderrTail: tail(result.stderr),
    stdoutTail: tail(result.stdout),
    ...(parsed && typeof parsed.totals === "object"
      ? { totals: parsed.totals as Record<string, unknown> }
      : {}),
  };
}

function parseDoctorMigrationRun(parsed: Record<string, unknown>) {
  const migrationRun = asRecord(parsed.migrationRun);
  if (
    !migrationRun ||
    typeof migrationRun.manifestPath !== "string" ||
    typeof migrationRun.runId !== "string"
  ) {
    return {};
  }
  return {
    migrationRun: {
      ...(typeof migrationRun.failureReportJsonPath === "string"
        ? { failureReportJsonPath: migrationRun.failureReportJsonPath }
        : {}),
      ...(typeof migrationRun.failureReportMarkdownPath === "string"
        ? { failureReportMarkdownPath: migrationRun.failureReportMarkdownPath }
        : {}),
      manifestPath: migrationRun.manifestPath,
      runId: migrationRun.runId,
    },
  };
}

function parseDoctorRestore(parsed: Record<string, unknown>) {
  const targets = Array.isArray(parsed.targets) ? parsed.targets : [];
  const restore = asRecord(asRecord(targets[0])?.restore);
  if (!restore) {
    return {};
  }
  return {
    restore: {
      conflicts: Array.isArray(restore.conflicts) ? restore.conflicts.length : 0,
      manifestPaths: stringArray(restore.manifestPaths),
      restoredFiles: stringArray(restore.restoredFiles),
      skippedFiles: stringArray(restore.skippedFiles),
    },
  };
}

async function runRollbackRestoreProof(inst: OpenClawTestInstance, context: ProofContext) {
  const drillDir = path.join(context.stateDir, "rollback-drill");
  const storePath = path.join(drillDir, "sessions.json");
  const sessionId = "sqlite-rollback-restore";
  const sessionKey = "agent:main:rollback-restore";
  const sourcePath = path.join(drillDir, `${sessionId}.jsonl`);
  const sqlitePath = path.join(drillDir, "openclaw-agent.sqlite");
  await fs.mkdir(drillDir, { recursive: true });
  await writeJsonFile(storePath, { [sessionKey]: legacyEntry(sessionId, Date.now()) }, 2);
  await writeMessageTranscript(
    drillDir,
    sessionId,
    "sqlite-rollback-restore-1",
    "rollback restore me",
  );

  const importDoctor = await runDoctor(inst, "import", storePath);
  if (importDoctor.code !== 0) {
    throw new Error(`rollback drill import exited non-zero: ${importDoctor.stderrTail}`);
  }
  const manifestPath = importDoctor.migrationRun?.manifestPath;
  if (!manifestPath) {
    throw new Error(`rollback drill import did not report a migration manifest`);
  }
  const manifest = await readJsonObjectFile(manifestPath);
  const move = findManifestMoveForSource(manifest, sourcePath);
  if (!move) {
    throw new Error(`rollback drill manifest did not record ${sourcePath}`);
  }
  const archivedBeforeRestore = fsSync.existsSync(move.archivePath);
  if (fsSync.existsSync(sourcePath) || !archivedBeforeRestore) {
    throw new Error(
      `rollback drill import did not archive source=${sourcePath} archive=${move.archivePath}`,
    );
  }

  const failedManifestIssueCode = "e2e_forced_post_archive_failure";
  await markMigrationManifestFailed(manifestPath, failedManifestIssueCode);
  const restoreDoctor = await runDoctor(inst, "restore", storePath);
  if (restoreDoctor.code !== 0 || (restoreDoctor.restore?.conflicts ?? 0) > 0) {
    throw new Error(`rollback drill restore failed: ${restoreDoctor.stderrTail}`);
  }
  const restoredFiles = restoreDoctor.restore?.restoredFiles ?? [];
  if (!restoredFiles.some((filePath) => sameFilePathString(filePath, sourcePath))) {
    throw new Error(`rollback drill restore did not report restored source ${sourcePath}`);
  }
  if (!fsSync.existsSync(sourcePath) || fsSync.existsSync(move.archivePath)) {
    throw new Error(
      `rollback drill restore did not move archive back to source=${sourcePath} archive=${move.archivePath}`,
    );
  }

  const idempotentRestore = await runDoctor(inst, "restore", storePath);
  if (idempotentRestore.code !== 0 || (idempotentRestore.restore?.conflicts ?? 0) > 0) {
    throw new Error(`rollback drill idempotent restore failed: ${idempotentRestore.stderrTail}`);
  }
  const idempotentRestoreSkippedFiles = idempotentRestore.restore?.skippedFiles ?? [];
  if (!idempotentRestoreSkippedFiles.some((filePath) => sameFilePathString(filePath, sourcePath))) {
    throw new Error(`rollback drill idempotent restore did not skip ${sourcePath}`);
  }
  if (!fsSync.existsSync(sqlitePath)) {
    throw new Error(`rollback drill restore unexpectedly removed SQLite database ${sqlitePath}`);
  }

  return {
    archivePath: move.archivePath,
    archivedBeforeRestore,
    failedManifestIssueCode,
    idempotentRestoreSkippedFiles,
    manifestPath,
    restoredFiles,
    sourcePath,
    sourceRestored: fsSync.existsSync(sourcePath),
    sqliteStillExists: fsSync.existsSync(sqlitePath),
  };
}

async function readJsonObjectFile(filePath: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  const record = asRecord(parsed);
  if (!record) {
    throw new Error(`${filePath} did not contain a JSON object`);
  }
  return record;
}

function findManifestMoveForSource(
  manifest: Record<string, unknown>,
  sourcePath: string,
): { archivePath: string; sourcePath: string } | undefined {
  for (const target of Array.isArray(manifest.targets) ? manifest.targets : []) {
    const targetRecord = asRecord(target);
    const moves = [
      ...(Array.isArray(targetRecord?.completedMoves) ? targetRecord.completedMoves : []),
      ...(Array.isArray(targetRecord?.plannedMoves) ? targetRecord.plannedMoves : []),
    ];
    for (const move of moves) {
      const moveRecord = asRecord(move);
      if (
        typeof moveRecord?.sourcePath === "string" &&
        typeof moveRecord.archivePath === "string" &&
        sameFilePathString(moveRecord.sourcePath, sourcePath)
      ) {
        return {
          archivePath: moveRecord.archivePath,
          sourcePath: moveRecord.sourcePath,
        };
      }
    }
  }
  return undefined;
}

function sameFilePathString(left: string, right: string): boolean {
  return normalizeMacPrivatePath(left) === normalizeMacPrivatePath(right);
}

function normalizeMacPrivatePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return resolved.startsWith("/private/") ? resolved.slice("/private".length) : resolved;
}

async function markMigrationManifestFailed(manifestPath: string, issueCode: string): Promise<void> {
  const manifest = await readJsonObjectFile(manifestPath);
  const failedAt = new Date().toISOString();
  manifest.failedAt = failedAt;
  manifest.completedAt = typeof manifest.completedAt === "string" ? manifest.completedAt : failedAt;
  const firstTarget = asRecord(Array.isArray(manifest.targets) ? manifest.targets[0] : undefined);
  if (firstTarget) {
    const issues = Array.isArray(firstTarget.issues) ? firstTarget.issues : [];
    firstTarget.issues = [
      ...issues,
      {
        code: issueCode,
        message: "E2E simulated post-archive migration failure.",
        sessionKey: "agent:main:rollback-restore",
      },
    ];
  }
  await writeJsonFile(manifestPath, manifest, 2);
}

async function appendProofMessage(
  context: ProofContext,
  sessionId: string,
  sessionKey: string,
  message: string,
): Promise<void> {
  try {
    const result = await appendTranscriptMessage(
      {
        agentId: context.agentId,
        sessionId,
        sessionKey,
        storePath: context.storePath,
      },
      {
        message: {
          role: "assistant",
          content: message,
          timestamp: Date.now(),
        },
      },
    );
    if (!result?.appended || !result.messageId) {
      throw new Error(`appendTranscriptMessage failed for ${sessionKey}`);
    }
  } finally {
    closeOpenClawAgentDatabaseByPath(context.agentDbPath);
  }
}

function sessionArtifactPaths(sessionsDir: string, sessionId: string) {
  return {
    jsonl: path.join(sessionsDir, `${sessionId}.jsonl`),
    pointer: path.join(sessionsDir, `${sessionId}.trajectory-path.json`),
    runtime: path.join(sessionsDir, "trajectory", `${sessionId}.jsonl`),
    trajectory: path.join(sessionsDir, `${sessionId}.trajectory.jsonl`),
  };
}

async function runDoctorIdempotenceProof(
  inst: OpenClawTestInstance,
  context: ProofContext,
): Promise<DoctorCommandEvidence> {
  const before = readSqliteEvidence(context.agentDbPath, context.trackedSessionKeys);
  const doctor = await runDoctor(inst, "import", context.storePath);
  if (doctor.code !== 0) {
    throw new Error(`doctor import idempotence check exited non-zero: ${doctor.stderrTail}`);
  }
  const totals = doctor.totals ?? {};
  if (totals.importedEntries !== 0 || totals.importedTranscriptEvents !== 0) {
    throw new Error(`doctor import was not idempotent: ${JSON.stringify(totals)}`);
  }
  const after = readSqliteEvidence(context.agentDbPath, context.trackedSessionKeys);
  if (
    after.sessionEntries !== before.sessionEntries ||
    after.sessions !== before.sessions ||
    after.transcriptEvents !== before.transcriptEvents
  ) {
    throw new Error(
      `doctor import changed SQLite counts: before=${JSON.stringify(before)} after=${JSON.stringify(
        after,
      )}`,
    );
  }
  return doctor;
}

function requireScaleMigrationProof(context: ProofContext, doctorImportElapsedMs: number) {
  const sqlite = readSqliteEvidence(context.agentDbPath, SCALE_SESSION_KEYS);
  const importedSessionKeys: string[] = [];
  for (const [index, sessionKey] of SCALE_SESSION_KEYS.entries()) {
    const row = sqlite.trackedEntries.find((entry) => entry.sessionKey === sessionKey);
    const sessionId = scaleSessionId(index);
    if (!row || row.sessionId !== sessionId) {
      throw new Error(`scale migration did not import ${sessionKey} as ${sessionId}`);
    }
    if (row.transcriptEvents < SCALE_EVENTS_PER_SESSION) {
      throw new Error(
        `scale migration imported too few events for ${sessionKey}: ${row.transcriptEvents}`,
      );
    }
    importedSessionKeys.push(sessionKey);
  }
  return {
    importedSessionKeys,
    minTranscriptEventsPerSession: SCALE_EVENTS_PER_SESSION,
    seededEvents: SCALE_SESSION_COUNT * SCALE_EVENTS_PER_SESSION,
    seededSessions: SCALE_SESSION_COUNT,
    doctorImportElapsedMs,
  };
}

async function runDowngradeReupgradeProof(inst: OpenClawTestInstance, context: ProofContext) {
  await fs.mkdir(context.activeSessionsDir, { recursive: true });
  await writeJsonFile(
    context.storePath,
    {
      [DOWNGRADE_REUPGRADE_SESSION_KEY]: legacyEntry(DOWNGRADE_REUPGRADE_SESSION_ID, Date.now()),
    },
    2,
  );
  const {
    jsonl: transcriptPath,
    pointer: trajectoryPointerPath,
    trajectory: trajectoryPath,
  } = sessionArtifactPaths(context.activeSessionsDir, DOWNGRADE_REUPGRADE_SESSION_ID);
  await writeMessageTranscript(
    context.activeSessionsDir,
    DOWNGRADE_REUPGRADE_SESSION_ID,
    "sqlite-downgrade-reupgrade-1",
    DOWNGRADE_REUPGRADE_TEXT,
  );
  await writeJsonFile(trajectoryPath, {
    type: "trajectory",
    sessionId: DOWNGRADE_REUPGRADE_SESSION_ID,
  });
  await writeJsonFile(trajectoryPointerPath, {
    traceSchema: "openclaw-trajectory-pointer",
    schemaVersion: 1,
    sessionId: DOWNGRADE_REUPGRADE_SESSION_ID,
    runtimeFile: trajectoryPath,
  });

  const doctor = await runDoctor(inst, "import", context.storePath);
  if (doctor.code !== 0) {
    throw new Error(`downgrade/re-upgrade import exited non-zero: ${doctor.stderrTail}`);
  }
  const totals = doctor.totals ?? {};
  if (totals.importedEntries !== 1 || totals.importedTranscriptEvents !== 2) {
    throw new Error(`downgrade/re-upgrade import had unexpected totals: ${JSON.stringify(totals)}`);
  }
  await waitForSqliteMessageContains(
    context.agentDbPath,
    DOWNGRADE_REUPGRADE_SESSION_ID,
    "user",
    DOWNGRADE_REUPGRADE_TEXT,
  );
  const manifestPath = doctor.migrationRun?.manifestPath;
  if (!manifestPath) {
    throw new Error(`downgrade/re-upgrade import did not report a migration manifest`);
  }
  const manifest = await readJsonObjectFile(manifestPath);
  const trajectoryMove = findManifestMoveForSource(manifest, trajectoryPath);
  const trajectoryPointerMove = findManifestMoveForSource(manifest, trajectoryPointerPath);
  if (!trajectoryMove || !trajectoryPointerMove) {
    throw new Error(
      `downgrade/re-upgrade import did not record trajectory artifact moves: ${JSON.stringify({
        trajectoryMove,
        trajectoryPointerMove,
      })}`,
    );
  }
  const trajectorySidecarArchived = fsSync.existsSync(trajectoryMove.archivePath);
  const trajectoryPointerArchived = fsSync.existsSync(trajectoryPointerMove.archivePath);
  if (!trajectorySidecarArchived || !trajectoryPointerArchived) {
    throw new Error(
      `downgrade/re-upgrade import did not archive trajectory artifacts: ${JSON.stringify({
        trajectoryArchive: trajectoryMove.archivePath,
        trajectoryPointerArchive: trajectoryPointerMove.archivePath,
      })}`,
    );
  }
  return {
    activeJsonlArchived: !fsSync.existsSync(transcriptPath),
    doctorImportedEntries: totals.importedEntries,
    doctorImportedTranscriptEvents: totals.importedTranscriptEvents,
    trajectoryPointerArchived,
    trajectoryPointerSourceRemoved: !fsSync.existsSync(trajectoryPointerPath),
    trajectorySidecarArchived,
    trajectorySidecarSourceRemoved: !fsSync.existsSync(trajectoryPath),
    sessionId: DOWNGRADE_REUPGRADE_SESSION_ID,
    sessionKey: DOWNGRADE_REUPGRADE_SESSION_KEY,
    transcriptEvents: countSqliteTranscriptEvents(
      context.agentDbPath,
      DOWNGRADE_REUPGRADE_SESSION_ID,
    ),
  };
}

async function runSqliteBusyContentionProof(context: ProofContext) {
  const holdMs = 500;
  const readyPath = path.join(context.stateDir, `sqlite-busy-${randomUUID()}.ready`);
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import fs from "node:fs";
        import { DatabaseSync } from "node:sqlite";
        const db = new DatabaseSync(process.env.OPENCLAW_E2E_BUSY_DB_PATH);
        db.exec("PRAGMA busy_timeout = 30000; BEGIN IMMEDIATE;");
        fs.writeFileSync(process.env.OPENCLAW_E2E_BUSY_READY_PATH, "ready");
        setTimeout(() => {
          db.exec("COMMIT");
          db.close();
        }, Number(process.env.OPENCLAW_E2E_BUSY_HOLD_MS));
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_E2E_BUSY_DB_PATH: context.agentDbPath,
        OPENCLAW_E2E_BUSY_HOLD_MS: String(holdMs),
        OPENCLAW_E2E_BUSY_READY_PATH: readyPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const childOutput = captureChildOutput(child);

  await waitForFile(readyPath, SQLITE_FLIP_PROOF_OPERATION_TIMEOUT_MS, () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `SQLite busy child exited before acquiring lock code=${String(
          child.exitCode,
        )} signal=${String(child.signalCode)} ${tail(childOutput())}`,
      );
    }
  });

  const startedAt = Date.now();
  const result = await importProofSession(
    context,
    SQLITE_BUSY_SESSION_KEY,
    SQLITE_BUSY_SESSION_ID,
    legacyEntry(SQLITE_BUSY_SESSION_ID, Date.now()),
    [messageEvent("sqlite-busy-contention-1", "user", SQLITE_BUSY_TEXT)],
  );
  const elapsedMs = Date.now() - startedAt;
  const exit = await waitForChildExit(child, SQLITE_FLIP_PROOF_OPERATION_TIMEOUT_MS);
  if (exit.code !== 0) {
    throw new Error(
      `SQLite busy child exited non-zero code=${String(exit.code)} signal=${String(
        exit.signal,
      )} ${tail(childOutput())}`,
    );
  }
  if (elapsedMs < Math.floor(holdMs / 2)) {
    throw new Error(`SQLite busy proof did not wait on the writer lock: elapsed=${elapsedMs}ms`);
  }
  await waitForSqliteMessageContains(
    context.agentDbPath,
    SQLITE_BUSY_SESSION_ID,
    "user",
    SQLITE_BUSY_TEXT,
  );
  return {
    childExitCode: exit.code,
    childSignal: exit.signal,
    elapsedMs,
    holdMs,
    sessionId: SQLITE_BUSY_SESSION_ID,
    sessionKey: SQLITE_BUSY_SESSION_KEY,
    transcriptEvents: result.transcriptEvents,
  };
}

async function runSecondStartupAfterResetProof(
  client: GatewayClient,
  context: ProofContext,
  resetSessionId: string,
) {
  await appendProofMessage(
    context,
    resetSessionId,
    context.resetSessionKey,
    SECOND_STARTUP_APPEND_TEXT,
  );
  await waitForHistoryContains(client, context.resetSessionKey, SECOND_STARTUP_APPEND_TEXT);
  await waitForSqliteEvents(context.agentDbPath, resetSessionId, 1);
  return {
    activeJsonlForSessionExists: fsSync.existsSync(
      path.join(context.activeSessionsDir, `${resetSessionId}.jsonl`),
    ),
    historyContainsPostResetAppend: true,
    sessionId: resetSessionId,
    sessionKey: context.resetSessionKey,
    transcriptEvents: countSqliteTranscriptEvents(context.agentDbPath, resetSessionId),
  };
}

async function runConcurrentMultiClientLifecycle(
  inst: OpenClawTestInstance,
  context: ProofContext,
  primaryClient: GatewayClient,
): Promise<void> {
  const historyClient = await connectProofClient(
    inst,
    "sqlite-sessions-transcripts-flip-proof-concurrent-history",
  );
  const lifecycleClient = await connectProofClient(
    inst,
    "sqlite-sessions-transcripts-flip-proof-concurrent-lifecycle",
  );
  try {
    await requireHistoryContains(
      historyClient,
      context.concurrentResetSessionKey,
      "concurrent reset seed",
    );
    const sendPromise = sendGatewayUserMessage(
      primaryClient,
      context.concurrentSendSessionKey,
      CONCURRENT_SEND_TEXT,
    );
    const historyPromise = historyClient.request(
      "chat.history",
      { sessionKey: context.concurrentResetSessionKey, limit: 50 },
      { timeoutMs: SQLITE_FLIP_PROOF_OPERATION_TIMEOUT_MS },
    );
    const resetPromise = resetSession(lifecycleClient, context.concurrentResetSessionKey);

    const [sendRunId, , resetSessionId] = await Promise.all([
      sendPromise,
      historyPromise,
      resetPromise,
    ]);
    await waitForAgentRunOk(primaryClient, sendRunId);
    const sendSessionId = await waitForSqliteSessionId(
      context.agentDbPath,
      context.concurrentSendSessionKey,
    );
    await waitForSqliteMessageContains(
      context.agentDbPath,
      sendSessionId,
      "user",
      CONCURRENT_SEND_TEXT,
    );
    await waitForSqliteMessageContains(
      context.agentDbPath,
      sendSessionId,
      "assistant",
      context.fullTurnAssistantText,
    );
    await waitForTrackedSessionId(
      context.agentDbPath,
      context.concurrentResetSessionKey,
      resetSessionId,
    );

    const deleteRunId = await sendGatewayUserMessage(
      historyClient,
      context.concurrentDeleteSessionKey,
      CONCURRENT_DELETE_TEXT,
    );
    const deleteHistoryPromise = lifecycleClient.request(
      "chat.history",
      { sessionKey: context.concurrentDeleteSessionKey, limit: 50 },
      { timeoutMs: SQLITE_FLIP_PROOF_OPERATION_TIMEOUT_MS },
    );
    await Promise.all([
      deleteHistoryPromise,
      deleteSession(primaryClient, context.concurrentDeleteSessionKey),
    ]);
    await waitForAgentRunSettled(historyClient, deleteRunId);
    await waitForSessionEntryAbsent(context.agentDbPath, context.concurrentDeleteSessionKey);
  } finally {
    await Promise.all([
      disconnectGatewayClient(historyClient),
      disconnectGatewayClient(lifecycleClient),
    ]);
  }
}

async function resetSession(client: GatewayClient, key: string): Promise<string> {
  const result: { ok?: boolean; entry?: { sessionId?: string } } = await client.request(
    "sessions.reset",
    { key, reason: "reset" },
  );
  if (result?.ok !== true || !result.entry?.sessionId) {
    throw new Error(`sessions.reset failed: ${JSON.stringify(result)}`);
  }
  return result.entry.sessionId;
}

async function sendGatewayUserMessage(
  client: GatewayClient,
  sessionKey: string,
  message: string,
): Promise<string> {
  const result: { runId?: string; status?: string } = await client.request(
    "chat.send",
    {
      sessionKey,
      message,
      idempotencyKey: `sqlite-send-${randomUUID()}`,
    },
    { timeoutMs: SQLITE_FLIP_PROOF_OPERATION_TIMEOUT_MS },
  );
  if (result?.status !== "started" || typeof result.runId !== "string") {
    throw new Error(`chat.send did not start correctly: ${JSON.stringify(result)}`);
  }
  return result.runId;
}

async function waitForAgentRunOk(client: GatewayClient, runId: string): Promise<void> {
  const result: { error?: unknown; status?: string } = await client.request(
    "agent.wait",
    { runId, timeoutMs: 60_000 },
    { timeoutMs: 65_000 },
  );
  if (result?.status !== "ok") {
    throw new Error(`agent.wait failed for ${runId}: ${JSON.stringify(result)}`);
  }
}

async function waitForAgentRunSettled(client: GatewayClient, runId: string): Promise<void> {
  const result: { endedAt?: number; status?: string; stopReason?: string } = await client.request(
    "agent.wait",
    { runId, timeoutMs: 60_000 },
    { timeoutMs: 65_000 },
  );
  if (typeof result?.status !== "string") {
    throw new Error(`agent.wait returned no status for ${runId}: ${JSON.stringify(result)}`);
  }
  if (result.status === "ok") {
    return;
  }
  const terminalLifecycleStatus = result.status === "timeout" || result.status === "error";
  if (
    terminalLifecycleStatus &&
    (result.stopReason === "rpc" || result.stopReason === "stop") &&
    typeof result.endedAt === "number"
  ) {
    return;
  }
  throw new Error(`agent.wait did not settle acceptably for ${runId}: ${JSON.stringify(result)}`);
}

async function deleteSession(client: GatewayClient, key: string): Promise<void> {
  const result: { ok?: boolean; deleted?: boolean } = await client.request("sessions.delete", {
    key,
    deleteTranscript: true,
  });
  if (result?.ok !== true || result.deleted !== true) {
    throw new Error(`sessions.delete failed for ${key}: ${JSON.stringify(result)}`);
  }
}

async function requireTrackedSession(client: GatewayClient, key: string): Promise<void> {
  const result: { sessions?: Array<{ key?: string }> } = await client.request("sessions.list", {});
  if (!result.sessions?.some((session) => session.key === key)) {
    throw new Error(`expected session ${key} to remain listed`);
  }
}

async function requireHistoryContains(
  client: GatewayClient,
  sessionKey: string,
  expected: string,
): Promise<void> {
  const result: { messages?: unknown[] } = await client.request("chat.history", {
    agentId: AGENT_ID,
    sessionKey,
    limit: 50,
  });
  const text = JSON.stringify(result.messages ?? []);
  if (!text.includes(expected)) {
    throw new Error(
      `chat.history for ${sessionKey} did not contain ${JSON.stringify(expected)}: ${tail(
        JSON.stringify(result),
      )}`,
    );
  }
}

async function requireHistoryRoleContains(
  client: GatewayClient,
  sessionKey: string,
  role: string,
  expected: string,
): Promise<void> {
  const result: { messages?: unknown[] } = await client.request("chat.history", {
    agentId: AGENT_ID,
    sessionKey,
    limit: 50,
  });
  const matching = (result.messages ?? []).some(
    (message) =>
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as { role?: unknown }).role === role &&
      JSON.stringify(message).includes(expected),
  );
  if (!matching) {
    throw new Error(
      `chat.history for ${sessionKey} did not contain ${role} message ${JSON.stringify(
        expected,
      )}: ${tail(JSON.stringify(result))}`,
    );
  }
}

async function waitForHistoryContains(
  client: GatewayClient,
  sessionKey: string,
  expected: string,
): Promise<void> {
  await waitForAssertion(() => requireHistoryContains(client, sessionKey, expected));
}

async function waitForHistoryRoleContains(
  client: GatewayClient,
  sessionKey: string,
  role: string,
  expected: string,
): Promise<void> {
  await waitForAssertion(() => requireHistoryRoleContains(client, sessionKey, role, expected));
}

async function waitForAssertion(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch {
      await sleep(50);
    }
  }
  await assertion();
}

async function pollUntil<T>(
  read: () => T | Promise<T>,
  ready: (value: T) => boolean,
  timeoutError: () => Error,
  options: { intervalMs?: number; stableMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? SQLITE_FLIP_PROOF_OPERATION_TIMEOUT_MS);
  let readySince: number | undefined;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) {
      readySince ??= Date.now();
      if (Date.now() - readySince >= (options.stableMs ?? 0)) {
        return value;
      }
    } else {
      readySince = undefined;
    }
    await sleep(options.intervalMs ?? 50);
  }
  throw timeoutError();
}

async function waitForSqliteEvents(
  dbPath: string,
  sessionId: string,
  minEvents: number,
): Promise<void> {
  await pollUntil(
    () =>
      readSqliteEvidence(dbPath, []).trackedEntries.find((entry) => entry.sessionId === sessionId)
        ?.transcriptEvents ?? 0,
    (eventCount) => eventCount >= minEvents,
    () => new Error(`timed out waiting for ${minEvents} SQLite events for ${sessionId}`),
  );
}

async function waitForSqliteSessionId(dbPath: string, sessionKey: string): Promise<string> {
  return await pollUntil(
    () =>
      readSqliteEvidence(dbPath, [sessionKey]).trackedEntries.find(
        (entry) => entry.sessionKey === sessionKey,
      )?.sessionId ?? "",
    Boolean,
    () => new Error(`timed out waiting for SQLite session entry for ${sessionKey}`),
  );
}

async function waitForTrackedSessionId(
  dbPath: string,
  sessionKey: string,
  expectedSessionId: string,
): Promise<void> {
  await pollUntil(
    () =>
      readSqliteEvidence(dbPath, [sessionKey]).trackedEntries.find(
        (entry) => entry.sessionKey === sessionKey,
      )?.sessionId,
    (sessionId) => sessionId === expectedSessionId,
    () =>
      new Error(
        `timed out waiting for SQLite session entry ${sessionKey} to point at ${expectedSessionId}`,
      ),
  );
}

async function waitForSessionEntryAbsent(dbPath: string, sessionKey: string): Promise<void> {
  await pollUntil(
    () =>
      readSqliteEvidence(dbPath, [sessionKey]).trackedEntries.some(
        (entry) => entry.sessionKey === sessionKey,
      ),
    (exists) => !exists,
    () => new Error(`timed out waiting for SQLite session entry deletion for ${sessionKey}`),
    { stableMs: 1_500 },
  );
}

async function waitForSqliteMessageContains(
  dbPath: string,
  sessionId: string,
  role: "assistant" | "user",
  expected: string,
): Promise<void> {
  await pollUntil(
    () => readSqliteTranscriptMessages(dbPath, sessionId),
    (messages) =>
      messages.some(
        (message) => message.role === role && JSON.stringify(message.content).includes(expected),
      ),
    () =>
      new Error(
        `timed out waiting for SQLite ${role} transcript message containing ${JSON.stringify(
          expected,
        )} for ${sessionId}: ${JSON.stringify(readSqliteTranscriptMessages(dbPath, sessionId))}`,
      ),
  );
}

async function waitForFile(filePath: string, timeoutMs: number, poll: () => void): Promise<void> {
  await pollUntil(
    () => {
      poll();
      return fsSync.existsSync(filePath);
    },
    Boolean,
    () => new Error(`timed out waiting for ${filePath}`),
    { intervalMs: 25, timeoutMs },
  );
}

async function waitForChildExit(
  child: ProofChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        child.kill("SIGKILL");
        reject(new Error(`timed out waiting for child process ${child.pid ?? "unknown"} to exit`));
      }, timeoutMs);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer);
        resolve({ code, signal });
      };
      child.once("exit", onExit);
      if (child.exitCode !== null || child.signalCode !== null) {
        child.off("exit", onExit);
        clearTimeout(timer);
        resolve({ code: child.exitCode, signal: child.signalCode });
      }
    },
  );
}

async function requireMockOpenAiRequest(requestLogPath: string): Promise<void> {
  const text = await fs.readFile(requestLogPath, "utf8").catch(() => "");
  if (!text.includes('"/v1/responses"')) {
    throw new Error(`mock OpenAI request log did not include /v1/responses: ${tail(text)}`);
  }
}

function readSqliteTranscriptMessages(
  dbPath: string,
  sessionId: string,
): Array<{ content?: unknown; role?: string }> {
  return withReadOnlyDatabase(dbPath, [], (db) => {
    const rows = db
      .prepare(
        `SELECT event_json AS eventJson
         FROM transcript_events
         WHERE session_id = ?
         ORDER BY seq ASC`,
      )
      .all(sessionId) as Array<{ eventJson?: unknown }>;
    return rows.flatMap((row) => {
      if (typeof row.eventJson !== "string") {
        return [];
      }
      const event = parseJsonObject(row.eventJson);
      const message =
        event && typeof event.message === "object" && event.message !== null
          ? (event.message as { content?: unknown; role?: unknown })
          : undefined;
      return typeof message?.role === "string"
        ? [{ role: message.role, content: message.content }]
        : [];
    });
  });
}

function countSqliteTranscriptEvents(dbPath: string, sessionId: string): number {
  return withReadOnlyDatabase(dbPath, 0, (db) =>
    scalarNumber(db, "SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?", [
      sessionId,
    ]),
  );
}

async function captureCheckpoint(
  context: ProofContext,
  label: string,
  options: { doctor?: DoctorCommandEvidence; gatewayLogTail?: string },
) {
  return {
    activeJsonl: await inventoryActiveJsonl(context.activeSessionsDir),
    archiveArtifacts: await inventoryArchiveArtifacts(context),
    ...(options.doctor ? { doctor: options.doctor } : {}),
    gatewayLogTail: tail(options.gatewayLogTail ?? ""),
    label,
    legacyStateJsonl: await inventoryActiveJsonl(context.legacySessionsDir),
    sqlite: readSqliteEvidence(context.agentDbPath, context.trackedSessionKeys),
  };
}

async function inventoryActiveJsonl(sessionsDir: string): Promise<FileInventoryEntry[]> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  return await Promise.all(
    files.map((entry) => inventoryFile(path.join(sessionsDir, entry.name), sessionsDir)),
  );
}

async function inventoryArchiveArtifacts(context: ProofContext): Promise<FileInventoryEntry[]> {
  const roots = context.archiveRoots;
  const files: FileInventoryEntry[] = [];
  for (const root of roots) {
    await walkFiles(root, async (filePath) => {
      const basename = path.basename(filePath);
      const archiveLike =
        basename.includes(".jsonl") ||
        basename.includes(".trajectory-path.json") ||
        basename.includes(".reset.") ||
        basename.includes(".deleted.") ||
        basename.includes(".bak.");
      const isActivePrimaryJsonl =
        path.dirname(filePath) === context.activeSessionsDir &&
        basename.endsWith(".jsonl") &&
        parseArchiveArtifactName(basename) === undefined;
      if (isActivePrimaryJsonl) {
        return;
      }
      if (archiveLike) {
        files.push(await inventoryFile(filePath, context.stateDir));
      }
    });
  }
  return files.toSorted((a, b) => a.path.localeCompare(b.path));
}

async function walkFiles(root: string, visit: (filePath: string) => Promise<void>): Promise<void> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(filePath, visit);
    } else if (entry.isFile()) {
      await visit(filePath);
    }
  }
}

async function inventoryFile(filePath: string, relativeRoot: string) {
  const stat = await fs.stat(filePath);
  const text = await Promise.resolve()
    .then(() => readSessionArchiveContentSync(filePath))
    .catch(() => undefined);
  const archive = parseArchiveArtifactName(path.basename(filePath));
  const jsonl = text !== undefined ? summarizeJsonl(text) : undefined;
  return {
    ...(archive ? archive : {}),
    path: path.relative(relativeRoot, filePath),
    bytes: stat.size,
    ...(text !== undefined
      ? { lines: text.split(/\r?\n/u).filter(Boolean).length, textTail: tail(text, 2_000) }
      : {}),
    ...(jsonl?.jsonlTypes.length ? { jsonlTypes: jsonl.jsonlTypes } : {}),
    ...(jsonl?.messageRoles.length ? { messageRoles: jsonl.messageRoles } : {}),
    ...(jsonl?.messageTexts.length ? { messageTexts: jsonl.messageTexts } : {}),
  };
}

function parseArchiveArtifactName(
  fileName: string,
): { archiveReason: "bak" | "deleted" | "reset"; archiveSessionId: string } | undefined {
  const normalized = stripSessionArchiveCompressionSuffix(fileName);
  for (const archiveReason of ["deleted", "reset", "bak"] as const) {
    const marker = `.jsonl.${archiveReason}.`;
    const index = normalized.lastIndexOf(marker);
    if (index > 0) {
      return { archiveReason, archiveSessionId: normalized.slice(0, index) };
    }
  }
  return undefined;
}

function summarizeJsonl(text: string): {
  jsonlTypes: string[];
  messageRoles: string[];
  messageTexts: string[];
} {
  const jsonlTypes = new Set<string>();
  const messageRoles = new Set<string>();
  const messageTexts = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }
    const event = parseJsonObject(line);
    if (typeof event?.type === "string") {
      jsonlTypes.add(event.type);
    }
    const message =
      event && typeof event.message === "object" && event.message !== null
        ? (event.message as { content?: unknown; role?: unknown })
        : undefined;
    if (typeof message?.role === "string") {
      messageRoles.add(message.role);
    }
    const messageContent = message?.content;
    if (typeof messageContent === "string") {
      messageTexts.add(messageContent);
    } else if (messageContent !== undefined) {
      messageTexts.add(JSON.stringify(messageContent));
    } else if (typeof event?.content === "string") {
      messageTexts.add(event.content);
    }
  }
  return {
    jsonlTypes: [...jsonlTypes].toSorted(),
    messageRoles: [...messageRoles].toSorted(),
    messageTexts: [...messageTexts].toSorted(),
  };
}

function readSqliteEvidence(dbPath: string, trackedSessionKeys: readonly string[]) {
  return withReadOnlyDatabase(
    dbPath,
    {
      exists: false,
      path: dbPath,
      sessionEntries: 0,
      sessions: 0,
      trackedEntries: [],
      trajectoryRuntimeEvents: 0,
      transcriptEvents: 0,
    },
    (db) => ({
      exists: true,
      path: dbPath,
      sessionEntries: scalarNumber(db, "SELECT COUNT(*) AS count FROM session_nodes"),
      sessions: scalarNumber(db, "SELECT COUNT(*) AS count FROM session_windows"),
      trajectoryRuntimeEvents: scalarNumber(
        db,
        "SELECT COUNT(*) AS count FROM trajectory_runtime_events",
      ),
      trackedEntries: readTrackedEntries(db, trackedSessionKeys),
      transcriptEvents: scalarNumber(db, "SELECT COUNT(*) AS count FROM transcript_events"),
    }),
  );
}

function withReadOnlyDatabase<T>(dbPath: string, fallback: T, read: (db: DatabaseSync) => T): T {
  if (!fsSync.existsSync(dbPath)) {
    return fallback;
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function readTrackedEntries(db: DatabaseSync, trackedSessionKeys: readonly string[]) {
  const rows = db
    .prepare(
      `SELECT session_key AS sessionKey, current_session_id AS sessionId, entry_json AS entryJson
       FROM session_nodes
       ORDER BY session_key ASC`,
    )
    .all() as Array<{ entryJson?: unknown; sessionId?: unknown; sessionKey?: unknown }>;
  return rows
    .filter(
      (row) =>
        trackedSessionKeys.length === 0 ||
        trackedSessionKeys.includes(typeof row.sessionKey === "string" ? row.sessionKey : ""),
    )
    .map((row) => {
      const sessionId = typeof row.sessionId === "string" ? row.sessionId : "";
      const entry = typeof row.entryJson === "string" ? parseEntryJson(row.entryJson) : undefined;
      const trackedEntry: {
        entry?: Record<string, unknown>;
        sessionId: string;
        sessionKey: string;
        trajectoryEvents: number;
        transcriptEvents: number;
      } = {
        sessionId,
        sessionKey: typeof row.sessionKey === "string" ? row.sessionKey : "",
        trajectoryEvents: scalarNumber(
          db,
          "SELECT COUNT(*) AS count FROM trajectory_runtime_events WHERE session_id = ?",
          [sessionId],
        ),
        transcriptEvents: scalarNumber(
          db,
          "SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?",
          [sessionId],
        ),
      };
      if (entry) {
        trackedEntry.entry = entry;
      }
      return trackedEntry;
    });
}

function parseEntryJson(entryJson: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(entryJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const entry = { ...(parsed as Record<string, unknown>) };
    delete entry.skillsSnapshot;
    return entry;
  } catch {
    return undefined;
  }
}

function scalarNumber(db: DatabaseSync, sql: string, values: SQLInputValue[] = []): number {
  const row = db.prepare(sql).get(...values) as { count?: unknown } | undefined;
  return typeof row?.count === "number" ? row.count : 0;
}

function validateCheckpointInvariants(
  context: ProofContext,
  checkpoint: ProofCheckpoint,
  failures: string[],
): void {
  if (checkpoint.label !== "seeded-legacy-store" && checkpoint.label !== "after-startup-refusal") {
    for (const [description, inventory] of [
      ["active sessions directory", checkpoint.activeJsonl],
      ["old sessions directory", checkpoint.legacyStateJsonl],
    ] as const) {
      if (inventory.length > 0) {
        failures.push(
          `${checkpoint.label}: ${description} still has JSONL files: ${inventory
            .map((entry) => entry.path)
            .join(", ")}`,
        );
      }
    }
  }
  const doctor = checkpoint.doctor;
  if (checkpoint.label.startsWith("after-doctor") && doctor?.code !== 0) {
    failures.push(`${checkpoint.label}: doctor ${doctor?.mode ?? "unknown"} exited non-zero`);
  }
  if (
    checkpoint.label === "after-doctor-fix" &&
    (checkpoint.sqlite.sessionEntries === 0 || checkpoint.sqlite.transcriptEvents === 0)
  ) {
    failures.push(`${checkpoint.label}: Doctor did not import sessions into SQLite`);
  }
  if (
    checkpoint.label.startsWith("after-doctor") &&
    checkpoint.sqlite.exists &&
    checkpoint.sqlite.sessionEntries > 0 &&
    checkpoint.sqlite.transcriptEvents === 0
  ) {
    failures.push(`${checkpoint.label}: SQLite has session entries but no transcript events`);
  }
  if (
    checkpoint.label === "after-shared-first-delete" &&
    !checkpoint.sqlite.trackedEntries.some(
      (entry) => entry.sessionKey === context.sharedSessionKeys[1],
    )
  ) {
    failures.push(`${checkpoint.label}: shared sibling entry was deleted too early`);
  }
  if (checkpoint.label === "after-doctor-fix") {
    requireArchiveText(checkpoint, failures, {
      description: "legacy trajectory sidecar",
      includes: ["trajectory", context.legacySessionId],
      pathIncludes: `${context.legacySessionId}.trajectory.jsonl`,
    });
    requireArchiveText(checkpoint, failures, {
      description: "preexisting deleted sidecar",
      includes: ["old-orphan"],
      pathIncludes: "old-orphan.deleted.jsonl",
    });
  }
  if (checkpoint.label === "after-sessions-reset") {
    // Retained history: reset rotates the live session id but keeps the old
    // generation's SQLite rows searchable; no reset archive is produced.
    if (findArchiveArtifact(checkpoint, { reason: "reset", sessionId: context.legacySessionId })) {
      failures.push(`${checkpoint.label}: unexpected reset transcript archive`);
    }
    if (checkpoint.sqlite.transcriptEvents === 0) {
      failures.push(`${checkpoint.label}: retained transcript rows missing after reset`);
    }
  }
  if (checkpoint.label === "after-sessions-delete") {
    requireArchiveText(checkpoint, failures, {
      description: "deleted transcript archive",
      includes: ["delete me"],
      reason: "deleted",
      sessionId: "sqlite-delete-session",
    });
  }
  if (checkpoint.label === "after-doctor-import-idempotence") {
    const totals = checkpoint.doctor?.totals ?? {};
    if (totals.importedEntries !== 0 || totals.importedTranscriptEvents !== 0) {
      failures.push(`${checkpoint.label}: doctor import changed migrated SQLite state`);
    }
  }
  if (checkpoint.label === "after-shared-first-delete") {
    const archivedShared = findArchiveArtifact(checkpoint, {
      reason: "deleted",
      sessionId: "sqlite-shared-session",
    });
    if (archivedShared) {
      failures.push(
        `${checkpoint.label}: shared transcript archived before final reference delete`,
      );
    }
  }
  if (checkpoint.label === "after-shared-final-delete") {
    const deletedArchive = findArchiveArtifact(checkpoint, {
      reason: "deleted",
      sessionId: "sqlite-shared-session",
    });
    if (!deletedArchive) {
      // Both legacy files claim one session id, so the importer preserves the
      // ambiguous sources as artifacts instead of materializing duplicate rows.
      // Final deletion must not synthesize a second archive from empty SQLite state.
      for (const sourceName of ["sqlite-shared-a.jsonl", "sqlite-shared-b.jsonl"]) {
        requireArchiveText(checkpoint, failures, {
          description: `retained shared import source ${sourceName}`,
          includes: ["shared"],
          pathIncludes: sourceName,
        });
      }
    }
  }
}

function requireArchiveText(
  checkpoint: ProofCheckpoint,
  failures: string[],
  params: {
    description: string;
    includes: string[];
    pathIncludes?: string;
    reason?: "deleted" | "reset";
    sessionId?: string;
  },
): void {
  const artifact = findArchiveArtifact(checkpoint, params);
  if (!artifact) {
    failures.push(`${checkpoint.label}: missing ${params.description}`);
    return;
  }
  const searchableText = [
    artifact.textTail,
    ...(artifact.messageTexts ?? []),
    ...(artifact.jsonlTypes ?? []),
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const missing = params.includes.filter((expected) => !searchableText.includes(expected));
  if (missing.length > 0) {
    failures.push(
      `${checkpoint.label}: ${params.description} missing archive content ${missing
        .map((value) => JSON.stringify(value))
        .join(", ")} in ${artifact.path}`,
    );
  }
}

function findArchiveArtifact(
  checkpoint: ProofCheckpoint,
  params: {
    pathIncludes?: string;
    reason?: "deleted" | "reset";
    sessionId?: string;
  },
): FileInventoryEntry | undefined {
  return checkpoint.archiveArtifacts.find(
    (artifact) =>
      (!params.pathIncludes || artifact.path.includes(params.pathIncludes)) &&
      (!params.reason || artifact.archiveReason === params.reason) &&
      (!params.sessionId || artifact.archiveSessionId === params.sessionId),
  );
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function tail(value: string, maxChars = 8_000): string {
  return value.length > maxChars ? value.slice(value.length - maxChars) : value;
}

function printCheckpoint(checkpoint: ProofCheckpoint): void {
  process.stderr.write(
    [
      `[sqlite-sessions-transcripts-flip-proof] ${checkpoint.label}`,
      `  sqlite sessions=${checkpoint.sqlite.sessions} entries=${checkpoint.sqlite.sessionEntries} transcriptEvents=${checkpoint.sqlite.transcriptEvents}`,
      `  activeJsonl=${checkpoint.activeJsonl.length} legacyStateJsonl=${checkpoint.legacyStateJsonl.length} archiveArtifacts=${checkpoint.archiveArtifacts.length}`,
      checkpoint.doctor
        ? `  doctor ${checkpoint.doctor.mode} code=${String(checkpoint.doctor.code)} totals=${JSON.stringify(
            checkpoint.doctor.totals ?? {},
          )}`
        : undefined,
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n") + "\n",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await runSqliteSessionsTranscriptsFlipProof({ print: true });
  process.exit(report.ok ? 0 : 1);
}
