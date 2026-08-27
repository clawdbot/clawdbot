import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  createQaBusState,
  createQaChannelTransport,
  createStaticSshWorkerProvider,
  QA_EVIDENCE_FILENAME,
  startQaBusServer,
  startQaGatewayChild,
  startQaMockOpenAiServer,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import { WORKER_LAUNCH_V2_PROTOCOL_FEATURE } from "../../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createWorkerSessionPlacementStore } from "../../../../src/gateway/worker-environments/placement-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../../src/state/openclaw-state-db.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SCENARIO_ID = "cloud-worker-disappearance";
const VERDICT_FILE = "cloud-worker-disappearance-verdict.json";
const BUNDLE_HASH = "a".repeat(64);
const MANIFEST_REF = `sha256:${"b".repeat(64)}`;
const ENVIRONMENT_ID = "qa-static-worker-loss";
const INDEPENDENT_ENVIRONMENT_ID = "qa-static-worker-independent";
const INDEPENDENT_REASON = "independent session failure";

type ProducerOptions = { artifactBase: string; repoRoot: string };
type Gateway = Awaited<ReturnType<typeof startQaGatewayChild>>;
type SessionIdentity = { agentId: string; sessionId: string; sessionKey: string };

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

async function waitForOutbound(
  state: ReturnType<typeof createQaBusState>,
  cursor: number,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const outbound = state
      .getSnapshot()
      .messages.slice(cursor)
      .find((message) => message.direction === "outbound" && message.text.includes(marker));
    if (outbound) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`qa-channel did not deliver ${marker}`);
}

async function createQaSession(
  gateway: Gateway,
  state: ReturnType<typeof createQaBusState>,
  senderId: string,
  marker: string,
): Promise<SessionIdentity> {
  const beforePayload = requireRecord(
    await gateway.call("sessions.list", { limit: 100 }),
    "sessions.list before inbound",
  );
  const beforeIds = new Set(
    (Array.isArray(beforePayload.sessions) ? beforePayload.sessions : []).flatMap((entry) => {
      const row = requireRecord(entry, "session row");
      return typeof row.sessionId === "string" ? [row.sessionId] : [];
    }),
  );
  const cursor = state.getSnapshot().messages.length;
  state.addInboundMessage({
    conversation: { id: senderId, kind: "direct" },
    senderId,
    senderName: senderId,
    text: `Reply exactly: ${marker}`,
  });
  await waitForOutbound(state, cursor, marker);
  const payload = requireRecord(
    await gateway.call("sessions.list", { limit: 100 }),
    "sessions.list",
  );
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const rows = sessions.map((entry) => requireRecord(entry, "session row"));
  const session =
    rows.find((entry) => typeof entry.sessionId === "string" && !beforeIds.has(entry.sessionId)) ??
    rows.find((entry) =>
      [entry.key, entry.lastTo, entry.displayName, entry.label].some(
        (value) => typeof value === "string" && value.includes(senderId),
      ),
    );
  if (
    !session ||
    typeof session.key !== "string" ||
    typeof session.sessionId !== "string" ||
    typeof session.agentId !== "string"
  ) {
    throw new Error(`sessions.list did not resolve qa-channel session for ${senderId}`);
  }
  return { agentId: session.agentId, sessionId: session.sessionId, sessionKey: session.key };
}

function seedPlacement(
  store: ReturnType<typeof createWorkerSessionPlacementStore>,
  session: SessionIdentity,
) {
  let placement = store.startDispatch(session);
  placement = store.transition({
    sessionId: session.sessionId,
    from: "requested",
    to: "provisioning",
    expectedGeneration: placement.generation,
    patch: { environmentId: ENVIRONMENT_ID },
  });
  placement = store.transition({
    sessionId: session.sessionId,
    from: "provisioning",
    to: "syncing",
    expectedGeneration: placement.generation,
    patch: { workerBundleHash: BUNDLE_HASH },
  });
  placement = store.transition({
    sessionId: session.sessionId,
    from: "syncing",
    to: "starting",
    expectedGeneration: placement.generation,
    patch: { workspaceBaseManifestRef: MANIFEST_REF, remoteWorkspaceDir: "/qa/workspace" },
  });
  return store.transition({
    sessionId: session.sessionId,
    from: "starting",
    to: "active",
    expectedGeneration: placement.generation,
    patch: { activeOwnerEpoch: 1 },
  });
}

function seedUnknownWorkerState(
  stateDir: string,
  lost: SessionIdentity,
  isolated: SessionIdentity,
) {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  const raw = new DatabaseSync(databasePath);
  try {
    raw
      .prepare(
        `INSERT INTO worker_environments (
          environment_id, provider_id, profile_id, profile_snapshot_json,
          provision_operation_id, lease_id, shared_host, ssh_host, ssh_port, ssh_user,
          ssh_host_key, ssh_key_ref_json, bootstrap_bundle_hash, bootstrap_openclaw_version,
          bootstrap_protocol_features_json, owner_epoch, teardown_terminal_state,
          attached_session_ids_json, state, created_at_ms, updated_at_ms, state_changed_at_ms,
          idle_since_at_ms, destroy_requested_at_ms, last_error
        ) VALUES (?, 'static-ssh', 'development', '{}', ?, 'static-ssh:', 1,
          '127.0.0.1', 22, 'qa', 'ssh-ed25519 AAAA', ?, ?, 'qa', ?, 1, NULL,
          '[]', 'orphaned', 1, 1, 1, NULL, NULL, 'Worker provider no longer recognizes lease')`,
      )
      .run(
        ENVIRONMENT_ID,
        `qa:${ENVIRONMENT_ID}`,
        JSON.stringify({ source: "file", provider: "qa", id: "/tmp/qa-key" }),
        BUNDLE_HASH,
        JSON.stringify([WORKER_LAUNCH_V2_PROTOCOL_FEATURE]),
      );
  } finally {
    raw.close();
  }

  const database = openOpenClawStateDatabase({ path: databasePath });
  try {
    const store = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
    seedPlacement(store, lost);
    let other = store.startDispatch(isolated);
    other = store.transition({
      sessionId: isolated.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: other.generation,
      patch: { environmentId: INDEPENDENT_ENVIRONMENT_ID },
    });
    store.fail({
      sessionId: isolated.sessionId,
      expectedGeneration: other.generation,
      recoveryError: INDEPENDENT_REASON,
    });
  } finally {
    closeOpenClawStateDatabaseForTest();
  }
}

async function describePlacement(gateway: Gateway, session: SessionIdentity) {
  const payload = requireRecord(
    await gateway.call("sessions.describe", { key: session.sessionKey }),
    "sessions.describe",
  );
  const row = requireRecord(payload.session, "described session");
  return requireRecord(row.placement, "session placement");
}

async function waitForFailedPlacement(gateway: Gateway, session: SessionIdentity) {
  const deadline = Date.now() + 60_000;
  let latest: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    latest = await describePlacement(gateway, session);
    if (latest.state === "failed") {
      return latest;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`placement did not fail: ${JSON.stringify(latest)}`);
}

async function runProof(options: ProducerOptions) {
  const state = createQaBusState();
  let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
  let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
  let gateway: Gateway | undefined;
  let verdict: Record<string, unknown> | undefined;
  let proofError: unknown;
  try {
    bus = await startQaBusServer({ state });
    mock = await startQaMockOpenAiServer();
    const transport = createQaChannelTransport(state);
    const inspection = await createStaticSshWorkerProvider().inspect({
      leaseId: "static-ssh:",
      profile: { settings: {} },
    });
    if (inspection.status !== "unknown") {
      throw new Error(`static-ssh disappearance fixture returned ${inspection.status}`);
    }
    gateway = await startQaGatewayChild({
      repoRoot: options.repoRoot,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transport,
      transportBaseUrl: bus.baseUrl,
      enabledPluginIds: ["qa-lab"],
      controlUiEnabled: false,
      mutateConfig: (config) => ({
        ...config,
        session: { ...config.session, dmScope: "per-peer" },
        cloudWorkers: {
          profiles: {
            development: { provider: "static-ssh", install: "bundle", settings: {} },
          },
        },
      }),
    });
    const lost = await createQaSession(gateway, state, "qa-worker-loss", "WORKER-LOSS-BASELINE");
    const isolated = await createQaSession(
      gateway,
      state,
      "qa-worker-isolated",
      "WORKER-ISOLATION-BASELINE",
    );
    if (lost.sessionId === isolated.sessionId) {
      throw new Error("qa-channel baseline did not create two isolated sessions");
    }

    await gateway.restartAfterStateMutation(async ({ stateDir }) => {
      seedUnknownWorkerState(stateDir, lost, isolated);
    });
    const first = await waitForFailedPlacement(gateway, lost);
    const independent = await waitForFailedPlacement(gateway, isolated);
    if (
      first.environmentId !== ENVIRONMENT_ID ||
      independent.environmentId !== INDEPENDENT_ENVIRONMENT_ID
    ) {
      throw new Error("session placements did not retain their distinct environment identities");
    }
    const firstReason = String(first.terminalReason ?? "");
    if (!firstReason.startsWith("cloud worker disappeared:") || firstReason.length > 1_024) {
      throw new Error(`unexpected disappearance reason: ${firstReason}`);
    }
    if (independent.terminalReason !== INDEPENDENT_REASON || firstReason === INDEPENDENT_REASON) {
      throw new Error("independent session placements leaked terminal reasons");
    }
    const terminalAtMs = first.terminalAtMs;
    const isolatedTerminalAtMs = independent.terminalAtMs;

    for (let restart = 0; restart < 2; restart += 1) {
      await gateway.restartAfterStateMutation(async () => {});
      const recovered = await waitForFailedPlacement(gateway, lost);
      const recoveredIndependent = await waitForFailedPlacement(gateway, isolated);
      if (
        recovered.terminalReason !== firstReason ||
        recovered.terminalAtMs !== terminalAtMs ||
        recoveredIndependent.terminalReason !== INDEPENDENT_REASON ||
        recoveredIndependent.terminalAtMs !== isolatedTerminalAtMs
      ) {
        throw new Error(`terminal facts changed after restart ${restart + 1}`);
      }
    }

    const environmentPayload = requireRecord(
      await gateway.call("environments.list", {}),
      "environments.list",
    );
    const environments = Array.isArray(environmentPayload.environments)
      ? environmentPayload.environments.map((entry) => requireRecord(entry, "environment"))
      : [];
    const environment = environments.find((entry) => entry.id === ENVIRONMENT_ID);
    const worker = environment
      ? requireRecord(environment.worker, "worker environment")
      : undefined;
    if (worker?.state !== "orphaned" || typeof worker.error !== "string") {
      throw new Error("environment-level orphaned diagnostic was not preserved");
    }

    verdict = {
      status: "pass",
      providerMode: "mock-openai",
      channel: "qa-channel",
      workerProvider: "static-ssh",
      gatewayReplacementCount: 3,
      disappearance: {
        sessionId: lost.sessionId,
        environmentId: ENVIRONMENT_ID,
        terminalReason: firstReason,
        terminalAtMs,
        durableAcrossRestarts: true,
      },
      isolation: {
        environmentId: INDEPENDENT_ENVIRONMENT_ID,
        otherSessionId: isolated.sessionId,
        otherTerminalReason: independent.terminalReason,
        otherTerminalAtMs: isolatedTerminalAtMs,
        distinctEnvironments: true,
        reasonsDistinct: true,
        durableAcrossRestarts: true,
      },
      environment: { state: worker.state, error: worker.error },
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
      gateway?.stop() ?? Promise.resolve(),
      bus?.stop() ?? Promise.resolve(),
      mock?.stop() ?? Promise.resolve(),
    ]);
    const cleanupFailures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (cleanupFailures.length > 0) {
      proofError = new AggregateError(
        proofError ? [proofError, ...cleanupFailures] : cleanupFailures,
        "cloud worker disappearance cleanup failed",
        proofError ? { cause: proofError } : undefined,
      );
    }
  }
  if (proofError) {
    throw proofError;
  }
  if (!verdict) {
    throw new Error("cloud worker disappearance proof produced no verdict");
  }
  return verdict;
}

async function runProducer(options: ProducerOptions): Promise<QaEvidenceSummaryJson> {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Cloud worker disappearance recovery",
      sourcePath: `qa/scenarios/runtime/${SCENARIO_ID}.yaml`,
      docsRefs: ["docs/gateway/cloud-workers.md", "docs/concepts/qa-e2e-automation.md"],
      codeRefs: [
        "src/gateway/worker-environments/placement-pending-failure.ts",
        "src/gateway/worker-environments/placement-dispatch-recovery.ts",
        "src/gateway/worker-environments/placement-projector.ts",
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
        "qa-channel baseline, provider disappearance, restart durability, and session isolation passed",
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
  console.log(`Cloud worker disappearance evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(
    `Cloud worker disappearance verdict: ${path.join(options.artifactBase, VERDICT_FILE)}`,
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
