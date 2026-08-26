import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import {
  createQaBusState,
  createQaChannelTransport,
  QA_EVIDENCE_FILENAME,
  startQaBusServer,
  startQaGatewayChild,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND } from "../../../../src/infra/node-commands.js";
import {
  BASELINE_PROMPT,
  BASELINE_REPLY,
  COMMITTED_MARKERS,
  CONTEXT_PROMPT,
  CONTEXT_REPLY,
  MIDTURN_PROMPT,
  MODEL_REF,
  PROOF_TIMEOUT_MS,
  startMidturnProvider,
  VOLATILE_TEXT,
  waitFor,
} from "./cloud-worker-midturn-loss-fixture.js";
import {
  closeWireServer,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  type PairedNodeWorkerHost,
  type PublishedWireWorkspace,
} from "./paired-node-worker-wire-fixture.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SCENARIO_ID = "cloud-worker-midturn-loss";
const VERDICT_FILE = `${SCENARIO_ID}-verdict.json`;
const SESSION_KEY = "agent:qa:qa-channel:direct:cloud-midturn-loss";
const SENDER_ID = "cloud-midturn-loss";

type ProducerOptions = { artifactBase: string; repoRoot: string };
type Gateway = Awaited<ReturnType<typeof startQaGatewayChild>>;
type GatewayEvent = { event: string; payload?: unknown };
type GatewayRunResult = { runId?: string; status?: string; summary?: string };
type ChatHistory = { messages?: unknown[] };
type SessionsList = { sessions?: unknown[] };
type WorkerDiskSpaceProjection = {
  availableBytes: number;
  observedAtMs: number;
  status: string;
  totalBytes: number;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function parseOptions(argv: readonly string[]): ProducerOptions {
  const index = argv.indexOf("--artifact-base");
  const artifactBase = index >= 0 ? argv[index + 1] : undefined;
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return { artifactBase: path.resolve(artifactBase), repoRoot: process.cwd() };
}

async function connectOperator(
  gateway: Gateway,
  events: GatewayEvent[],
  deviceIdentity: NonNullable<ConstructorParameters<typeof GatewayClient>[0]["deviceIdentity"]>,
): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        client.stop();
        reject(error);
      } else {
        resolve(client);
      }
    };
    const timeout = setTimeout(() => finish(new Error("operator connection timed out")), 30_000);
    timeout.unref();
    const client = new GatewayClient({
      url: gateway.wsUrl,
      origin: "http://127.0.0.1",
      token: gateway.token,
      env: gateway.runtimeEnv,
      role: "operator",
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      clientDisplayName: "Cloud mid-turn loss QA operator",
      clientVersion: "1.0.0",
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      scopes: ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
      deviceIdentity,
      requestTimeoutMs: PROOF_TIMEOUT_MS,
      onEvent: (event) => events.push(event),
      onHelloOk: () => finish(),
      onConnectError: (error) => finish(error),
      onClose: (code, reason) => finish(new Error(`Gateway closed (${code}): ${reason}`)),
    });
    client.start();
  });
}

function messageRole(message: unknown): string {
  return String(requireRecord(message, "history message").role ?? "");
}

function messageText(message: unknown): string {
  const content = requireRecord(message, "history message").content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      const record = part && typeof part === "object" ? (part as Record<string, unknown>) : {};
      return typeof record.text === "string" ? [record.text] : [];
    })
    .join("");
}

async function readHistory(client: GatewayClient): Promise<unknown[]> {
  const history = await client.request<ChatHistory>("chat.history", {
    sessionKey: SESSION_KEY,
    limit: 100,
  });
  return history.messages ?? [];
}

function markerCounts(messages: readonly unknown[]) {
  const text = messages.map(messageText).join("\n");
  return Object.fromEntries(
    COMMITTED_MARKERS.map((marker) => [marker, text.split(marker).length - 1]),
  );
}

function readActiveWorkerDiskSpace(payload: SessionsList): WorkerDiskSpaceProjection | undefined {
  const session = payload.sessions?.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return false;
    }
    return (candidate as Record<string, unknown>).key === SESSION_KEY;
  });
  if (!session) {
    return undefined;
  }
  const placementValue = requireRecord(session, "listed session").placement;
  if (!placementValue || typeof placementValue !== "object" || Array.isArray(placementValue)) {
    return undefined;
  }
  const placement = placementValue as Record<string, unknown>;
  if (placement.state !== "active") {
    return undefined;
  }
  const diskSpaceValue = placement.diskSpace;
  if (!diskSpaceValue || typeof diskSpaceValue !== "object" || Array.isArray(diskSpaceValue)) {
    return undefined;
  }
  const diskSpace = diskSpaceValue as Record<string, unknown>;
  if (
    typeof diskSpace.status !== "string" ||
    typeof diskSpace.availableBytes !== "number" ||
    typeof diskSpace.totalBytes !== "number" ||
    typeof diskSpace.observedAtMs !== "number"
  ) {
    throw new Error(`invalid active worker disk-space projection: ${JSON.stringify(diskSpace)}`);
  }
  return {
    status: diskSpace.status,
    availableBytes: diskSpace.availableBytes,
    totalBytes: diskSpace.totalBytes,
    observedAtMs: diskSpace.observedAtMs,
  };
}

function isReclaimedWithoutDiskSpace(payload: SessionsList): boolean {
  const session = payload.sessions?.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return false;
    }
    return (candidate as Record<string, unknown>).key === SESSION_KEY;
  });
  if (!session) {
    return false;
  }
  const placementValue = requireRecord(session, "listed session").placement;
  if (!placementValue || typeof placementValue !== "object" || Array.isArray(placementValue)) {
    return false;
  }
  const placement = placementValue as Record<string, unknown>;
  return placement.state === "reclaimed" && !("diskSpace" in placement);
}

async function waitForOutbound(
  state: ReturnType<typeof createQaBusState>,
  cursor: number,
  marker: string,
): Promise<void> {
  await waitFor(`qa-channel outbound ${marker}`, () =>
    state
      .getSnapshot()
      .messages.slice(cursor)
      .some((message) => message.direction === "outbound" && message.text.includes(marker))
      ? true
      : undefined,
  );
}

async function waitForFailedPlacement(gateway: Gateway) {
  return await waitFor("failed worker placement", async () => {
    const payload = requireRecord(
      await gateway.call("sessions.describe", { key: SESSION_KEY }),
      "sessions.describe",
    );
    const session = requireRecord(payload.session, "described session");
    const placement = requireRecord(session.placement, "session placement");
    return placement.state === "failed" ? placement : undefined;
  });
}

function waitForVolatilePreview(events: readonly GatewayEvent[], runId: string) {
  return waitFor("volatile sidebar preview", () => {
    const agentVisible = events.some((event) => {
      if (event.event !== "agent") {
        return false;
      }
      const payload = requireRecord(event.payload, "agent event");
      return payload.runId === runId && JSON.stringify(payload.data ?? {}).includes(VOLATILE_TEXT);
    });
    const chatText = events
      .filter((event) => event.event === "chat")
      .map((event) => requireRecord(event.payload, "chat event"))
      .filter((payload) => payload.runId === runId && payload.state === "delta")
      .map((payload) => (typeof payload.deltaText === "string" ? payload.deltaText : ""))
      .join("");
    return agentVisible || chatText.includes(VOLATILE_TEXT) ? true : undefined;
  });
}

function waitForChatError(events: readonly GatewayEvent[], runId: string) {
  return waitFor("operator-visible chat error", () => {
    const found = events.find((event) => {
      if (event.event !== "chat") {
        return false;
      }
      const payload = requireRecord(event.payload, "chat event");
      return payload.runId === runId && payload.state === "error";
    });
    return found ? requireRecord(found.payload, "chat error") : undefined;
  });
}

async function runProof(options: ProducerOptions) {
  const state = createQaBusState();
  // openclaw-temp-dir: allow standalone QA producer owns and removes this fixture root.
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cloud-midturn-loss-"));
  let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
  let provider: Awaited<ReturnType<typeof startMidturnProvider>> | undefined;
  let gateway: Gateway | undefined;
  let operator: GatewayClient | undefined;
  let workerNode: PairedNodeWorkerHost | undefined;
  let published: PublishedWireWorkspace | undefined;
  let workerLaunchId: string | undefined;
  let proofError: unknown;
  let verdict: Record<string, unknown> | undefined;
  try {
    bus = await startQaBusServer({ state });
    provider = await startMidturnProvider();
    published = await createPublishedWireWorkspace(fixtureRoot);
    const transport = createQaChannelTransport(state);
    gateway = await startQaGatewayChild({
      repoRoot: options.repoRoot,
      useRepoCli: true,
      providerBaseUrl: `${provider.baseUrl}/v1`,
      providerMode: "mock-openai",
      primaryModel: MODEL_REF,
      alternateModel: MODEL_REF,
      transport,
      transportBaseUrl: bus.baseUrl,
      enabledPluginIds: ["qa-lab"],
      controlUiEnabled: false,
      controlUiAllowedOrigins: ["http://127.0.0.1"],
      mutateConfig: (config) => ({
        ...config,
        session: { ...config.session, dmScope: "per-peer" },
        nodeHost: {
          ...config.nodeHost,
          workerRuns: { enabled: true },
        },
      }),
    });
    const events: GatewayEvent[] = [];
    const deviceIdentity = loadOrCreateDeviceIdentity({
      path: path.join(fixtureRoot, "operator-identity.sqlite"),
    });
    operator = await connectOperator(gateway, events, deviceIdentity);
    workerNode = await createPairedNodeWorkerHost({
      gateway,
      operator,
      root: fixtureRoot,
      label: "midturn-worker",
      onInvoke: (frame) => {
        if (frame.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND && frame.paramsJSON) {
          workerLaunchId = (JSON.parse(frame.paramsJSON) as { launchId?: string }).launchId;
        }
      },
    });
    await operator.request("sessions.create", {
      key: SESSION_KEY,
      agentId: "qa",
      worktree: true,
      worktreeName: `cloud-midturn-${randomUUID().slice(0, 8)}`,
      worktreeBaseRef: "main",
      cwd: published.source,
    });
    const created = requireRecord(
      await gateway.call("sessions.describe", { key: SESSION_KEY }),
      "created session",
    );
    const session = requireRecord(created.session, "created session details");
    const localWorkspaceDir = session.execCwd ?? session.spawnedCwd;
    if (typeof localWorkspaceDir !== "string") {
      throw new Error("created session did not expose its managed workspace");
    }
    await Promise.all([
      fs.writeFile(path.join(localWorkspaceDir, "checkpoint-1.txt"), "CLOUD-MIDTURN-TOOL-1\n"),
      fs.writeFile(path.join(localWorkspaceDir, "checkpoint-2.txt"), "CLOUD-MIDTURN-TOOL-2\n"),
    ]);
    await operator.request("sessions.messages.subscribe", { key: SESSION_KEY });

    const baselineCursor = state.getSnapshot().messages.length;
    state.addInboundMessage({
      conversation: { id: SENDER_ID, kind: "direct" },
      senderId: SENDER_ID,
      senderName: SENDER_ID,
      text: BASELINE_PROMPT,
    });
    await waitForOutbound(state, baselineCursor, BASELINE_REPLY);

    await gateway.call(
      "sessions.dispatch",
      { key: SESSION_KEY, deviceId: workerNode.identity.deviceId },
      { timeoutMs: PROOF_TIMEOUT_MS },
    );
    const runId = `cloud-midturn-loss-${randomUUID()}`;
    const started = await operator.request<GatewayRunResult>("chat.send", {
      sessionKey: SESSION_KEY,
      message: MIDTURN_PROMPT,
      deliver: false,
      idempotencyKey: runId,
    });
    if (started.status !== "started" || started.runId !== runId) {
      throw new Error(`chat.send did not start the worker turn: ${JSON.stringify(started)}`);
    }
    await provider.partialStarted;
    const committedBeforeKill = await waitFor("four committed worker messages", async () => {
      const messages = await readHistory(operator as GatewayClient);
      const counts = markerCounts(messages);
      return Object.values(counts).every((count) => count === 1) ? messages : undefined;
    });
    await waitForVolatilePreview(events, runId);

    const node = workerNode;
    const activeWorker = await waitFor("proof-owned active node worker", async () => {
      if (!workerLaunchId) {
        return undefined;
      }
      const receipt = await node.supervisor.status(workerLaunchId);
      return receipt?.state === "running" && receipt.runId === runId && receipt.worker
        ? receipt.worker
        : undefined;
    });
    process.kill(activeWorker.pid, "SIGKILL");
    const killed = {
      killedProcessCount: 1,
      nodeDeviceId: node.identity.deviceId,
      workerPid: activeWorker.pid,
    };
    const waitResult = await operator.request<GatewayRunResult>(
      "agent.wait",
      { runId, timeoutMs: PROOF_TIMEOUT_MS },
      { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
    );
    const chatError = await waitForChatError(events, runId);
    const failedPlacement = await waitForFailedPlacement(gateway);
    const terminalReason = String(failedPlacement.terminalReason ?? "");
    if (!terminalReason || terminalReason.length > 1_024) {
      throw new Error(`placement terminal reason was missing or unbounded: ${terminalReason}`);
    }
    const historyAfterFailure = await readHistory(operator);
    const countsAfterFailure = markerCounts(historyAfterFailure);
    const committedSequence = historyAfterFailure.flatMap((message) => {
      const text = messageText(message);
      const marker = COMMITTED_MARKERS.find((candidate) => text.includes(candidate));
      return marker ? [{ role: messageRole(message), marker }] : [];
    });
    if (
      !isDeepStrictEqual(historyAfterFailure, committedBeforeKill) ||
      committedSequence.length !== COMMITTED_MARKERS.length ||
      committedSequence.some((entry, index) => entry.marker !== COMMITTED_MARKERS[index]) ||
      historyAfterFailure.some((message) => messageText(message).includes(VOLATILE_TEXT)) ||
      Object.values(countsAfterFailure).some((count) => count !== 1)
    ) {
      throw new Error(`unexpected durable cutoff: ${JSON.stringify(committedSequence)}`);
    }

    // Keep the node connected until its supervisor delivers the worker's terminal receipt.
    await node.disconnect();
    await node.connect();
    const redispatched = requireRecord(
      await gateway.call(
        "sessions.dispatch",
        { key: SESSION_KEY, deviceId: workerNode.identity.deviceId },
        { timeoutMs: PROOF_TIMEOUT_MS },
      ),
      "sessions.dispatch redispatch",
    );
    const recoveryRunId = `cloud-midturn-recovery-${randomUUID()}`;
    const recoveryStarted = await operator.request<GatewayRunResult>("chat.send", {
      sessionKey: SESSION_KEY,
      message: CONTEXT_PROMPT,
      deliver: false,
      idempotencyKey: recoveryRunId,
    });
    if (recoveryStarted.status !== "started" || recoveryStarted.runId !== recoveryRunId) {
      throw new Error(`recovery chat.send did not start: ${JSON.stringify(recoveryStarted)}`);
    }
    const recoveryResult = await operator.request<GatewayRunResult>(
      "agent.wait",
      { runId: recoveryRunId, timeoutMs: PROOF_TIMEOUT_MS },
      { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
    );
    if (recoveryResult.status !== "ok") {
      throw new Error(`recovery turn failed: ${JSON.stringify(recoveryResult)}`);
    }
    const historyAfterRecovery = await waitFor("durable recovery reply", async () => {
      const messages = await readHistory(operator as GatewayClient);
      return messages.some((message) => messageText(message).includes(CONTEXT_REPLY))
        ? messages
        : undefined;
    });
    const recoveryCounts = markerCounts(historyAfterRecovery);
    const recoveryContext = provider.contextRequest;
    if (
      !COMMITTED_MARKERS.every((marker) => recoveryContext.includes(marker)) ||
      recoveryContext.includes(VOLATILE_TEXT) ||
      Object.values(recoveryCounts).some((count) => count !== 1)
    ) {
      throw new Error(
        "redispatched inference did not preserve exactly one copy of each checkpoint",
      );
    }

    const qaOperator = operator;
    if (!qaOperator) {
      throw new Error("operator was unavailable after recovery");
    }
    const activeDiskSpace = await waitFor(
      "real paired-node worker disk-space projection",
      async () =>
        readActiveWorkerDiskSpace(await qaOperator.request<SessionsList>("sessions.list", {})),
    );
    const reclaimed = requireRecord(
      await operator.request("sessions.reclaim", { key: SESSION_KEY }),
      "sessions.reclaim",
    );
    if (requireRecord(reclaimed.placement, "reclaimed placement").state !== "reclaimed") {
      throw new Error(`sessions.reclaim did not reclaim the worker: ${JSON.stringify(reclaimed)}`);
    }
    await waitFor("retired worker disk-space projection eviction", async () => {
      const listed = await qaOperator.request<SessionsList>("sessions.list", {});
      return isReclaimedWithoutDiskSpace(listed) ? true : undefined;
    });

    verdict = {
      status: "pass",
      providerMode: "mock-openai",
      channel: "qa-channel",
      workerProvider: "device",
      sessionKey: SESSION_KEY,
      killedWorker: killed,
      durableTranscript: {
        cutoff: COMMITTED_MARKERS.length,
        exactPreKillSnapshotRetained: true,
        historyMessageCount: historyAfterFailure.length,
        exactMarkers: COMMITTED_MARKERS,
        sequence: committedSequence,
        markerCounts: countsAfterFailure,
        volatileMessagePersisted: false,
      },
      livePreview: {
        text: VOLATILE_TEXT,
        deliveredBeforeDeath: true,
        absentFromDurableTranscript: true,
        visibleFailureAfterDeath: true,
      },
      turnFailure: {
        agentWaitStatus: waitResult.status,
        chatError: String(chatError.errorMessage ?? chatError.error ?? "worker turn failed"),
        terminalReason,
        terminalReasonLength: terminalReason.length,
      },
      redispatch: {
        placementState: requireRecord(redispatched.placement, "redispatched placement").state,
        contextContainedCutoff: true,
        contextExcludedVolatilePreview: true,
        reply: CONTEXT_REPLY,
        turnStatus: recoveryResult.status,
        markerCounts: recoveryCounts,
      },
      diskSpaceProjection: {
        active: activeDiskSpace,
        reclaimedProjectionAbsent: true,
      },
      providerRequestCount: provider.requestCount,
      historyMessageCountBeforeKill: committedBeforeKill.length,
    };
    await fs.mkdir(options.artifactBase, { recursive: true });
    await fs.writeFile(
      path.join(options.artifactBase, VERDICT_FILE),
      `${JSON.stringify(verdict, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    proofError = error;
  } finally {
    const cleanup = await Promise.allSettled([
      operator?.stopAndWait({ timeoutMs: 1_000 }) ?? Promise.resolve(),
      workerNode?.stop() ?? Promise.resolve(),
      gateway?.stop() ?? Promise.resolve(),
      published ? closeWireServer(published.server) : Promise.resolve(),
      provider?.stop() ?? Promise.resolve(),
      bus?.stop() ?? Promise.resolve(),
      fs.rm(fixtureRoot, { recursive: true, force: true }),
    ]);
    const cleanupFailures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (cleanupFailures.length > 0) {
      proofError = new AggregateError(
        proofError ? [proofError, ...cleanupFailures] : cleanupFailures,
        "cloud worker mid-turn loss cleanup failed",
        proofError ? { cause: proofError } : undefined,
      );
    }
  }
  if (proofError) {
    throw proofError;
  }
  if (!verdict) {
    throw new Error("cloud worker mid-turn loss proof produced no verdict");
  }
  return verdict;
}

async function runProducer(options: ProducerOptions): Promise<QaEvidenceSummaryJson> {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: MODEL_REF,
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Cloud worker mid-turn machine loss",
      sourcePath: `qa/scenarios/runtime/${SCENARIO_ID}.yaml`,
      docsRefs: ["docs/gateway/cloud-workers.md", "docs/concepts/qa-e2e-automation.md"],
      codeRefs: [
        "src/worker/embedded-agent-transcript.runtime.ts",
        "src/gateway/worker-environments/transcript-commit.ts",
        "src/gateway/worker-environments/worker-turn-launcher.ts",
        "src/gateway/worker-environments/placement-disk-space.ts",
        "src/gateway/server-methods/sessions-list-cache.ts",
      ],
    },
  });
  const startedAt = Date.now();
  try {
    const verdict = await runProof(options);
    writer.appendLog(`pass: ${JSON.stringify(verdict)}\n`);
    return await writer.write({
      artifacts: [{ filePath: VERDICT_FILE, kind: "verdict" }],
      details:
        "paired-node worker loss preserved the exact committed transcript prefix, surfaced an error, and redispatched with continuous context",
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    writer.appendLog(`fail: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  }
}

async function main(argv: readonly string[]) {
  const options = parseOptions(argv);
  const evidence = await runProducer(options);
  const status = evidence.entries[0]?.result.status;
  console.log(`Cloud worker mid-turn loss evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(
    `Cloud worker mid-turn loss verdict: ${path.join(options.artifactBase, VERDICT_FILE)}`,
  );
  if (status === "pass") {
    console.log((await fs.readFile(path.join(options.artifactBase, VERDICT_FILE), "utf8")).trim());
  }
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
