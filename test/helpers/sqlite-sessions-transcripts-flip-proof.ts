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
import {
  readSessionArchiveContentSync,
  stripSessionArchiveCompressionSuffix,
} from "../../src/config/sessions/archive-compression.js";
import {
  appendTranscriptMessage,
  type TranscriptEvent,
} from "../../src/config/sessions/session-accessor.js";
import { importSqliteSessionRows } from "../../src/config/sessions/session-accessor.sqlite.js";
import { formatSqliteSessionFileMarker } from "../../src/config/sessions/sqlite-marker.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../src/gateway/test-helpers.e2e.js";
import {
  getSessionEntry as getSdkSessionEntry,
  listSessionEntries as listSdkSessionEntries,
  loadTranscriptEventsSync as loadSdkTranscriptEventsSync,
} from "../../src/plugin-sdk/session-store-runtime.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readLatestAssistantTextByIdentity,
  readSessionTranscriptEvents,
  resolveSessionTranscriptIdentity,
} from "../../src/plugin-sdk/session-transcript-runtime.js";
import { sleep } from "../../src/utils.js";
import { normalizeSessionDeliveryState } from "../../src/utils/delivery-context.shared.js";
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";

type DoctorMode = "import" | "inspect" | "validate" | "restore";
type ProofChildProcess = ChildProcessByStdio<null, Readable, Readable>;

type DoctorMigrationRunEvidence = {
  failureReportJsonPath?: string;
  failureReportMarkdownPath?: string;
  manifestPath: string;
  runId: string;
};

type DoctorRestoreEvidence = {
  conflicts: number;
  manifestPaths: string[];
  restoredFiles: string[];
  skippedFiles: string[];
};

type DoctorCommandEvidence = {
  code: number | null;
  mode: DoctorMode;
  migrationRun?: DoctorMigrationRunEvidence;
  restore?: DoctorRestoreEvidence;
  stderrTail: string;
  stdoutTail: string;
  totals?: Record<string, unknown>;
};

type FileInventoryEntry = {
  archiveReason?: "bak" | "deleted" | "reset";
  archiveSessionId?: string;
  path: string;
  bytes: number;
  jsonlTypes?: string[];
  lines?: number;
  messageRoles?: string[];
  messageTexts?: string[];
  textTail?: string;
};

type SqliteSessionEntryEvidence = {
  entry?: Record<string, unknown>;
  sessionId: string;
  sessionKey: string;
  trajectoryEvents: number;
  transcriptEvents: number;
};

type SqliteEvidence = {
  exists: boolean;
  path: string;
  sessionEntries: number;
  sessions: number;
  trajectoryRuntimeEvents: number;
  transcriptEvents: number;
  trackedEntries: SqliteSessionEntryEvidence[];
};

type ProofCheckpoint = {
  activeJsonl: FileInventoryEntry[];
  archiveArtifacts: FileInventoryEntry[];
  doctor?: DoctorCommandEvidence;
  gatewayLogTail?: string;
  label: string;
  legacyStateJsonl: FileInventoryEntry[];
  sqlite: SqliteEvidence;
};

type PluginSdkConsumerEvidence = {
  activeJsonlForSessionExists: boolean;
  activeTrajectoryPointerForSessionExists: boolean;
  activeTrajectoryRuntimeSidecarForSessionExists: boolean;
  activeTrajectorySessionSidecarForSessionExists: boolean;
  appendedMessageId: string;
  identityMemoryKey: string;
  latestAssistantTextBeforeAppend: string;
  latestAssistantTextAfterAppend: string;
  listedSessionKeys: string[];
  sessionFileMarker: string;
  sessionId: string;
  sessionKey: string;
  storeTranscriptEvents: number;
  transcriptEventsAfterAppend: number;
  transcriptEventsBeforeAppend: number;
};

type ManualCompactionEvidence = {
  checkpointCount: number;
  compacted: boolean;
  rowCountAfter: number;
  rowCountBefore: number;
  sessionFileMarker: string;
  sessionId: string;
  sessionKey: string;
};

type ScaleMigrationEvidence = {
  importedSessionKeys: string[];
  minTranscriptEventsPerSession: number;
  seededEvents: number;
  seededSessions: number;
  startupImportElapsedMs: number;
};

type DowngradeReupgradeEvidence = {
  activeJsonlArchived: boolean;
  doctorImportedEntries: number;
  doctorImportedTranscriptEvents: number;
  trajectoryPointerArchived: boolean;
  trajectoryPointerSourceRemoved: boolean;
  trajectorySidecarArchived: boolean;
  trajectorySidecarSourceRemoved: boolean;
  sessionId: string;
  sessionKey: string;
  transcriptEvents: number;
};

type BusyContentionEvidence = {
  childExitCode: number | null;
  childSignal: NodeJS.Signals | null;
  elapsedMs: number;
  holdMs: number;
  sessionId: string;
  sessionKey: string;
  transcriptEvents: number;
};

type SecondStartupAfterResetEvidence = {
  activeJsonlForSessionExists: boolean;
  historyContainsPostResetAppend: boolean;
  sessionId: string;
  sessionKey: string;
  transcriptEvents: number;
};

type RollbackRestoreEvidence = {
  archivePath: string;
  archivedBeforeRestore: boolean;
  failedManifestIssueCode: string;
  idempotentRestoreSkippedFiles: string[];
  manifestPath: string;
  restoredFiles: string[];
  sourcePath: string;
  sourceRestored: boolean;
  sqliteStillExists: boolean;
};

type SqliteSessionsTranscriptsFlipProofReport = {
  ok: boolean;
  agentId: string;
  checkpoints: ProofCheckpoint[];
  cleanupPruneSessionKey: string;
  concurrentDeleteSessionKey: string;
  concurrentResetSessionKey: string;
  concurrentSendSessionKey: string;
  deleteSessionKey: string;
  failures: string[];
  fullTurnAssistantText: string;
  fullTurnSessionKey: string;
  gatewayEntrypoint: string[];
  legacySessionId: string;
  manualCompaction?: ManualCompactionEvidence;
  manualCompactionSessionKey: string;
  mockOpenAiRequestLog: string;
  oldStateSessionKeys: string[];
  pluginSdkConsumer?: PluginSdkConsumerEvidence;
  pluginSdkSessionKey: string;
  resetSessionKey: string;
  rollbackRestore?: RollbackRestoreEvidence;
  busyContention?: BusyContentionEvidence;
  downgradeReupgrade?: DowngradeReupgradeEvidence;
  scaleMigration?: ScaleMigrationEvidence;
  secondStartupAfterReset?: SecondStartupAfterResetEvidence;
  sharedSessionKeys: string[];
  stateDir: string;
};

type ProofContext = {
  activeSessionsDir: string;
  agentDbPath: string;
  agentId: string;
  archiveRoots: string[];
  cleanupPruneSessionKey: string;
  concurrentDeleteSessionKey: string;
  concurrentResetSessionKey: string;
  concurrentSendSessionKey: string;
  deleteSessionKey: string;
  fullTurnAssistantText: string;
  fullTurnSessionKey: string;
  legacySessionsDir: string;
  legacySessionId: string;
  manualCompactionSessionKey: string;
  mockOpenAiRequestLog: string;
  oldStateSessionKeys: string[];
  pluginSdkAppendText: string;
  pluginSdkSessionKey: string;
  resetSessionKey: string;
  sharedSessionKeys: string[];
  stateDir: string;
  storePath: string;
  trackedSessionKeys: string[];
};

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
const CLEANUP_PRUNE_SESSION_ID = "sqlite-cleanup-prune";
const CLEANUP_PRUNE_SESSION_KEY = "agent:main:dashboard:sqlite-cleanup-prune";
const CLEANUP_PRUNE_TEXT = "sqlite cleanup prune me";
const FULL_TURN_ASSISTANT_TEXT = "OPENCLAW_E2E_OK_12";
const FULL_TURN_SESSION_KEY = "agent:main:sqlite-full-turn";
const MANUAL_COMPACTION_SESSION_KEY = "agent:main:dashboard:sqlite-manual-compact";
const PLUGIN_SDK_APPEND_TEXT = "sqlite sdk consumer appended by identity";
const PLUGIN_SDK_SESSION_KEY = "agent:main:dashboard:sqlite-sdk-consumer";
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
export async function runSqliteSessionsTranscriptsFlipProof(
  options: RunOptions = {},
): Promise<SqliteSessionsTranscriptsFlipProofReport> {
  const print = options.print ?? false;
  const mockOpenAiPort = await getFreeTcpPort();
  const inst = await createOpenClawTestInstance({
    name: `sqlite-sessions-transcripts-flip-${randomUUID()}`,
    config: buildMockOpenAiConfig(mockOpenAiPort),
    env: {
      OPENAI_API_KEY: "sk-openclaw-e2e-mock",
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
    },
    startTimeoutMs: 90_000,
    stopTimeoutMs: 3_000,
  });
  // The proof mixes child-process CLI calls with in-process SDK accessors.
  // Apply the fixture environment so both paths resolve the same isolated DB.
  inst.state.applyEnv();
  const context = buildProofContext(inst.stateDir);
  const checkpoints: ProofCheckpoint[] = [];
  const failures: string[] = [];
  let gatewayEntrypoint: string[] = [];
  let busyContention: BusyContentionEvidence | undefined;
  let downgradeReupgrade: DowngradeReupgradeEvidence | undefined;
  let manualCompaction: ManualCompactionEvidence | undefined;
  let mockOpenAi: ProofChildProcess | undefined;
  let pluginSdkConsumer: PluginSdkConsumerEvidence | undefined;
  let rollbackRestore: RollbackRestoreEvidence | undefined;
  let scaleMigration: ScaleMigrationEvidence | undefined;
  let secondStartupAfterReset: SecondStartupAfterResetEvidence | undefined;

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

    mockOpenAi = await startMockOpenAiServer({
      port: mockOpenAiPort,
      requestLogPath: context.mockOpenAiRequestLog,
      responseText: context.fullTurnAssistantText,
    });

    await seedLegacySessionStore(context);
    await record("seeded-legacy-store");

    const startupImportStartedAt = Date.now();
    await inst.startGateway();
    await record("after-startup-import");
    scaleMigration = requireScaleMigrationProof(context, Date.now() - startupImportStartedAt);

    const inspectDoctor = await runDoctor(inst, "inspect", context.storePath);
    await record("after-doctor-inspect", inspectDoctor);

    const validateDoctor = await runDoctor(inst, "validate", context.storePath);
    await record("after-doctor-validate", validateDoctor);

    rollbackRestore = await runRollbackRestoreProof(inst, context);
    await record("after-rollback-restore");

    const client = await connectGatewayClient({
      url: inst.url,
      token: inst.gatewayToken,
      clientDisplayName: "sqlite-sessions-transcripts-flip-proof",
      requestTimeoutMs: 20_000,
      timeoutMs: 20_000,
    });
    try {
      await waitForHistoryContains(client, context.resetSessionKey, "legacy hello");
    } finally {
      await disconnectGatewayClient(client);
    }

    await inst.stopGateway();
    await inst.startGateway();
    await record("after-gateway-restart");

    const restartedClient = await connectGatewayClient({
      url: inst.url,
      token: inst.gatewayToken,
      clientDisplayName: "sqlite-sessions-transcripts-flip-proof-restart",
      requestTimeoutMs: 20_000,
      timeoutMs: 20_000,
    });
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

      manualCompaction = await runManualCompactionProof(restartedClient, context);
      await record("after-manual-compaction");

      const pluginSdkRunId = await sendGatewayUserMessage(
        restartedClient,
        context.pluginSdkSessionKey,
        `Reply with exactly ${context.fullTurnAssistantText}. SDK consumer proof.`,
      );
      await waitForAgentRunOk(restartedClient, pluginSdkRunId);
      const pluginSdkSessionId = await waitForSqliteSessionId(
        context.agentDbPath,
        context.pluginSdkSessionKey,
      );
      await waitForSqliteMessageContains(
        context.agentDbPath,
        pluginSdkSessionId,
        "assistant",
        context.fullTurnAssistantText,
      );
      pluginSdkConsumer = await runPluginSdkConsumerProbe(context, pluginSdkSessionId);
      await waitForSqliteMessageContains(
        context.agentDbPath,
        pluginSdkSessionId,
        "assistant",
        context.pluginSdkAppendText,
      );
      await record("after-plugin-sdk-consumer");

      await runGatewayCleanupPruningProof(restartedClient, context);
      await record("after-cleanup-pruning");

      const idempotentImportDoctor = await runDoctorIdempotenceProof(inst, context);
      await record("after-doctor-import-idempotence", idempotentImportDoctor);

      downgradeReupgrade = await runDowngradeReupgradeProof(inst, context);
      await record("after-downgrade-reupgrade-import");

      busyContention = await runSqliteBusyContentionProof(context);
      await record("after-sqlite-busy-contention");

      await runConcurrentMultiClientLifecycle(inst, context, restartedClient);
      await record("after-concurrent-multi-client");

      const resetSessionId = await resetSession(restartedClient, context.resetSessionKey);
      await record("after-sessions-reset");

      await disconnectGatewayClient(restartedClient);
      restartedClientConnected = false;
      await inst.stopGateway();
      await inst.startGateway();
      await record("after-second-startup-after-reset");

      const postResetClient = await connectGatewayClient({
        url: inst.url,
        token: inst.gatewayToken,
        clientDisplayName: "sqlite-sessions-transcripts-flip-proof-post-reset-restart",
        requestTimeoutMs: 20_000,
        timeoutMs: 20_000,
      });
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
    failures.push(error instanceof Error ? error.message : String(error));
    await record("failure");
  } finally {
    await stopChildProcess(mockOpenAi);
    await inst.cleanup();
  }

  const report: SqliteSessionsTranscriptsFlipProofReport = {
    ok: failures.length === 0,
    agentId: context.agentId,
    checkpoints,
    cleanupPruneSessionKey: context.cleanupPruneSessionKey,
    concurrentDeleteSessionKey: context.concurrentDeleteSessionKey,
    concurrentResetSessionKey: context.concurrentResetSessionKey,
    concurrentSendSessionKey: context.concurrentSendSessionKey,
    deleteSessionKey: context.deleteSessionKey,
    failures,
    fullTurnAssistantText: context.fullTurnAssistantText,
    fullTurnSessionKey: context.fullTurnSessionKey,
    gatewayEntrypoint,
    legacySessionId: context.legacySessionId,
    ...(manualCompaction ? { manualCompaction } : {}),
    manualCompactionSessionKey: context.manualCompactionSessionKey,
    mockOpenAiRequestLog: context.mockOpenAiRequestLog,
    oldStateSessionKeys: [...context.oldStateSessionKeys],
    ...(pluginSdkConsumer ? { pluginSdkConsumer } : {}),
    pluginSdkSessionKey: context.pluginSdkSessionKey,
    resetSessionKey: context.resetSessionKey,
    ...(rollbackRestore ? { rollbackRestore } : {}),
    ...(busyContention ? { busyContention } : {}),
    ...(downgradeReupgrade ? { downgradeReupgrade } : {}),
    ...(scaleMigration ? { scaleMigration } : {}),
    ...(secondStartupAfterReset ? { secondStartupAfterReset } : {}),
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

function buildProofContext(stateDir: string): ProofContext {
  const agentDir = path.join(stateDir, "agents", AGENT_ID);
  const activeSessionsDir = path.join(agentDir, "sessions");
  const legacySessionsDir = path.join(stateDir, "sessions");
  return {
    activeSessionsDir,
    agentDbPath: path.join(agentDir, "agent", "openclaw-agent.sqlite"),
    agentId: AGENT_ID,
    archiveRoots: [path.join(agentDir, "session-sqlite-import-archive"), activeSessionsDir],
    cleanupPruneSessionKey: CLEANUP_PRUNE_SESSION_KEY,
    concurrentDeleteSessionKey: CONCURRENT_DELETE_SESSION_KEY,
    concurrentResetSessionKey: CONCURRENT_RESET_SESSION_KEY,
    concurrentSendSessionKey: CONCURRENT_SEND_SESSION_KEY,
    deleteSessionKey: DELETE_SESSION_KEY,
    fullTurnAssistantText: FULL_TURN_ASSISTANT_TEXT,
    fullTurnSessionKey: FULL_TURN_SESSION_KEY,
    legacySessionsDir,
    legacySessionId: "sqlite-legacy-main",
    manualCompactionSessionKey: MANUAL_COMPACTION_SESSION_KEY,
    mockOpenAiRequestLog: path.join(stateDir, "mock-openai-requests.ndjson"),
    oldStateSessionKeys: [...OLD_STATE_SESSION_KEYS],
    pluginSdkAppendText: PLUGIN_SDK_APPEND_TEXT,
    pluginSdkSessionKey: PLUGIN_SDK_SESSION_KEY,
    resetSessionKey: RESET_SESSION_KEY,
    sharedSessionKeys: [...SHARED_SESSION_KEYS],
    stateDir,
    storePath: path.join(activeSessionsDir, "sessions.json"),
    trackedSessionKeys: [
      RESET_SESSION_KEY,
      DELETE_SESSION_KEY,
      CLEANUP_PRUNE_SESSION_KEY,
      CONCURRENT_SEND_SESSION_KEY,
      CONCURRENT_RESET_SESSION_KEY,
      CONCURRENT_DELETE_SESSION_KEY,
      FULL_TURN_SESSION_KEY,
      MANUAL_COMPACTION_SESSION_KEY,
      PLUGIN_SDK_SESSION_KEY,
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
        models: {
          [modelRef]: {
            agentRuntime: { id: "openclaw" },
            params: { openaiWsWarmup: false, transport: "sse" },
          },
        },
      },
      entries: { main: { default: true } },
    },
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
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `mock OpenAI exited before listening (code=${String(child.exitCode)} signal=${String(
          child.signalCode,
        )})\n${tail(output)}`,
      );
    }
    if (output.includes("mock-openai listening")) {
      return child;
    }
    await sleep(25);
  }
  await stopChildProcess(child);
  throw new Error(`timeout waiting for mock OpenAI server\n${tail(output)}`);
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
  await fs.writeFile(context.storePath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(
    path.join(context.legacySessionsDir, "sessions.json"),
    `${JSON.stringify(oldStateEntries, null, 2)}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(context.stateDir, "agent", "old-settings.json"),
    `${JSON.stringify({ source: "old-agent-layout" })}\n`,
    { mode: 0o600 },
  );
  await writeTranscript(context.legacySessionsDir, context.legacySessionId, [
    legacySessionEvent(context.legacySessionId),
    { type: "message", id: "sqlite-user-1", message: { role: "user", content: "legacy hello" } },
  ]);
  await writeTranscript(context.legacySessionsDir, "sqlite-old-direct", [
    legacySessionEvent("sqlite-old-direct"),
    { type: "message", id: "sqlite-old-direct-1", message: { role: "user", content: "old dm" } },
  ]);
  await writeTranscript(context.legacySessionsDir, "sqlite-old-group", [
    legacySessionEvent("sqlite-old-group"),
    { type: "message", id: "sqlite-old-group-1", message: { role: "user", content: "old group" } },
  ]);
  await writeTranscript(context.activeSessionsDir, "sqlite-delete-session", [
    legacySessionEvent("sqlite-delete-session"),
    { type: "message", id: "sqlite-delete-1", message: { role: "user", content: "delete me" } },
  ]);
  await writeTranscript(context.activeSessionsDir, "sqlite-concurrent-reset", [
    legacySessionEvent("sqlite-concurrent-reset"),
    {
      type: "message",
      id: "sqlite-concurrent-reset-1",
      message: { role: "user", content: "concurrent reset seed" },
    },
  ]);
  await writeTranscript(context.activeSessionsDir, "sqlite-concurrent-delete", [
    legacySessionEvent("sqlite-concurrent-delete"),
    {
      type: "message",
      id: "sqlite-concurrent-delete-1",
      message: { role: "user", content: "concurrent delete seed" },
    },
  ]);
  await writeTranscript(context.activeSessionsDir, "sqlite-shared-a", [
    legacySessionEvent("sqlite-shared-session"),
    { type: "message", id: "sqlite-shared-1", message: { role: "user", content: "shared" } },
  ]);
  await writeTranscript(context.activeSessionsDir, "sqlite-shared-b", [
    legacySessionEvent("sqlite-shared-session"),
    { type: "message", id: "sqlite-shared-2", message: { role: "user", content: "shared b" } },
  ]);
  for (const [index] of SCALE_SESSION_KEYS.entries()) {
    const sessionId = scaleSessionId(index);
    await writeTranscript(context.activeSessionsDir, sessionId, [
      legacySessionEvent(sessionId),
      ...Array.from({ length: SCALE_EVENTS_PER_SESSION - 1 }, (_, eventIndex) => ({
        type: "message",
        id: `${sessionId}-${eventIndex + 1}`,
        message: {
          role: eventIndex % 2 === 0 ? "user" : "assistant",
          content: `sqlite scale ${index + 1} event ${eventIndex + 1}`,
        },
      })),
    ]);
  }
  await fs.writeFile(
    path.join(context.legacySessionsDir, `${context.legacySessionId}.trajectory.jsonl`),
    `${JSON.stringify({ type: "trajectory", sessionId: context.legacySessionId })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(context.legacySessionsDir, "old-orphan.deleted.jsonl"),
    `${JSON.stringify({ type: "event", id: "old-orphan" })}\n`,
    { mode: 0o600 },
  );
  const archiveDir = path.join(context.activeSessionsDir, "archive-fixture");
  await fs.mkdir(archiveDir, { recursive: true });
  await fs.writeFile(
    path.join(archiveDir, "cold-archive.jsonl"),
    `${JSON.stringify({ type: "event", id: "cold-archive" })}\n`,
    { mode: 0o600 },
  );
  await importSqliteSessionRows({
    agentId: context.agentId,
    entry: {
      ...legacyEntry("sqlite-partial-import", now - 7_000),
      sessionFile: formatSqliteSessionFileMarker({
        agentId: context.agentId,
        sessionId: "sqlite-partial-import",
        storePath: context.storePath,
      }),
    },
    readTranscriptEvents(append) {
      append(legacySessionEvent("sqlite-partial-import"));
      append({
        type: "message",
        id: "sqlite-partial-import-1",
        message: { role: "user", content: "already imported" },
      });
    },
    sessionKey: "agent:main:partial-direct",
    storePath: context.storePath,
  });
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

async function writeTranscript(
  sessionsDir: string,
  sessionId: string,
  events: TranscriptEvent[],
): Promise<void> {
  const body = events.map((event) => JSON.stringify(event)).join("\n");
  await fs.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), `${body}\n`, { mode: 0o600 });
}

async function runDoctor(
  inst: Awaited<ReturnType<typeof createOpenClawTestInstance>>,
  mode: DoctorMode,
  storePath: string,
): Promise<DoctorCommandEvidence> {
  const result = await inst.cli(
    ["doctor", "--session-sqlite", mode, "--session-sqlite-store", storePath, "--json"],
    { timeoutMs: 60_000 },
  );
  const parsed = parseJsonObject(result.stdout);
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

function parseDoctorMigrationRun(parsed: Record<string, unknown>): {
  migrationRun?: DoctorMigrationRunEvidence;
} {
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

function parseDoctorRestore(parsed: Record<string, unknown>): { restore?: DoctorRestoreEvidence } {
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

async function runRollbackRestoreProof(
  inst: Awaited<ReturnType<typeof createOpenClawTestInstance>>,
  context: ProofContext,
): Promise<RollbackRestoreEvidence> {
  const drillDir = path.join(context.stateDir, "rollback-drill");
  const storePath = path.join(drillDir, "sessions.json");
  const sessionId = "sqlite-rollback-restore";
  const sessionKey = "agent:main:rollback-restore";
  const sourcePath = path.join(drillDir, `${sessionId}.jsonl`);
  const sqlitePath = path.join(drillDir, "openclaw-agent.sqlite");
  await fs.mkdir(drillDir, { recursive: true });
  await fs.writeFile(
    storePath,
    `${JSON.stringify({ [sessionKey]: legacyEntry(sessionId, Date.now()) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeTranscript(drillDir, sessionId, [
    legacySessionEvent(sessionId),
    {
      type: "message",
      id: "sqlite-rollback-restore-1",
      message: { role: "user", content: "rollback restore me" },
    },
  ]);

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
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

async function appendProofMessage(
  context: ProofContext,
  sessionId: string,
  sessionKey: string,
  message: string,
): Promise<void> {
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
}

async function runManualCompactionProof(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  context: ProofContext,
): Promise<ManualCompactionEvidence> {
  const runId = await sendGatewayUserMessage(
    client,
    context.manualCompactionSessionKey,
    `Reply with exactly ${context.fullTurnAssistantText}. Manual compaction proof.`,
  );
  await waitForAgentRunOk(client, runId);
  const sessionId = await waitForSqliteSessionId(
    context.agentDbPath,
    context.manualCompactionSessionKey,
  );
  await waitForSqliteMessageContains(
    context.agentDbPath,
    sessionId,
    "assistant",
    context.fullTurnAssistantText,
  );
  const rowCountBefore = countSqliteTranscriptEvents(context.agentDbPath, sessionId);
  if (rowCountBefore < 2) {
    throw new Error(
      `manual compaction source transcript had too few rows: ${rowCountBefore} for ${sessionId}`,
    );
  }
  const listed: { sessions?: Array<{ key?: string; sessionId?: string }> } = await client.request(
    "sessions.list",
    {},
  );
  const listedSession = (listed.sessions ?? []).find(
    (session) =>
      session.sessionId === sessionId || session.key === context.manualCompactionSessionKey,
  );
  if (!listedSession?.key) {
    throw new Error(
      `manual compaction session was not listed before compact: ${JSON.stringify(listed)}`,
    );
  }

  const compacted: {
    compacted?: boolean;
    key?: string;
    ok?: boolean;
  } = await client.request("sessions.compact", {
    key: listedSession.key,
  });
  if (compacted.ok !== true || compacted.compacted !== true) {
    throw new Error(
      `manual compaction did not compact using ${listedSession.key}: ${JSON.stringify(
        compacted,
      )}; listed=${JSON.stringify(listed)}`,
    );
  }

  const evidence = readSqliteEvidence(context.agentDbPath, [context.manualCompactionSessionKey]);
  const row = evidence.trackedEntries.find(
    (entry) => entry.sessionKey === context.manualCompactionSessionKey,
  );
  if (!row?.entry) {
    throw new Error(`manual compaction entry missing for ${context.manualCompactionSessionKey}`);
  }
  const checkpointCount = Array.isArray(row.entry.compactionCheckpoints)
    ? row.entry.compactionCheckpoints.length
    : 0;
  if (checkpointCount < 1) {
    throw new Error(`manual compaction did not write checkpoint metadata: ${JSON.stringify(row)}`);
  }
  const sessionFileMarker = typeof row.entry.sessionFile === "string" ? row.entry.sessionFile : "";
  if (!sessionFileMarker.startsWith("sqlite:")) {
    throw new Error(`manual compaction entry did not keep a SQLite marker: ${sessionFileMarker}`);
  }
  if (fsSync.existsSync(sessionFileMarker)) {
    throw new Error(`manual compaction marker unexpectedly exists as a file: ${sessionFileMarker}`);
  }

  return {
    checkpointCount,
    compacted: compacted.compacted,
    rowCountAfter: countSqliteTranscriptEvents(context.agentDbPath, row.sessionId),
    rowCountBefore,
    sessionFileMarker,
    sessionId: row.sessionId,
    sessionKey: context.manualCompactionSessionKey,
  };
}

async function runPluginSdkConsumerProbe(
  context: ProofContext,
  sessionId: string,
): Promise<PluginSdkConsumerEvidence> {
  const scope = {
    agentId: context.agentId,
    sessionId,
    sessionKey: context.pluginSdkSessionKey,
    storePath: context.storePath,
  };
  const sessionEntry = getSdkSessionEntry({
    agentId: context.agentId,
    readConsistency: "latest",
    sessionKey: context.pluginSdkSessionKey,
    storePath: context.storePath,
  });
  if (sessionEntry?.sessionId !== sessionId) {
    throw new Error(
      `SDK session store read returned ${JSON.stringify(sessionEntry)} for ${context.pluginSdkSessionKey}`,
    );
  }
  const expectedMarker = formatSqliteSessionFileMarker({
    agentId: context.agentId,
    sessionId,
    storePath: context.storePath,
  });
  if (sessionEntry.sessionFile !== expectedMarker) {
    throw new Error(
      `SDK session store exposed unexpected transcript marker for ${context.pluginSdkSessionKey}: ${String(
        sessionEntry.sessionFile,
      )}`,
    );
  }
  if (fsSync.existsSync(sessionEntry.sessionFile)) {
    throw new Error(`SDK session marker unexpectedly resolves to an active file path`);
  }

  const listedSessionKeys = listSdkSessionEntries({
    agentId: context.agentId,
    storePath: context.storePath,
  }).map((entry) => entry.sessionKey);
  if (!listedSessionKeys.includes(context.pluginSdkSessionKey)) {
    throw new Error(`SDK session list omitted ${context.pluginSdkSessionKey}`);
  }

  const identity = await resolveSessionTranscriptIdentity(scope);
  const latestBefore = await readLatestAssistantTextByIdentity(scope);
  if (latestBefore?.text !== context.fullTurnAssistantText) {
    throw new Error(
      `SDK latest assistant read returned ${JSON.stringify(latestBefore)} for ${context.pluginSdkSessionKey}`,
    );
  }
  const transcriptEventsBeforeAppend = (await readSessionTranscriptEvents(scope)).length;
  const storeTranscriptEvents = loadSdkTranscriptEventsSync(scope).length;
  const activeJsonlPath = path.join(context.activeSessionsDir, `${sessionId}.jsonl`);
  const activeTrajectorySessionSidecarPath = path.join(
    context.activeSessionsDir,
    `${sessionId}.trajectory.jsonl`,
  );
  const activeTrajectoryPointerPath = path.join(
    context.activeSessionsDir,
    `${sessionId}.trajectory-path.json`,
  );
  const activeTrajectoryRuntimeSidecarPath = path.join(
    context.activeSessionsDir,
    "trajectory",
    `${sessionId}.jsonl`,
  );
  const activeJsonlForSessionExists = fsSync.existsSync(activeJsonlPath);
  if (activeJsonlForSessionExists) {
    throw new Error(`SDK probe found active JSONL for SQLite session at ${activeJsonlPath}`);
  }
  const activeTrajectorySessionSidecarForSessionExists = fsSync.existsSync(
    activeTrajectorySessionSidecarPath,
  );
  const activeTrajectoryPointerForSessionExists = fsSync.existsSync(activeTrajectoryPointerPath);
  const activeTrajectoryRuntimeSidecarForSessionExists = fsSync.existsSync(
    activeTrajectoryRuntimeSidecarPath,
  );
  if (
    activeTrajectorySessionSidecarForSessionExists ||
    activeTrajectoryPointerForSessionExists ||
    activeTrajectoryRuntimeSidecarForSessionExists
  ) {
    throw new Error(
      `SDK trajectory probe found active sidecar paths: ${JSON.stringify({
        pointer: activeTrajectoryPointerPath,
        runtime: activeTrajectoryRuntimeSidecarPath,
        session: activeTrajectorySessionSidecarPath,
      })}`,
    );
  }

  const appended = await appendSessionTranscriptMessageByIdentity({
    ...scope,
    message: {
      role: "assistant",
      content: [{ type: "text", text: context.pluginSdkAppendText }],
      timestamp: Date.now(),
    },
  });
  if (!appended?.appended || !appended.messageId) {
    throw new Error(`SDK transcript append failed for ${context.pluginSdkSessionKey}`);
  }

  const latestAfter = await readLatestAssistantTextByIdentity(scope);
  if (latestAfter?.text !== context.pluginSdkAppendText) {
    throw new Error(
      `SDK latest assistant after append returned ${JSON.stringify(latestAfter)} for ${
        context.pluginSdkSessionKey
      }`,
    );
  }
  const transcriptEventsAfterAppend = (await readSessionTranscriptEvents(scope)).length;
  if (transcriptEventsAfterAppend <= transcriptEventsBeforeAppend) {
    throw new Error(
      `SDK transcript append did not increase event count for ${context.pluginSdkSessionKey}`,
    );
  }
  return {
    activeJsonlForSessionExists,
    activeTrajectoryPointerForSessionExists,
    activeTrajectoryRuntimeSidecarForSessionExists,
    activeTrajectorySessionSidecarForSessionExists,
    appendedMessageId: appended.messageId,
    identityMemoryKey: identity.memoryKey,
    latestAssistantTextBeforeAppend: latestBefore.text,
    latestAssistantTextAfterAppend: latestAfter.text,
    listedSessionKeys,
    sessionFileMarker: sessionEntry.sessionFile,
    sessionId,
    sessionKey: context.pluginSdkSessionKey,
    storeTranscriptEvents,
    transcriptEventsAfterAppend,
    transcriptEventsBeforeAppend,
  };
}

async function runGatewayCleanupPruningProof(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  context: ProofContext,
): Promise<void> {
  const updatedAt = Date.now() - 31 * 24 * 60 * 60 * 1000;
  await importSqliteSessionRows({
    agentId: context.agentId,
    entry: {
      delivery: normalizeSessionDeliveryState({ context: { channel: "cli" } }),
      chatType: "direct",
      sessionFile: formatSqliteSessionFileMarker({
        agentId: context.agentId,
        sessionId: CLEANUP_PRUNE_SESSION_ID,
        storePath: context.storePath,
      }),
      sessionId: CLEANUP_PRUNE_SESSION_ID,
      sessionStartedAt: updatedAt - 500,
      updatedAt,
    },
    readTranscriptEvents(append) {
      append(legacySessionEvent(CLEANUP_PRUNE_SESSION_ID));
      append({
        type: "message",
        id: "sqlite-cleanup-prune-1",
        message: { role: "user", content: CLEANUP_PRUNE_TEXT },
      });
    },
    sessionKey: context.cleanupPruneSessionKey,
    storePath: context.storePath,
  });
  await waitForSqliteMessageContains(
    context.agentDbPath,
    CLEANUP_PRUNE_SESSION_ID,
    "user",
    CLEANUP_PRUNE_TEXT,
  );

  const result: { afterCount?: number; applied?: boolean; pruned?: number } = await client.request(
    "sessions.cleanup",
    { enforce: true },
    { timeoutMs: 20_000 },
  );
  if (result?.applied !== true || (result.pruned ?? 0) < 1) {
    throw new Error(`sessions.cleanup did not prune stale SQLite rows: ${JSON.stringify(result)}`);
  }
  await waitForSessionEntryAbsent(context.agentDbPath, context.cleanupPruneSessionKey);
  await waitForSqliteEventsAbsent(context.agentDbPath, CLEANUP_PRUNE_SESSION_ID);
}

async function runDoctorIdempotenceProof(
  inst: Awaited<ReturnType<typeof createOpenClawTestInstance>>,
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

function requireScaleMigrationProof(
  context: ProofContext,
  startupImportElapsedMs: number,
): ScaleMigrationEvidence {
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
    startupImportElapsedMs,
  };
}

async function runDowngradeReupgradeProof(
  inst: Awaited<ReturnType<typeof createOpenClawTestInstance>>,
  context: ProofContext,
): Promise<DowngradeReupgradeEvidence> {
  await fs.mkdir(context.activeSessionsDir, { recursive: true });
  await fs.writeFile(
    context.storePath,
    `${JSON.stringify(
      {
        [DOWNGRADE_REUPGRADE_SESSION_KEY]: legacyEntry(DOWNGRADE_REUPGRADE_SESSION_ID, Date.now()),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const transcriptPath = path.join(
    context.activeSessionsDir,
    `${DOWNGRADE_REUPGRADE_SESSION_ID}.jsonl`,
  );
  const trajectoryPath = path.join(
    context.activeSessionsDir,
    `${DOWNGRADE_REUPGRADE_SESSION_ID}.trajectory.jsonl`,
  );
  const trajectoryPointerPath = path.join(
    context.activeSessionsDir,
    `${DOWNGRADE_REUPGRADE_SESSION_ID}.trajectory-path.json`,
  );
  await writeTranscript(context.activeSessionsDir, DOWNGRADE_REUPGRADE_SESSION_ID, [
    legacySessionEvent(DOWNGRADE_REUPGRADE_SESSION_ID),
    {
      type: "message",
      id: "sqlite-downgrade-reupgrade-1",
      message: { role: "user", content: DOWNGRADE_REUPGRADE_TEXT },
    },
  ]);
  await fs.writeFile(
    trajectoryPath,
    `${JSON.stringify({ type: "trajectory", sessionId: DOWNGRADE_REUPGRADE_SESSION_ID })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    trajectoryPointerPath,
    `${JSON.stringify({
      traceSchema: "openclaw-trajectory-pointer",
      schemaVersion: 1,
      sessionId: DOWNGRADE_REUPGRADE_SESSION_ID,
      runtimeFile: trajectoryPath,
    })}\n`,
    { mode: 0o600 },
  );

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

async function runSqliteBusyContentionProof(
  context: ProofContext,
): Promise<BusyContentionEvidence> {
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
  let childOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    childOutput += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    childOutput += String(chunk);
  });

  await waitForFile(readyPath, 10_000, () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `SQLite busy child exited before acquiring lock code=${String(
          child.exitCode,
        )} signal=${String(child.signalCode)} ${tail(childOutput)}`,
      );
    }
  });

  const startedAt = Date.now();
  const result = await importSqliteSessionRows({
    agentId: context.agentId,
    entry: legacyEntry(SQLITE_BUSY_SESSION_ID, Date.now()),
    readTranscriptEvents(append) {
      append(legacySessionEvent(SQLITE_BUSY_SESSION_ID));
      append({
        type: "message",
        id: "sqlite-busy-contention-1",
        message: { role: "user", content: SQLITE_BUSY_TEXT },
      });
    },
    sessionKey: SQLITE_BUSY_SESSION_KEY,
    storePath: context.storePath,
  });
  const elapsedMs = Date.now() - startedAt;
  const exit = await waitForChildExit(child, 10_000);
  if (exit.code !== 0) {
    throw new Error(
      `SQLite busy child exited non-zero code=${String(exit.code)} signal=${String(
        exit.signal,
      )} ${tail(childOutput)}`,
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
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  context: ProofContext,
  resetSessionId: string,
): Promise<SecondStartupAfterResetEvidence> {
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
  inst: Awaited<ReturnType<typeof createOpenClawTestInstance>>,
  context: ProofContext,
  primaryClient: Awaited<ReturnType<typeof connectGatewayClient>>,
): Promise<void> {
  const historyClient = await connectGatewayClient({
    url: inst.url,
    token: inst.gatewayToken,
    clientDisplayName: "sqlite-sessions-transcripts-flip-proof-concurrent-history",
    requestTimeoutMs: 20_000,
    timeoutMs: 20_000,
  });
  const lifecycleClient = await connectGatewayClient({
    url: inst.url,
    token: inst.gatewayToken,
    clientDisplayName: "sqlite-sessions-transcripts-flip-proof-concurrent-lifecycle",
    requestTimeoutMs: 20_000,
    timeoutMs: 20_000,
  });
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
      { timeoutMs: 20_000 },
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
      { timeoutMs: 20_000 },
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

async function resetSession(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  key: string,
): Promise<string> {
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
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
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
    { timeoutMs: 20_000 },
  );
  if (result?.status !== "started" || typeof result.runId !== "string") {
    throw new Error(`chat.send did not start correctly: ${JSON.stringify(result)}`);
  }
  return result.runId;
}

async function waitForAgentRunOk(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  runId: string,
): Promise<void> {
  const result: { error?: unknown; status?: string } = await client.request(
    "agent.wait",
    { runId, timeoutMs: 60_000 },
    { timeoutMs: 65_000 },
  );
  if (result?.status !== "ok") {
    throw new Error(`agent.wait failed for ${runId}: ${JSON.stringify(result)}`);
  }
}

async function waitForAgentRunSettled(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  runId: string,
): Promise<void> {
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

async function deleteSession(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  key: string,
): Promise<void> {
  const result: { ok?: boolean; deleted?: boolean } = await client.request("sessions.delete", {
    key,
    deleteTranscript: true,
  });
  if (result?.ok !== true || result.deleted !== true) {
    throw new Error(`sessions.delete failed for ${key}: ${JSON.stringify(result)}`);
  }
}

async function requireTrackedSession(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  key: string,
): Promise<void> {
  const result: { sessions?: Array<{ key?: string }> } = await client.request("sessions.list", {});
  if (!result.sessions?.some((session) => session.key === key)) {
    throw new Error(`expected session ${key} to remain listed`);
  }
}

async function requireHistoryContains(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
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
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
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
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  sessionKey: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await requireHistoryContains(client, sessionKey, expected);
      return;
    } catch {
      await sleep(50);
    }
  }
  await requireHistoryContains(client, sessionKey, expected);
}

async function waitForHistoryRoleContains(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  sessionKey: string,
  role: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await requireHistoryRoleContains(client, sessionKey, role, expected);
      return;
    } catch {
      await sleep(50);
    }
  }
  await requireHistoryRoleContains(client, sessionKey, role, expected);
}

async function waitForSqliteEvents(
  dbPath: string,
  sessionId: string,
  minEvents: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const sqlite = readSqliteEvidence(dbPath, []);
    const row = sqlite.trackedEntries.find((entry) => entry.sessionId === sessionId);
    if ((row?.transcriptEvents ?? 0) >= minEvents) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${minEvents} SQLite events for ${sessionId}`);
}

async function waitForSqliteSessionId(dbPath: string, sessionKey: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const row = readSqliteEvidence(dbPath, [sessionKey]).trackedEntries.find(
      (entry) => entry.sessionKey === sessionKey && entry.sessionId,
    );
    if (row?.sessionId) {
      return row.sessionId;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for SQLite session entry for ${sessionKey}`);
}

async function waitForTrackedSessionId(
  dbPath: string,
  sessionKey: string,
  expectedSessionId: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const row = readSqliteEvidence(dbPath, [sessionKey]).trackedEntries.find(
      (entry) => entry.sessionKey === sessionKey,
    );
    if (row?.sessionId === expectedSessionId) {
      return;
    }
    await sleep(50);
  }
  throw new Error(
    `timed out waiting for SQLite session entry ${sessionKey} to point at ${expectedSessionId}`,
  );
}

async function waitForSessionEntryAbsent(dbPath: string, sessionKey: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let absentSince: number | undefined;
  while (Date.now() < deadline) {
    const row = readSqliteEvidence(dbPath, [sessionKey]).trackedEntries.find(
      (entry) => entry.sessionKey === sessionKey,
    );
    if (!row) {
      absentSince ??= Date.now();
      if (Date.now() - absentSince >= 1_500) {
        return;
      }
      await sleep(50);
      continue;
    }
    absentSince = undefined;
    await sleep(50);
  }
  throw new Error(`timed out waiting for SQLite session entry deletion for ${sessionKey}`);
}

async function waitForSqliteEventsAbsent(dbPath: string, sessionId: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let absentSince: number | undefined;
  while (Date.now() < deadline) {
    const count = countSqliteTranscriptEvents(dbPath, sessionId);
    if (count === 0) {
      absentSince ??= Date.now();
      if (Date.now() - absentSince >= 1_500) {
        return;
      }
      await sleep(50);
      continue;
    }
    absentSince = undefined;
    await sleep(50);
  }
  throw new Error(`timed out waiting for SQLite transcript row deletion for ${sessionId}`);
}

async function waitForSqliteMessageContains(
  dbPath: string,
  sessionId: string,
  role: "assistant" | "user",
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const messages = readSqliteTranscriptMessages(dbPath, sessionId);
    if (
      messages.some(
        (message) => message.role === role && JSON.stringify(message.content).includes(expected),
      )
    ) {
      return;
    }
    await sleep(50);
  }
  throw new Error(
    `timed out waiting for SQLite ${role} transcript message containing ${JSON.stringify(
      expected,
    )} for ${sessionId}: ${JSON.stringify(readSqliteTranscriptMessages(dbPath, sessionId))}`,
  );
}

async function waitForFile(filePath: string, timeoutMs: number, poll: () => void): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    poll();
    if (fsSync.existsSync(filePath)) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${filePath}`);
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
  if (!fsSync.existsSync(dbPath)) {
    return [];
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
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
  } finally {
    db.close();
  }
}

function countSqliteTranscriptEvents(dbPath: string, sessionId: string): number {
  if (!fsSync.existsSync(dbPath)) {
    return 0;
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return scalarNumber(
      db,
      "SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?",
      [sessionId],
    );
  } finally {
    db.close();
  }
}

async function captureCheckpoint(
  context: ProofContext,
  label: string,
  options: { doctor?: DoctorCommandEvidence; gatewayLogTail?: string },
): Promise<ProofCheckpoint> {
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

async function inventoryFile(filePath: string, relativeRoot: string): Promise<FileInventoryEntry> {
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
): Pick<FileInventoryEntry, "archiveReason" | "archiveSessionId"> | undefined {
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

function readSqliteEvidence(dbPath: string, trackedSessionKeys: readonly string[]): SqliteEvidence {
  if (!fsSync.existsSync(dbPath)) {
    return {
      exists: false,
      path: dbPath,
      sessionEntries: 0,
      sessions: 0,
      trackedEntries: [],
      trajectoryRuntimeEvents: 0,
      transcriptEvents: 0,
    };
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const trackedEntries = readTrackedEntries(db, trackedSessionKeys);
    return {
      exists: true,
      path: dbPath,
      sessionEntries: scalarNumber(db, "SELECT COUNT(*) AS count FROM session_nodes"),
      sessions: scalarNumber(db, "SELECT COUNT(*) AS count FROM session_windows"),
      trajectoryRuntimeEvents: scalarNumber(
        db,
        "SELECT COUNT(*) AS count FROM trajectory_runtime_events",
      ),
      trackedEntries,
      transcriptEvents: scalarNumber(db, "SELECT COUNT(*) AS count FROM transcript_events"),
    };
  } finally {
    db.close();
  }
}

function readTrackedEntries(
  db: DatabaseSync,
  trackedSessionKeys: readonly string[],
): SqliteSessionEntryEvidence[] {
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
      const result: SqliteSessionEntryEvidence = {
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
      if (typeof row.entryJson === "string") {
        result.entry = parseEntryJson(row.entryJson);
      }
      return result;
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
  if (checkpoint.label !== "seeded-legacy-store" && checkpoint.activeJsonl.length > 0) {
    failures.push(
      `${checkpoint.label}: active sessions directory still has JSONL files: ${checkpoint.activeJsonl
        .map((entry) => entry.path)
        .join(", ")}`,
    );
  }
  if (checkpoint.label !== "seeded-legacy-store" && checkpoint.legacyStateJsonl.length > 0) {
    failures.push(
      `${checkpoint.label}: old sessions directory still has JSONL files: ${checkpoint.legacyStateJsonl
        .map((entry) => entry.path)
        .join(", ")}`,
    );
  }
  const doctor = checkpoint.doctor;
  if (checkpoint.label.startsWith("after-doctor") && doctor?.code !== 0) {
    failures.push(`${checkpoint.label}: doctor ${doctor?.mode ?? "unknown"} exited non-zero`);
  }
  if (
    checkpoint.label === "after-startup-import" &&
    (checkpoint.sqlite.sessionEntries === 0 || checkpoint.sqlite.transcriptEvents === 0)
  ) {
    failures.push(`${checkpoint.label}: startup did not import sessions into SQLite`);
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
  if (checkpoint.label === "after-startup-import") {
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
  if (checkpoint.label === "after-cleanup-pruning") {
    requireArchiveText(checkpoint, failures, {
      description: "cleanup-pruned transcript archive",
      includes: [CLEANUP_PRUNE_TEXT],
      reason: "deleted",
      sessionId: CLEANUP_PRUNE_SESSION_ID,
    });
    if (
      checkpoint.sqlite.trackedEntries.some(
        (entry) => entry.sessionKey === context.cleanupPruneSessionKey,
      )
    ) {
      failures.push(`${checkpoint.label}: cleanup-pruned entry still exists in SQLite`);
    }
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
    requireArchiveText(checkpoint, failures, {
      description: "final shared transcript archive",
      includes: ["shared"],
      reason: "deleted",
      sessionId: "sqlite-shared-session",
    });
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
  return checkpoint.archiveArtifacts.find((artifact) => {
    if (params.pathIncludes && !artifact.path.includes(params.pathIncludes)) {
      return false;
    }
    if (params.reason && artifact.archiveReason !== params.reason) {
      return false;
    }
    if (params.sessionId && artifact.archiveSessionId !== params.sessionId) {
      return false;
    }
    return true;
  });
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
