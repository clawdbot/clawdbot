import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CODEX_APP_SERVER_VERSION } from "../../../../extensions/codex/src/app-server/version.js";
import type { QaBusState, QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  COMPACTION_PROOF_MODEL_REF as MODEL_REF,
  COMPACTION_PROOF_TIMEOUT_MS as CHECKPOINT_TIMEOUT_MS,
  createCompactionProofCase,
  recordCompactionProofCheckpoint,
  stageCompactionProofHook,
  stageHeartbeatCompactionProofHook,
  startCompactionProofProvider,
  waitForCompactionProofCheckpoint,
  type CompactionProofCase as ProofCase,
} from "./gateway-compaction-provider.fixture.js";
import {
  adoptCompactionSessionIdentity,
  assertCommittedCompactionHistory,
  assertResetWithoutCompaction,
  assertUncommittedCompactionHistory,
  patchCompactionSessionOwnership,
  readCompactionEntry,
  replaceCompactionWriter,
  seedCompactionTranscript,
  snapshotCompactionSession,
  waitForCompactionRunSettlement,
  waitForCompactionReply,
} from "./gateway-compaction-state.fixture.js";

const SCENARIO_ID = "gateway-codex-heartbeat-compaction";
const CASES = [
  "heartbeat-fresh-restricted",
  "heartbeat-upgraded-native-failure",
  "heartbeat-upgraded-restart",
  "heartbeat-substituted",
  "heartbeat-revoked",
] as const;
type CaseMode = (typeof CASES)[number];

async function requireOwnedEnvironment() {
  const tmp = process.env.TMPDIR;
  assert.ok(tmp && path.isAbsolute(tmp), "Outer launcher must own TMPDIR before imports");
  const root = await fs.realpath(tmp);
  for (const name of [
    "HOME",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_OAUTH_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ]) {
    const value = process.env[name];
    assert.ok(value && path.isAbsolute(value), `Outer launcher must set ${name} before imports`);
    const relative = path.relative(root, value);
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
      `${name} must be inside the owned TMPDIR`,
    );
  }
  return root;
}

async function loadRuntime() {
  const [qa, sessions, store, transcript, guards, evidence, writer, hostStore] = await Promise.all([
    import("../../../../extensions/qa-lab/api.js"),
    import("openclaw/plugin-sdk/agent-sessions"),
    import("openclaw/plugin-sdk/session-store-runtime"),
    import("openclaw/plugin-sdk/session-transcript-runtime"),
    import("openclaw/plugin-sdk/string-coerce-runtime"),
    import("./script-evidence.js"),
    import("../../../../src/agents/embedded-agent-runner/run/session-bootstrap.js"),
    import("../../../../src/config/sessions/session-accessor.js"),
  ]);
  return {
    qa,
    sessions,
    store,
    transcript,
    isRecord: guards.isRecord,
    evidence,
    claimAgentSessionWriter: writer.claimAgentSessionWriter,
    loadSessionEntry: hostStore.loadSessionEntry,
    resolveSessionTranscriptDatabasePath: hostStore.resolveSessionTranscriptDatabasePath,
  };
}

type Runtime = Awaited<ReturnType<typeof loadRuntime>>;
type AppServerRequest = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};
const CODEX_THREAD_ID = "thread-qa-codex-heartbeat";

async function readJsonl(filePath: string): Promise<AppServerRequest[]> {
  const raw = await fs.readFile(filePath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AppServerRequest);
}

function snapshotProviderCounters(proof: ProofCase) {
  return {
    normalRequests: proof.normalRequests,
    summaryRequests: proof.summaryRequests,
    successorRequests: proof.successorRequests,
  };
}

function inboundTurnStarts(requests: AppServerRequest[]) {
  return requests.filter((request) => request.method === "turn/start");
}

function matchingAppServerReplies(requests: AppServerRequest[], id: unknown) {
  return requests.filter(
    (request) =>
      request.id === id &&
      request.method === undefined &&
      ("result" in request || "error" in request),
  );
}

async function waitForAppServerReply(filePath: string, id: unknown) {
  const deadline = Date.now() + CHECKPOINT_TIMEOUT_MS;
  for (;;) {
    const replies = matchingAppServerReplies(await readJsonl(filePath), id);
    if (replies.length > 0) {
      assert.equal(replies.length, 1, "Codex app-server emitted duplicate native replies");
      const [reply] = replies;
      assert.ok(reply, "Codex app-server omitted its native reply");
      return reply;
    }
    assert.ok(Date.now() < deadline, "Codex app-server native reply did not arrive");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

async function startChat(
  runtime: Runtime,
  gateway: QaGatewayChild,
  proof: ProofCase,
  message: string,
) {
  const result = await gateway.call("chat.send", {
    sessionKey: proof.sessionKey,
    message,
    idempotencyKey: randomUUID(),
    deliver: true,
    originatingChannel: "qa-channel",
    originatingTo: "dm:qa-operator",
  });
  assert.ok(
    runtime.isRecord(result) && typeof result.runId === "string",
    "chat.send omitted runId",
  );
  return result.runId;
}

async function waitForAgentTerminal(runtime: Runtime, gateway: QaGatewayChild, runId: string) {
  const result = await gateway.call(
    "agent.wait",
    { runId, timeoutMs: CHECKPOINT_TIMEOUT_MS },
    { timeoutMs: CHECKPOINT_TIMEOUT_MS + 5_000 },
  );
  assert.ok(runtime.isRecord(result), "agent.wait omitted its result");
  assert.equal(result.status, "ok", `Codex turn failed: ${JSON.stringify(result)}`);
  return result;
}

async function runChat(
  runtime: Runtime,
  state: QaBusState,
  gateway: QaGatewayChild,
  proof: ProofCase,
  marker: string,
) {
  const runId = await startChat(
    runtime,
    gateway,
    proof,
    `Reply with only this exact marker: ${marker}`,
  );
  const terminal = await waitForAgentTerminal(runtime, gateway, runId);
  await waitForCompactionReply(state, runId, marker);
  return { runId, terminal };
}

async function forceHeartbeat(runtime: Runtime, gateway: QaGatewayChild, proof: ProofCase) {
  const listed = await gateway.call("cron.list", { includeDisabled: true });
  assert.ok(runtime.isRecord(listed) && Array.isArray(listed.jobs), "cron.list omitted jobs");
  const monitor = listed.jobs.find(
    (job) => runtime.isRecord(job) && job.declarationKey === "heartbeat:qa",
  );
  assert.ok(
    runtime.isRecord(monitor) && typeof monitor.id === "string",
    "heartbeat monitor missing",
  );
  assert.equal(monitor.agentId, "qa", "Heartbeat monitor changed agent ownership");
  assert.equal(monitor.declarationKey, "heartbeat:qa", "Heartbeat declaration changed");
  assert.equal(monitor.sessionTarget, "main", "Heartbeat monitor changed its target mode");
  const configuredSession = gateway.cfg.agents?.defaults?.heartbeat?.session;
  assert.equal(
    `agent:qa:${configuredSession}`,
    proof.sessionKey,
    "Heartbeat config does not resolve to the canonical proof session",
  );
  const targetEntry = readCompactionEntry(runtime, gateway, proof);
  assert.equal(
    targetEntry.sessionId,
    proof.sessionId,
    "Heartbeat target changed canonical session identity",
  );
  const started = await gateway.call("cron.run", { id: monitor.id, mode: "force" });
  assert.ok(
    runtime.isRecord(started) &&
      started.ok === true &&
      started.enqueued === true &&
      typeof started.runId === "string",
    `cron.run did not enqueue: ${JSON.stringify(started)}`,
  );
  return {
    monitorId: monitor.id,
    runId: started.runId,
    target: {
      agentId: monitor.agentId,
      declarationKey: monitor.declarationKey,
      sessionTarget: monitor.sessionTarget,
      sessionKey: proof.sessionKey,
      sessionId: proof.sessionId,
    },
  };
}

async function waitForHeartbeatTerminal(
  runtime: Runtime,
  gateway: QaGatewayChild,
  monitorId: string,
  runId: string,
  timeoutMs = CHECKPOINT_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const history = await gateway.call("cron.runs", { id: monitorId, runId, limit: 1 });
    assert.ok(
      runtime.isRecord(history) && Array.isArray(history.entries),
      "cron.runs omitted entries",
    );
    const entry = history.entries.find(
      (candidate) => runtime.isRecord(candidate) && candidate.runId === runId,
    );
    if (
      runtime.isRecord(entry) &&
      (entry.status === "ok" || entry.status === "error" || entry.status === "skipped")
    ) {
      return entry;
    }
    assert.ok(Date.now() < deadline, "forced heartbeat did not reach terminal history");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

function requireBusySuspendPreflight(runtime: Runtime, value: unknown, label: string) {
  assert.ok(runtime.isRecord(value), `${label} omitted its result`);
  assert.equal(value.status, "busy", `${label} did not remain busy`);
  assert.equal(value.reason, "active-work", `${label} did not report active work`);
  assert.ok(Array.isArray(value.blockers), `${label} omitted blockers`);
  assert.equal("suspensionId" in value, false, `${label} unexpectedly created a suspension`);
  assert.equal("expiresAtMs" in value, false, `${label} unexpectedly returned an expiry`);
  return value.blockers;
}

async function raiseSuccessorCompactionThreshold(runtime: Runtime, gateway: QaGatewayChild) {
  const before = await gateway.call("config.get", {});
  assert.ok(
    runtime.isRecord(before) && typeof before.hash === "string",
    "config.get omitted its hash",
  );
  const patched = await gateway.call("config.patch", {
    raw: JSON.stringify({
      agents: {
        defaults: {
          compaction: { maxActiveTranscriptBytes: "1gb" },
        },
      },
    }),
    baseHash: before.hash,
    restartDelayMs: 0,
  });
  assert.ok(
    runtime.isRecord(patched) && typeof patched.hash === "string",
    `config.patch omitted its hash: ${JSON.stringify(patched)}`,
  );
  const deadline = Date.now() + CHECKPOINT_TIMEOUT_MS;
  for (;;) {
    const current = await gateway.call("config.get", {});
    if (
      runtime.isRecord(current) &&
      current.hash === patched.hash &&
      current.appliedConfigHash === current.configRevisionHash
    ) {
      return { hash: patched.hash };
    }
    assert.ok(Date.now() < deadline, "Successor compaction threshold was not applied");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

async function runCase(params: {
  runtime: Runtime;
  repoRoot: string;
  artifactBase: string;
  tmpRoot: string;
  mode: CaseMode;
}) {
  const { runtime, repoRoot, artifactBase, tmpRoot, mode } = params;
  const proof = createCompactionProofCase(mode);
  const setupMarker = `QA-CODEX-SETUP-${proof.sessionId}`;
  const successorMarker = `QA-CODEX-SUCCESSOR-${proof.sessionId}`;
  const caseDir = path.join(artifactBase, mode);
  const appServerLog = path.join(caseDir, "codex-app-server.jsonl");
  const fixturePath = fileURLToPath(
    new URL("./codex-heartbeat-compaction-app-server.fixture.mjs", import.meta.url),
  );
  await fs.mkdir(caseDir, { recursive: true });
  const state = runtime.qa.createQaBusState();
  const transport = runtime.qa.createQaChannelTransport(state);
  const bus = await runtime.qa.startQaBusServer({ state });
  const owner = runtime.qa.createQaGatewayChild();
  const provider = await startCompactionProofProvider(runtime.isRecord);
  provider.arm(proof);
  let gateway: QaGatewayChild | undefined;
  const evidence: Record<string, unknown> = {
    mode,
    sessionKey: proof.sessionKey,
    timeline: proof.timeline,
  };
  let caseFailure: unknown;
  let pendingReset: Promise<unknown> | undefined;
  try {
    const sessionName = proof.sessionKey.split(":").slice(2).join(":");
    gateway = await owner.start({
      repoRoot,
      command: {
        executablePath: process.execPath,
        argsPrefix: ["--import", fixturePath, path.join(repoRoot, "dist", "index.js")],
        tempParentDir: tmpRoot,
      },
      transport,
      transportBaseUrl: bus.baseUrl,
      providerBaseUrl: provider.baseUrl,
      providerMode: "mock-openai",
      primaryModel: MODEL_REF,
      alternateModel: MODEL_REF,
      forcedRuntime: "codex",
      controlUiEnabled: false,
      thinkingDefault: "off",
      runtimeEnvPatch: {
        OPENCLAW_QA_CODEX_APP_SERVER_VERSION: CODEX_APP_SERVER_VERSION,
        OPENCLAW_QA_CODEX_HEARTBEAT_LOG: appServerLog,
        OPENCLAW_QA_CODEX_HEARTBEAT_COMPACT_MODE: "reject",
        OPENCLAW_QA_CODEX_HEARTBEAT_PROVIDER_BASE_URL: provider.baseUrl,
        OPENCLAW_QA_CODEX_HEARTBEAT_PROOF_MODE: mode,
      },
      mutateConfig: (config) => {
        const workspaceDir = config.agents?.defaults?.workspace;
        assert.ok(workspaceDir && path.isAbsolute(workspaceDir), "QA workspace must be explicit");
        writeFileSync(
          path.join(workspaceDir, "HEARTBEAT.md"),
          "Process pending system events and report what was handled.\n",
        );
        const heartbeatHookName = stageHeartbeatCompactionProofHook(workspaceDir, provider.baseUrl);
        const afterHookName =
          mode === "heartbeat-upgraded-native-failure"
            ? stageCompactionProofHook(workspaceDir, provider.baseUrl)
            : undefined;
        const codexEntry = config.plugins?.entries?.codex;
        return {
          ...config,
          ...(mode === "heartbeat-fresh-restricted"
            ? { tools: { ...config.tools, allow: ["read"] } }
            : {}),
          hooks: {
            internal: {
              enabled: true,
              entries: {
                [heartbeatHookName]: { enabled: true },
                ...(afterHookName ? { [afterHookName]: { enabled: true } } : {}),
              },
            },
          },
          memory: { ...config.memory, search: { ...config.memory?.search, enabled: false } },
          plugins: {
            ...config.plugins,
            entries: {
              ...config.plugins?.entries,
              codex: {
                ...codexEntry,
                enabled: true,
                config: {
                  ...(runtime.isRecord(codexEntry?.config) ? codexEntry.config : {}),
                  appServer: {
                    mode: "yolo",
                    command: process.execPath,
                    args: [fixturePath, "--app-server"],
                    requestTimeoutMs: CHECKPOINT_TIMEOUT_MS,
                    turnCompletionIdleTimeoutMs: CHECKPOINT_TIMEOUT_MS,
                  },
                },
              },
            },
          },
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents?.defaults,
              heartbeat: { every: "24h", session: sessionName, target: "last" },
              compaction: {
                ...config.agents?.defaults?.compaction,
                mode: "default",
                maxActiveTranscriptBytes: "150kb",
                memoryFlush: { enabled: false },
              },
            },
          },
        };
      },
    });
    await transport.waitReady({ gateway, timeoutMs: CHECKPOINT_TIMEOUT_MS });
    await waitForCompactionProofCheckpoint(provider.hookReady, "heartbeat proof hook startup");

    const setup = await runChat(runtime, state, gateway, proof, setupMarker);
    evidence.setup = setup;
    const setupEntry = adoptCompactionSessionIdentity(runtime, gateway, proof);
    const settledSetup = await waitForCompactionRunSettlement(runtime, gateway, proof, setup.runId);
    assert.equal(settledSetup.status, "done", "Setup writer did not reach durable success");
    assert.equal(
      settledSetup.activeWriterRunId,
      setup.runId,
      "Setup writer claim did not settle on the canonical row",
    );
    evidence.setupSettled = settledSetup;
    assert.equal(setupEntry.agentHarnessId, "codex", "Setup turn did not record Codex ownership");
    evidence.setupEntry = setupEntry;

    await seedCompactionTranscript(runtime, gateway, proof, { preserveSessionEntry: true });
    if (mode === "heartbeat-upgraded-native-failure" || mode === "heartbeat-upgraded-restart") {
      evidence.upgradedEntry = await patchCompactionSessionOwnership(runtime, gateway, proof, {
        agentRuntimeOverride: "codex",
        agentHarnessId: "openclaw",
      });
    }
    const before = snapshotCompactionSession(runtime, gateway, proof);
    evidence.before = before;
    const heartbeat = await forceHeartbeat(runtime, gateway, proof);
    evidence.heartbeat = heartbeat;
    await waitForCompactionProofCheckpoint(
      proof.beforeHookHeld.promise,
      "session:compact:before heartbeat barrier",
    );
    const held = snapshotCompactionSession(runtime, gateway, proof);
    evidence.held = held;
    assertUncommittedCompactionHistory(before, held);
    const shouldCommit =
      mode === "heartbeat-fresh-restricted" ||
      mode === "heartbeat-upgraded-native-failure" ||
      mode === "heartbeat-upgraded-restart";
    let resetSettled = false;
    let committingProviderCountersAtHold: ReturnType<typeof snapshotProviderCounters> | undefined;
    let staleProviderCountersAtHold: ReturnType<typeof snapshotProviderCounters> | undefined;
    let staleNativeRequestsAtHold: number | undefined;
    let staleTurnStartsAtHold: AppServerRequest[] | undefined;
    let resetLifecycleRevision: string | undefined;
    let nativeCompactRequestId: unknown;
    let preNativeDurableSnapshot: ReturnType<typeof snapshotCompactionSession> | undefined;
    let restartDurableSnapshot: ReturnType<typeof snapshotCompactionSession> | undefined;
    let restartProviderCountersAtCommit: ReturnType<typeof snapshotProviderCounters> | undefined;
    let terminalHeartbeat = heartbeat;

    if (shouldCommit) {
      committingProviderCountersAtHold = snapshotProviderCounters(proof);
      evidence.authorityHoldProviderCounters = committingProviderCountersAtHold;
    } else {
      const requestsAtAuthorityHold = await readJsonl(appServerLog);
      staleProviderCountersAtHold = snapshotProviderCounters(proof);
      staleNativeRequestsAtHold = requestsAtAuthorityHold.filter(
        (request) => request.method === "thread/compact/start",
      ).length;
      staleTurnStartsAtHold = inboundTurnStarts(requestsAtAuthorityHold);
      evidence.authorityHoldTraffic = {
        provider: staleProviderCountersAtHold,
        nativeCompact: staleNativeRequestsAtHold,
        turnStarts: staleTurnStartsAtHold,
      };
    }

    if (mode === "heartbeat-substituted") {
      const activeWriterRunId = readCompactionEntry(runtime, gateway, proof).activeWriterRunId;
      assert.ok(activeWriterRunId, "Held heartbeat omitted its active writer");
      evidence.replacement = await replaceCompactionWriter(
        runtime,
        gateway,
        proof,
        activeWriterRunId,
      );
    } else if (mode === "heartbeat-revoked") {
      const beforeResetPreflight = await gateway.call("gateway.suspend.prepare", {
        requestId: `qa-before-reset-${randomUUID()}`,
        drain: false,
        terminalPolicy: "preserve",
      });
      const beforeResetBlockers = requireBusySuspendPreflight(
        runtime,
        beforeResetPreflight,
        "Pre-reset suspend preflight",
      );
      assert.equal(
        beforeResetBlockers.some(
          (blocker) => runtime.isRecord(blocker) && blocker.kind === "session-mutation",
        ),
        false,
        "Session mutation was active before reset started",
      );
      evidence.beforeResetPreflight = beforeResetPreflight;

      recordCompactionProofCheckpoint(proof, "session-reset-requested");
      pendingReset = gateway.call("sessions.reset", {
        key: proof.sessionKey,
        agentId: "qa",
      });
      void pendingReset.then(
        () => {
          resetSettled = true;
        },
        () => {
          resetSettled = true;
        },
      );
      const resetPreflights: unknown[] = [];
      let mutationPreflight: unknown;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        assert.equal(resetSettled, false, "sessions.reset settled before mutation preflight");
        const preflight = await gateway.call("gateway.suspend.prepare", {
          requestId: `qa-reset-pending-${attempt}-${randomUUID()}`,
          drain: false,
          terminalPolicy: "preserve",
        });
        const blockers = requireBusySuspendPreflight(
          runtime,
          preflight,
          `Pending-reset suspend preflight ${attempt + 1}`,
        );
        resetPreflights.push(preflight);
        const mutationBlockers = blockers.filter(
          (blocker) => runtime.isRecord(blocker) && blocker.kind === "session-mutation",
        );
        if (
          mutationBlockers.length === 1 &&
          runtime.isRecord(mutationBlockers[0]) &&
          mutationBlockers[0].count === 1
        ) {
          mutationPreflight = preflight;
          break;
        }
      }
      assert.ok(mutationPreflight, "Reset never exposed exactly one session-mutation blocker");
      assert.equal(resetSettled, false, "sessions.reset settled before hook release");
      evidence.resetPreflights = resetPreflights;
      const runningStatus = await gateway.call("gateway.suspend.status", {
        suspensionId: `qa-nonexistent-${randomUUID()}`,
      });
      assert.deepEqual(
        runningStatus,
        { status: "running" },
        "Nonexistent suspension did not preserve running status",
      );
      evidence.suspendStatus = runningStatus;
    }

    recordCompactionProofCheckpoint(proof, "release-before-hook");
    proof.releaseBeforeHook.resolve();
    await waitForCompactionProofCheckpoint(
      proof.beforeHookSettled.promise,
      "released session:compact:before hook",
    );
    if (shouldCommit) {
      const progression = await Promise.race([
        proof.summaryHeld.promise.then(() => ({ kind: "summary" as const })),
        waitForHeartbeatTerminal(runtime, gateway, heartbeat.monitorId, heartbeat.runId).then(
          (entry) => ({ kind: "terminal" as const, entry }),
        ),
      ]);
      assert.equal(
        progression.kind,
        "summary",
        `Heartbeat terminated before host summary: ${JSON.stringify(progression)}`,
      );
      evidence.summaryHeld = snapshotCompactionSession(runtime, gateway, proof);
      proof.releaseSummary.resolve();
      await waitForCompactionProofCheckpoint(
        proof.summarySettled.promise,
        "heartbeat host summary settlement",
      );
      if (mode === "heartbeat-upgraded-native-failure") {
        await waitForCompactionProofCheckpoint(
          proof.afterHookHeld.promise,
          "held session:compact:after hook",
        );
        assert.equal(proof.afterHookCalls, 1, "Host compaction after hook count changed");
        assert.equal(proof.afterHookPending, true, "Host compaction after hook was not pending");
        const preNativeRequests = await readJsonl(appServerLog);
        assert.equal(
          preNativeRequests.filter((request) => request.method === "thread/compact/start").length,
          0,
          "Native compaction started before the host after hook settled",
        );

        preNativeDurableSnapshot = snapshotCompactionSession(runtime, gateway, proof);
        evidence.preNativeDurable = preNativeDurableSnapshot;
        const priorCompactionIds = new Set(held.compactionIds);
        const newCompactionIds = preNativeDurableSnapshot.compactionIds.filter(
          (id) => !priorCompactionIds.has(id),
        );
        assert.equal(newCompactionIds.length, 1, "Host compaction event was not durable once");
        const [compactionId] = newCompactionIds;
        assert.ok(compactionId, "Host compaction event omitted its id");
        assert.ok(
          preNativeDurableSnapshot.activeEntryIds.includes(compactionId),
          "Durable host compaction was not on the active branch",
        );
        const priorCheckpoints = Array.isArray(held.compactionCheckpoints)
          ? held.compactionCheckpoints
          : [];
        const durableCheckpoints = Array.isArray(preNativeDurableSnapshot.compactionCheckpoints)
          ? preNativeDurableSnapshot.compactionCheckpoints
          : [];
        assert.equal(
          durableCheckpoints.length,
          priorCheckpoints.length + 1,
          "Host compaction checkpoint was not persisted once",
        );
        const checkpoint = durableCheckpoints.at(-1);
        assert.ok(runtime.isRecord(checkpoint), "Host compaction checkpoint was malformed");
        assert.equal(checkpoint.sessionKey, proof.sessionKey, "Checkpoint changed session key");
        assert.equal(checkpoint.sessionId, proof.sessionId, "Checkpoint changed session identity");
        assert.ok(
          runtime.isRecord(checkpoint.postCompaction),
          "Checkpoint omitted post-compaction identity",
        );
        assert.equal(
          checkpoint.postCompaction.entryId,
          compactionId,
          "Checkpoint did not reference the durable compaction",
        );
        assert.equal(
          checkpoint.postCompaction.sessionId,
          proof.sessionId,
          "Checkpoint post-compaction session identity changed",
        );

        recordCompactionProofCheckpoint(proof, "release-after-hook");
        proof.releaseAfterHook.resolve();
        await waitForCompactionProofCheckpoint(
          proof.afterHookSettled.promise,
          "released session:compact:after hook",
        );
        await waitForCompactionProofCheckpoint(
          proof.nativeCompactRequestHeld.promise,
          "held Codex native compaction request",
        );
        const nativeHeldRequests = await readJsonl(appServerLog);
        const compactRequests = nativeHeldRequests.filter(
          (request) => request.method === "thread/compact/start",
        );
        assert.equal(compactRequests.length, 1, "Codex native compaction request count changed");
        const [compactRequest] = compactRequests;
        assert.ok(compactRequest, "Codex native compaction request was missing");
        assert.deepEqual(
          compactRequest.params,
          { threadId: CODEX_THREAD_ID },
          "Codex native compaction targeted the wrong thread",
        );
        assert.ok(
          typeof compactRequest.id === "number" || typeof compactRequest.id === "string",
          "Codex native compaction request omitted its id",
        );
        nativeCompactRequestId = compactRequest.id;
        assert.equal(
          matchingAppServerReplies(nativeHeldRequests, nativeCompactRequestId).length,
          0,
          "Codex native compaction replied before release",
        );

        proof.releaseNativeCompactRequest.resolve();
        const rejection = await waitForAppServerReply(appServerLog, nativeCompactRequestId);
        assert.deepEqual(
          rejection.error,
          {
            code: -32603,
            message: "QA Codex native compaction rejection",
            data: { reason: "deterministic_native_failure" },
          },
          "Codex native compaction rejection changed",
        );
        assert.equal(
          "result" in rejection,
          false,
          "Codex native compaction unexpectedly succeeded",
        );
        evidence.nativeCompactRejection = rejection;
      } else if (mode === "heartbeat-upgraded-restart") {
        await waitForCompactionProofCheckpoint(
          proof.hostCommitHeld.promise,
          "held atomic host compaction commit before restart",
        );
        restartDurableSnapshot = snapshotCompactionSession(runtime, gateway, proof);
        restartProviderCountersAtCommit = snapshotProviderCounters(proof);
        evidence.restartAtomicCommit = restartDurableSnapshot;
        const priorCompactionIds = new Set(held.compactionIds);
        const newCompactionIds = restartDurableSnapshot.compactionIds.filter(
          (id) => !priorCompactionIds.has(id),
        );
        assert.equal(newCompactionIds.length, 1, "Restart host compaction was not durable once");
        const [compactionId] = newCompactionIds;
        assert.ok(compactionId, "Restart host compaction omitted its id");
        assert.ok(
          restartDurableSnapshot.activeEntryIds.includes(compactionId),
          "Restart host compaction was not active",
        );
        const priorCheckpoints = Array.isArray(held.compactionCheckpoints)
          ? held.compactionCheckpoints
          : [];
        const durableCheckpoints = Array.isArray(restartDurableSnapshot.compactionCheckpoints)
          ? restartDurableSnapshot.compactionCheckpoints
          : [];
        assert.deepEqual(
          durableCheckpoints,
          priorCheckpoints,
          "Restart barrier was reached after checkpoint persistence",
        );
        assert.equal(
          restartDurableSnapshot.compactionCount,
          1,
          "Restart host count was not durable",
        );
        assert.ok(
          restartDurableSnapshot.transcriptByteCompactionLatch,
          "Restart host byte latch was not durable",
        );
        assert.equal(
          restartDurableSnapshot.transcriptByteCompactionLatch.sessionId,
          proof.sessionId,
          "Restart host byte latch changed session identity",
        );
        const preRestartRequests = await readJsonl(appServerLog);
        assert.equal(
          preRestartRequests.filter((request) => request.method === "thread/compact/start").length,
          0,
          "Restart barrier was reached after native compaction started",
        );

        const gatewayPid = gateway.pid;
        assert.ok(gatewayPid && gatewayPid > 0, "Restart case Gateway omitted its owned pid");
        assert.notEqual(process.platform, "win32", "Restart case requires POSIX process groups");
        recordCompactionProofCheckpoint(proof, "gateway-process-group-sigkill", {
          pid: gatewayPid,
        });
        process.kill(-gatewayPid, "SIGKILL");
        const restarting = gateway.restartAfterStateMutation(async () => {});
        await restarting;
        await transport.waitReady({ gateway, timeoutMs: CHECKPOINT_TIMEOUT_MS });
        evidence.restartedGatewayPid = gateway.pid;
        assert.notEqual(gateway.pid, gatewayPid, "Gateway restart reused the killed process");

        terminalHeartbeat = await forceHeartbeat(runtime, gateway, proof);
        assert.equal(
          terminalHeartbeat.monitorId,
          heartbeat.monitorId,
          "Restart changed the heartbeat monitor",
        );
        assert.deepEqual(
          terminalHeartbeat.target,
          heartbeat.target,
          "Restart changed the heartbeat target",
        );
        evidence.restartHeartbeat = terminalHeartbeat;
      }
    }
    let resetResult: unknown;
    let terminal: Record<string, unknown>;
    if (mode === "heartbeat-revoked") {
      assert.ok(pendingReset, "Revoked case did not start sessions.reset");
      [resetResult, terminal] = await Promise.all([
        pendingReset,
        waitForHeartbeatTerminal(runtime, gateway, heartbeat.monitorId, heartbeat.runId),
      ]);
      assert.ok(runtime.isRecord(resetResult), "sessions.reset omitted its result");
      assert.equal(resetResult.ok, true, "sessions.reset failed");
      assert.equal(resetResult.key, proof.sessionKey, "sessions.reset changed the session key");
      assert.ok(runtime.isRecord(resetResult.entry), "sessions.reset omitted its session entry");
      assert.equal(
        resetResult.entry.sessionId,
        proof.sessionId,
        "sessions.reset changed canonical session identity",
      );
      assert.ok(
        typeof resetResult.entry.lifecycleRevision === "string" &&
          resetResult.entry.lifecycleRevision.length > 0,
        "sessions.reset omitted the fresh lifecycle revision",
      );
      assert.notEqual(
        resetResult.entry.lifecycleRevision,
        before.lifecycleRevision,
        "sessions.reset reused the prior lifecycle revision",
      );
      resetLifecycleRevision = resetResult.entry.lifecycleRevision;
      evidence.reset = resetResult;
      recordCompactionProofCheckpoint(proof, "session-reset-acknowledged");
    } else {
      terminal = await waitForHeartbeatTerminal(
        runtime,
        gateway,
        terminalHeartbeat.monitorId,
        terminalHeartbeat.runId,
        mode === "heartbeat-upgraded-restart" ? 2 * CHECKPOINT_TIMEOUT_MS : undefined,
      );
    }
    evidence.terminal = terminal;
    const afterTerminal = snapshotCompactionSession(runtime, gateway, proof);
    evidence.afterTerminal = afterTerminal;

    const requestsAtTerminal = await readJsonl(appServerLog);
    const nativeCompactRequests = requestsAtTerminal.filter(
      (request) => request.method === "thread/compact/start",
    );
    if (!shouldCommit) {
      assert.deepEqual(
        inboundTurnStarts(requestsAtTerminal),
        staleTurnStartsAtHold,
        "Stale heartbeat changed Codex turn/start traffic",
      );
    }
    if (shouldCommit) {
      assert.equal(terminal.status, "ok", `heartbeat failed: ${JSON.stringify(terminal)}`);
      assert.ok(
        committingProviderCountersAtHold,
        "Committing heartbeat omitted its provider counter baseline",
      );
      assert.deepEqual(
        snapshotProviderCounters(proof),
        {
          normalRequests: committingProviderCountersAtHold.normalRequests,
          summaryRequests: committingProviderCountersAtHold.summaryRequests + 2,
          successorRequests: committingProviderCountersAtHold.successorRequests,
        },
        "Committing heartbeat changed unexpected provider traffic",
      );
      assert.equal(afterTerminal.compactionIds.length, 1, "Host compaction was not committed");
      assert.equal(afterTerminal.compactionCount, 1, "Host compaction was not counted once");
      const terminalCheckpoints = Array.isArray(afterTerminal.compactionCheckpoints)
        ? afterTerminal.compactionCheckpoints
        : [];
      assert.equal(
        terminalCheckpoints.length,
        mode === "heartbeat-upgraded-restart" ? 0 : 1,
        "Host compaction checkpoint count changed",
      );
      if (terminalCheckpoints.length === 1) {
        const [checkpoint] = terminalCheckpoints;
        assert.ok(
          runtime.isRecord(checkpoint) && typeof checkpoint.summary === "string",
          "Host compaction checkpoint omitted its summary",
        );
        assert.equal(
          checkpoint.summary.match(/^\*\*Turn Context \(split turn\):\*\*$/gm)?.length ?? 0,
          1,
          "Host compaction checkpoint did not contain exactly one split-turn heading",
        );
      }
      assert.ok(
        afterTerminal.transcriptByteCompactionLatch,
        "Oversized host transcript did not persist its retry latch",
      );
      assert.equal(
        nativeCompactRequests.length,
        mode === "heartbeat-upgraded-native-failure" ? 1 : 0,
        "Native synchronization request count did not match ownership policy",
      );
      if (mode === "heartbeat-upgraded-native-failure") {
        assert.ok(preNativeDurableSnapshot, "Upgraded case omitted its pre-native snapshot");
        assert.deepEqual(
          afterTerminal.compactionIds,
          preNativeDurableSnapshot.compactionIds,
          "Native rejection duplicated the durable compaction event",
        );
        assert.deepEqual(
          afterTerminal.compactionCheckpoints,
          preNativeDurableSnapshot.compactionCheckpoints,
          "Native rejection duplicated the durable compaction checkpoint",
        );
        assert.equal(
          matchingAppServerReplies(requestsAtTerminal, nativeCompactRequestId).length,
          1,
          "Codex native compaction rejection count changed",
        );
      } else if (mode === "heartbeat-upgraded-restart") {
        assert.ok(restartDurableSnapshot, "Restart case omitted its atomic-commit snapshot");
        assert.equal(
          terminal.runId,
          terminalHeartbeat.runId,
          "Restart cron terminal changed heartbeat run identity",
        );
        assert.deepEqual(
          afterTerminal.compactionIds,
          restartDurableSnapshot.compactionIds,
          "Restart duplicated the durable compaction event",
        );
        assert.deepEqual(
          afterTerminal.compactionCheckpoints,
          restartDurableSnapshot.compactionCheckpoints,
          "Restart duplicated the durable compaction checkpoint",
        );
        assert.equal(
          afterTerminal.compactionCount,
          restartDurableSnapshot.compactionCount,
          "Restart duplicated compaction accounting",
        );
        const terminalLatch = afterTerminal.transcriptByteCompactionLatch;
        const committedLatch = restartDurableSnapshot.transcriptByteCompactionLatch;
        assert.ok(terminalLatch && committedLatch, "Restart omitted the durable byte latch");
        assert.equal(
          terminalLatch.sessionId,
          committedLatch.sessionId,
          "Restart changed the byte-latch session identity",
        );
        assert.equal(
          terminalLatch.maxBytes,
          committedLatch.maxBytes,
          "Restart changed the byte-latch threshold",
        );
        assert.ok(
          terminalLatch.activeBytes < committedLatch.activeBytes,
          "Restart did not refresh the shrunken byte-latch baseline",
        );
        assert.ok(
          terminalLatch.activeBytes > terminalLatch.maxBytes,
          "Restart retained the byte latch below its threshold",
        );
      }
    } else if (mode === "heartbeat-substituted") {
      assert.equal(terminal.runId, heartbeat.runId, "Cron terminal changed heartbeat run identity");
      assert.equal(terminal.status, "error", "Substituted heartbeat did not fail");
      assert.equal(
        terminal.completionStatus,
        "failed",
        "Substituted heartbeat completion status changed",
      );
      assert.equal(
        terminal.error,
        "heartbeat failed: agent-runner-failure",
        "Substituted heartbeat reason changed",
      );
      assert.deepEqual(
        snapshotProviderCounters(proof),
        staleProviderCountersAtHold,
        "Substituted heartbeat changed provider traffic",
      );
      assert.equal(
        nativeCompactRequests.length,
        staleNativeRequestsAtHold,
        "Substituted heartbeat changed native traffic",
      );
      assertUncommittedCompactionHistory(before, afterTerminal);
    } else {
      assert.equal(terminal.runId, heartbeat.runId, "Cron terminal changed heartbeat run identity");
      assert.equal(terminal.status, "skipped", "Revoked heartbeat did not skip");
      assert.equal(
        terminal.error,
        "heartbeat skipped: agent-runner-cancelled",
        "Revoked heartbeat reason changed",
      );
      assert.equal(
        nativeCompactRequests.length,
        staleNativeRequestsAtHold,
        "Revoked heartbeat changed native traffic",
      );
      assert.deepEqual(
        snapshotProviderCounters(proof),
        staleProviderCountersAtHold,
        "Revoked heartbeat changed provider traffic",
      );
      assert.equal(
        afterTerminal.sessionId,
        proof.sessionId,
        "Reset terminal snapshot changed canonical session identity",
      );
      assert.equal(
        afterTerminal.lifecycleRevision,
        resetLifecycleRevision,
        "Reset terminal snapshot did not use the reset lifecycle",
      );
      assertResetWithoutCompaction(held, afterTerminal);
    }

    if (mode === "heartbeat-substituted") {
      evidence.successorConfig = await raiseSuccessorCompactionThreshold(runtime, gateway);
    }

    evidence.successor = await runChat(runtime, state, gateway, proof, successorMarker);
    const after = snapshotCompactionSession(runtime, gateway, proof);
    evidence.after = after;
    const finalRequests = await readJsonl(appServerLog);
    const finalTurnStarts = inboundTurnStarts(finalRequests);
    const successorTurns = finalTurnStarts.filter((request) =>
      JSON.stringify(request.params).includes(successorMarker),
    );
    assert.equal(successorTurns.length, 1, "Successor Codex turn did not start exactly once");
    if (!shouldCommit) {
      assert.ok(staleTurnStartsAtHold, "Stale case omitted its turn/start baseline");
      assert.deepEqual(
        finalTurnStarts.slice(0, staleTurnStartsAtHold.length),
        staleTurnStartsAtHold,
        "Successor changed the authority-hold turn/start prefix",
      );
      assert.equal(
        finalTurnStarts.length,
        staleTurnStartsAtHold.length + 1,
        "Stale case did not add exactly one successor turn/start",
      );
      const successorTurn = finalTurnStarts.at(-1);
      assert.ok(runtime.isRecord(successorTurn?.params), "Successor turn/start omitted its params");
      assert.equal(
        successorTurn.params.threadId,
        CODEX_THREAD_ID,
        "Successor turn/start targeted the wrong Codex thread",
      );
      assert.ok(
        JSON.stringify(successorTurn.params).includes(successorMarker),
        "Successor turn/start omitted its marker",
      );
    }
    if (shouldCommit) {
      assertCommittedCompactionHistory(afterTerminal, after);
      if (mode === "heartbeat-upgraded-restart") {
        assert.ok(
          restartProviderCountersAtCommit,
          "Restart case omitted its atomic-commit provider counters",
        );
        assert.deepEqual(
          after.transcriptByteCompactionLatch,
          afterTerminal.transcriptByteCompactionLatch,
          "Restart successor changed the byte latch",
        );
        assert.equal(
          proof.summaryRequests,
          restartProviderCountersAtCommit.summaryRequests,
          "Restart successor repeated host compaction",
        );
        assert.equal(
          finalRequests.filter((request) => request.method === "thread/compact/start").length,
          0,
          "Restart successor repeated native compaction",
        );
      }
    } else if (mode === "heartbeat-substituted") {
      assertUncommittedCompactionHistory(before, after);
    } else {
      assert.equal(
        proof.summaryRequests,
        staleProviderCountersAtHold?.summaryRequests,
        "Reset successor triggered host compaction",
      );
      assert.equal(
        finalRequests.filter((request) => request.method === "thread/compact/start").length,
        staleNativeRequestsAtHold,
        "Reset successor triggered native compaction",
      );
      assert.equal(
        after.sessionId,
        proof.sessionId,
        "Successor changed canonical session identity",
      );
      assert.equal(
        after.lifecycleRevision,
        resetLifecycleRevision,
        "Successor did not run on the reset lifecycle",
      );
      assertResetWithoutCompaction(held, after, { allowSuccessorEvents: true });
    }
    evidence.requestCounts = {
      providerSummary: proof.summaryRequests,
      nativeCompact: finalRequests.filter((request) => request.method === "thread/compact/start")
        .length,
      codexTurnStart: finalRequests.filter((request) => request.method === "turn/start").length,
    };
    evidence.codexRequests = finalRequests;
    evidence.channelTranscript = state.getSnapshot().messages;
    evidence.status = "pass";
  } catch (error) {
    caseFailure = error;
    evidence.status = "fail";
    evidence.error = error instanceof Error ? error.message : String(error);
    const failedRequests = await readJsonl(appServerLog);
    evidence.requestCounts = {
      providerSummary: proof.summaryRequests,
      nativeCompact: failedRequests.filter((request) => request.method === "thread/compact/start")
        .length,
      codexTurnStart: failedRequests.filter((request) => request.method === "turn/start").length,
    };
    evidence.codexRequests = failedRequests;
    evidence.channelTranscript = state.getSnapshot().messages;
    if (gateway) {
      evidence.failureSnapshot = snapshotCompactionSession(runtime, gateway, proof);
    }
  } finally {
    proof.releaseBeforeHook.resolve();
    proof.releaseSummary.resolve();
    proof.releaseHostCommit.resolve();
    proof.releaseNativeCompactRequest.resolve();
    proof.releaseAfterHook.resolve();
    proof.releaseSuccessor.resolve();
    const cleanupErrors: unknown[] = [];
    if (pendingReset) {
      await pendingReset.catch((error: unknown) => {
        cleanupErrors.push(error);
      });
    }
    try {
      const stopped = await owner.stop({ keepTemp: true });
      assert.notEqual(stopped.process, "unconfirmed", "Gateway shutdown was not confirmed");
      cleanupErrors.push(...stopped.errors);
      if (gateway) {
        const logDir = path.join(caseDir, "gateway-logs");
        await fs.mkdir(logDir, { recursive: true });
        await fs.writeFile(path.join(logDir, "gateway.log"), gateway.logs());
        const stagedRoot = gateway.runtimeEnv.OPENCLAW_QA_STAGED_RUNTIME_ROOT;
        if (stagedRoot) {
          await fs.rm(stagedRoot, { recursive: true, force: true });
        }
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await provider.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      assert.deepEqual(provider.errors, [], "Controlled provider received unexpected traffic");
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await bus.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    evidence.cleanupErrors = cleanupErrors.map((error) =>
      error instanceof Error ? error.message : String(error),
    );
    await fs.writeFile(
      path.join(caseDir, "evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    if (cleanupErrors.length) {
      caseFailure ??= new AggregateError(cleanupErrors, `${mode} cleanup failed`);
    }
  }
  if (caseFailure) {
    throw caseFailure instanceof Error ? caseFailure : new Error(JSON.stringify(caseFailure));
  }
}

export async function runGatewayCodexHeartbeatCompaction(argv: readonly string[]) {
  const tmpRoot = await requireOwnedEnvironment();
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "artifact-base": { type: "string" },
      "repo-root": { type: "string" },
      "isolated-child": { type: "boolean" },
      case: { type: "string" },
    },
  });
  const repoRoot = path.resolve(
    values["repo-root"] ?? fileURLToPath(new URL("../../../..", import.meta.url)),
  );
  const relativeArtifacts =
    values["artifact-base"] ?? `.artifacts/qa-e2e/${SCENARIO_ID}-${randomUUID()}`;
  const artifactBase = path.resolve(repoRoot, relativeArtifacts);
  const artifactRelative = path.relative(repoRoot, artifactBase);
  assert.ok(
    artifactRelative && !artifactRelative.startsWith("..") && !path.isAbsolute(artifactRelative),
    "Artifacts must be inside the repository",
  );
  const selectedCases = values.case ? CASES.filter((mode) => mode === values.case) : [...CASES];
  assert.ok(selectedCases.length > 0, `Unknown case: ${values.case}`);
  await fs.access(path.join(repoRoot, "dist", "index.js"));
  await fs.access(path.join(repoRoot, "dist", "plugin-sdk", "qa-lab.js"));
  await fs.mkdir(artifactBase, { recursive: true });
  const runtime = await loadRuntime();
  const writer = runtime.evidence.createQaScriptEvidenceWriter({
    artifactBase,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: MODEL_REF,
    providerMode: "mock-openai",
    repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Codex heartbeat compaction preserves exact runtime authority",
      sourcePath: `qa/scenarios/runtime/${SCENARIO_ID}.yaml`,
    },
  });
  const startedAt = Date.now();
  const failures: string[] = [];
  for (const mode of selectedCases) {
    try {
      await runCase({ runtime, repoRoot, artifactBase, tmpRoot, mode });
    } catch (error) {
      failures.push(`${mode}: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }
  const status = failures.length ? "fail" : "pass";
  const details = failures.join("; ") || undefined;
  const artifacts = selectedCases.map((mode) => ({
    filePath: path.join(mode, "evidence.json"),
    kind: "json",
  }));
  writer.appendLog(`${status}: ${details ?? "all Codex heartbeat compaction cases passed"}\n`);
  await writer.write({ status, durationMs: Date.now() - startedAt, details, artifacts });
  console.log(
    `${SCENARIO_ID}: ${status}; evidence=${path.join(artifactRelative, "qa-evidence.json")}`,
  );
  return failures.length ? 1 : 0;
}

async function launch(argv: string[]) {
  if (argv.includes("--isolated-child")) {
    return await runGatewayCodexHeartbeatCompaction(argv);
  }
  const { runManagedCommand } = await import("../../../../scripts/lib/managed-child-process.mts");
  const root = await fs.realpath(
    // openclaw-temp-dir: allow outer producer owns child imports and process-tree cleanup.
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-heartbeat-proof-")),
  );
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const config = path.join(root, "openclaw.json");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    CI: "1",
    HOME: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_OAUTH_DIR: path.join(state, "credentials"),
    OPENCLAW_BUILD_PRIVATE_QA: "1",
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
  };
  for (const directory of [
    home,
    state,
    env.OPENCLAW_OAUTH_DIR,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.XDG_CACHE_HOME,
  ]) {
    assert.ok(directory);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await fs.writeFile(config, "{}\n", { mode: 0o600 });
  let joined = false;
  try {
    const code = await runManagedCommand({
      bin: process.execPath,
      args: ["--import", "tsx", fileURLToPath(import.meta.url), ...argv, "--isolated-child"],
      env,
      requireProcessTreeExit: true,
      timeoutMs: 10 * 60_000,
    });
    joined = true;
    return code;
  } finally {
    if (joined) {
      await fs.rm(root, { recursive: true, force: true });
    } else {
      console.error(`Codex heartbeat proof retained its namespace after unconfirmed exit: ${root}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  launch(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
