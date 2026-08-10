import { createHash } from "node:crypto";
import {
  createQaGatewayApiKeyCredentialIsolation,
  QA_GATEWAY_CREDENTIAL_ISOLATION_ENV_OMIT_PATTERNS,
} from "../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

export const FRONTIER_MATRIX_SCHEMA_VERSION = 2 as const;
export const FRONTIER_MATRIX_ABBA = [
  { slot: "direct-1", mode: "direct", repetition: 1 },
  { slot: "code-1", mode: "code", repetition: 1 },
  { slot: "code-2", mode: "code", repetition: 2 },
  { slot: "direct-2", mode: "direct", repetition: 2 },
] as const;

export type FrontierMatrixMode = "direct" | "code";
export type Sha256 = string;
export type EvidenceSource = "production" | "test_fixture";

export type FrozenFrontierMatrixIdentity = {
  sourceSha: string;
  sourceDirty: false;
  buildSha256: Sha256;
  configSha256: Sha256;
  entrypointSha256: Sha256;
  lockfileSha256: Sha256;
  modelCapabilitySha256: Sha256;
  nodeVersion: string;
};

export type FrontierTaskDescriptor = {
  id: string;
  fixtureSha256: Sha256;
  promptSha256: Sha256;
  oracleSha256: Sha256;
};

export type FrontierModeConfigProof = {
  baseSha256: Sha256;
  directSha256: Sha256;
  codeSha256: Sha256;
};

export type FrontierExecutionProof = {
  providerRetry: {
    status: "verified" | "declared_unverified";
    maxRetries: number;
  };
  encryptedPayloadRecovery: {
    status: "disabled" | "mandatory";
    maxRecoveries: number;
  };
  transportRetry: {
    status: "verified" | "unknown";
    maxRetries: number | null;
  };
  warmCold: {
    build: "warm_shared_immutable";
    gatewayProcess: "cold_per_cell";
    openClawState: "cold_fresh_per_cell";
    providerFirstCallCache: "observed_per_trace";
    transportPrewarm: "observed_disabled" | "unobserved";
    transportReuse: "observed_disabled" | "unobserved";
  };
};

export type FrontierRunnerConfig = {
  localModelLean: false;
  thinking: string;
  timeoutSeconds: number;
};

export type FrontierTaskManifestEntry = FrontierTaskDescriptor & {
  index: number;
  sha256: Sha256;
};

export type FrozenFrontierMatrixCell = {
  id: string;
  taskId: string;
  taskIndex: number;
  taskSha256: Sha256;
  slot: (typeof FRONTIER_MATRIX_ABBA)[number]["slot"];
  mode: FrontierMatrixMode;
  repetition: 1 | 2;
  sequence: number;
  stateKey: Sha256;
};

export type FrontierTraceMetrics = {
  effectiveTurns: number;
  logicalModelCalls: number;
  modelFacingApiCalls: number;
  retries: number;
  authRecoveries: number;
  payloadRecoveries: number;
  transportFallbacks: number;
  toolCalls: number;
  underlyingTotalCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  agentTimeMs: number;
  commandExecutionDurationMs: number;
  wallLatencyMs: number;
};

export type FrozenFrontierMatrixPlan = {
  schemaVersion: typeof FRONTIER_MATRIX_SCHEMA_VERSION;
  campaign: {
    id: string;
    blockId: string;
    nonceSha256: Sha256;
    evidenceAuthority: "agent_exec_trace_v2";
  };
  runDate: string;
  model: {
    ref: string;
    provider: string;
    model: string;
    api: string;
  };
  source: FrozenFrontierMatrixIdentity;
  task: {
    subset: string[];
    subsetSha256: Sha256;
    order: string[];
    orderSha256: Sha256;
    manifest: FrontierTaskManifestEntry[];
    manifestSha256: Sha256;
  };
  execution: {
    concurrency: 1;
    schedule: "serial_task_major_abba";
    sampling: {
      seedSupport: "supported" | "unsupported";
      seed: string;
      seedSha256: Sha256;
      temperature: "provider_default";
      topP: "provider_default";
    };
    state: "fresh_process_and_state_per_cell";
    identityObservationTimeoutMs: number;
    runner: FrontierRunnerConfig;
    proof: FrontierExecutionProof;
    modeConfigProof: FrontierModeConfigProof;
  };
  cells: FrozenFrontierMatrixCell[];
  identitySha256: Sha256;
};

export function sha256(value: string): Sha256 {
  return createHash("sha256").update(value).digest("hex");
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalJsonValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => compareUtf8(left, right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

export function digestJson(value: unknown): Sha256 {
  return sha256(canonicalJson(value));
}

export function digestFrontierEvidence(domain: string, value: unknown): Sha256 {
  return sha256(`${domain}\0${canonicalJson(value)}`);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isSourceSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/u.test(value);
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value);
}

function isExactUtcCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function assertFrozenIdentity(identity: FrozenFrontierMatrixIdentity): void {
  const digests = [
    identity.buildSha256,
    identity.configSha256,
    identity.entrypointSha256,
    identity.lockfileSha256,
    identity.modelCapabilitySha256,
  ];
  if (
    (identity as { sourceDirty?: unknown }).sourceDirty !== false ||
    !isSourceSha(identity.sourceSha) ||
    digests.some((digest) => !isSha256(digest)) ||
    !/^v\d+\.\d+\.\d+/u.test(identity.nodeVersion)
  ) {
    throw new Error("frontier matrix requires a clean frozen runtime identity");
  }
}

export function sameFrozenIdentity(
  left: FrozenFrontierMatrixIdentity,
  right: FrozenFrontierMatrixIdentity,
): boolean {
  return digestJson(left) === digestJson(right);
}

function assertRetryCount(value: number | null, label: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 100)) {
    throw new Error(`frontier matrix ${label} must be null or an integer from 0 to 100`);
  }
}

function buildCells(
  manifest: readonly FrontierTaskManifestEntry[],
  identitySha256: Sha256,
): FrozenFrontierMatrixCell[] {
  let sequence = 0;
  return manifest.flatMap((task) =>
    FRONTIER_MATRIX_ABBA.map((slot) => {
      sequence += 1;
      const id = `${task.id}:${slot.slot}`;
      return {
        id,
        taskId: task.id,
        taskIndex: task.index,
        taskSha256: task.sha256,
        ...slot,
        sequence,
        stateKey: sha256(`${identitySha256}\0${id}\0${task.sha256}`),
      };
    }),
  );
}

export function buildFrozenFrontierMatrixPlan(params: {
  api: string;
  blockId: string;
  campaignId: string;
  campaignNonce: string;
  executionProof: FrontierExecutionProof;
  identityObservationTimeoutMs?: number;
  identity: FrozenFrontierMatrixIdentity;
  modeConfigProof: FrontierModeConfigProof;
  model: string;
  runDate: string;
  runner: FrontierRunnerConfig;
  sampling: {
    seedSupport: "supported" | "unsupported";
    seed: string;
  };
  tasks: readonly FrontierTaskDescriptor[];
}): FrozenFrontierMatrixPlan {
  assertFrozenIdentity(params.identity);
  const separator = params.model.indexOf("/");
  const provider = separator > 0 ? params.model.slice(0, separator) : "";
  const model = separator > 0 ? params.model.slice(separator + 1) : "";
  if (!provider || !model || !params.api.trim()) {
    throw new Error("frontier matrix requires an exact provider/model and API");
  }
  if (
    !isBoundedId(params.campaignId) ||
    !isBoundedId(params.blockId) ||
    params.campaignNonce.length < 16
  ) {
    throw new Error("frontier matrix requires bounded campaign, block, and nonce identity");
  }
  if (!isExactUtcCalendarDate(params.runDate)) {
    throw new Error("frontier matrix requires an exact run date");
  }
  const identityObservationTimeoutMs = params.identityObservationTimeoutMs ?? 30_000;
  if (
    !Number.isSafeInteger(identityObservationTimeoutMs) ||
    identityObservationTimeoutMs <= 0 ||
    identityObservationTimeoutMs > 300_000
  ) {
    throw new Error("frontier matrix requires a bounded identity observation timeout");
  }
  if (
    (params.runner as { localModelLean?: unknown }).localModelLean !== false ||
    !params.runner.thinking.trim() ||
    params.runner.thinking.length > 64 ||
    !Number.isSafeInteger(params.runner.timeoutSeconds) ||
    params.runner.timeoutSeconds <= 0 ||
    params.runner.timeoutSeconds > 3_600
  ) {
    throw new Error("frontier matrix requires bounded supported-frontier runner flags");
  }
  for (const digest of Object.values(params.modeConfigProof)) {
    if (!isSha256(digest)) {
      throw new Error("frontier matrix requires a bound Direct/Code config proof");
    }
  }
  if (params.modeConfigProof.directSha256 === params.modeConfigProof.codeSha256) {
    throw new Error("frontier matrix Direct and Code config proofs must differ");
  }
  assertRetryCount(params.executionProof.providerRetry.maxRetries, "provider retry count");
  assertRetryCount(
    params.executionProof.encryptedPayloadRecovery.maxRecoveries,
    "encrypted recovery count",
  );
  assertRetryCount(params.executionProof.transportRetry.maxRetries, "transport retry count");
  if (
    params.executionProof.transportRetry.status === "verified" &&
    params.executionProof.transportRetry.maxRetries === null
  ) {
    throw new Error("frontier matrix verified transport retry policy requires a count");
  }
  if (
    params.executionProof.encryptedPayloadRecovery.status === "disabled" &&
    params.executionProof.encryptedPayloadRecovery.maxRecoveries !== 0
  ) {
    throw new Error("frontier matrix disabled encrypted recovery must have zero recoveries");
  }
  if (!params.sampling.seed.trim() || params.sampling.seed.length > 256) {
    throw new Error("frontier matrix requires a bounded sampling seed identity");
  }
  if (params.tasks.length === 0) {
    throw new Error("frontier matrix task manifest must be non-empty");
  }
  const seen = new Set<string>();
  const manifest = params.tasks.map((task, index): FrontierTaskManifestEntry => {
    if (
      !isBoundedId(task.id) ||
      seen.has(task.id) ||
      !isSha256(task.fixtureSha256) ||
      !isSha256(task.promptSha256) ||
      !isSha256(task.oracleSha256)
    ) {
      throw new Error("frontier matrix tasks must be unique and fully digest-bound");
    }
    seen.add(task.id);
    const contents = { ...task, index };
    return Object.assign(contents, { sha256: digestJson(contents) });
  });
  const order = manifest.map((entry) => entry.id);
  const subset = [...order].toSorted(compareUtf8);
  const task = {
    subset,
    subsetSha256: digestJson(subset),
    order,
    orderSha256: digestJson(order),
    manifest,
    manifestSha256: digestJson(manifest),
  };
  const campaign = {
    id: params.campaignId,
    blockId: params.blockId,
    nonceSha256: sha256(params.campaignNonce),
    evidenceAuthority: "agent_exec_trace_v2" as const,
  };
  const execution = {
    concurrency: 1 as const,
    schedule: "serial_task_major_abba" as const,
    sampling: {
      seedSupport: params.sampling.seedSupport,
      seed: params.sampling.seed,
      seedSha256: sha256(params.sampling.seed),
      temperature: "provider_default" as const,
      topP: "provider_default" as const,
    },
    state: "fresh_process_and_state_per_cell" as const,
    identityObservationTimeoutMs,
    runner: structuredClone(params.runner),
    proof: structuredClone(params.executionProof),
    modeConfigProof: structuredClone(params.modeConfigProof),
  };
  const cellBasis = manifest.flatMap((entry) =>
    FRONTIER_MATRIX_ABBA.map((slot, slotIndex) => ({
      id: `${entry.id}:${slot.slot}`,
      taskId: entry.id,
      taskIndex: entry.index,
      taskSha256: entry.sha256,
      slot: slot.slot,
      mode: slot.mode,
      repetition: slot.repetition,
      sequence: entry.index * FRONTIER_MATRIX_ABBA.length + slotIndex + 1,
    })),
  );
  const planIdentityBasis = {
    schemaVersion: FRONTIER_MATRIX_SCHEMA_VERSION,
    campaign,
    runDate: params.runDate,
    model: { ref: params.model, provider, model, api: params.api },
    source: structuredClone(params.identity),
    task,
    execution,
    cells: cellBasis,
  };
  const identitySha256 = digestJson(planIdentityBasis);
  const plan = {
    ...planIdentityBasis,
    cells: buildCells(manifest, identitySha256),
    identitySha256,
  };
  assertFrozenFrontierMatrixPlan(plan);
  return plan;
}

function withCodeMode(
  config: OpenClawConfig,
  agentId: string,
  mode: FrontierMatrixMode,
): OpenClawConfig {
  const enabled = mode === "code";
  const entry = config.agents?.entries?.[agentId];
  return {
    ...config,
    agents: {
      ...config.agents,
      entries: {
        ...config.agents?.entries,
        [agentId]: {
          ...entry,
          tools: {
            ...entry?.tools,
            codeMode: { enabled },
          },
        },
      },
    },
    tools: {
      ...config.tools,
      codeMode: { enabled },
    },
  };
}

function configWithoutMode(
  config: OpenClawConfig,
  agentId: string,
): {
  config: OpenClawConfig;
  globalEnabled: unknown;
  agentEnabled: unknown;
} {
  const copy = structuredClone(config);
  const globalCodeMode = copy.tools?.codeMode;
  const agentCodeMode = copy.agents?.entries?.[agentId]?.tools?.codeMode;
  const globalEnabled =
    typeof globalCodeMode === "object" && globalCodeMode !== null
      ? globalCodeMode.enabled
      : undefined;
  const agentEnabled =
    typeof agentCodeMode === "object" && agentCodeMode !== null ? agentCodeMode.enabled : undefined;
  if (typeof globalCodeMode === "object" && globalCodeMode !== null) {
    delete globalCodeMode.enabled;
  }
  if (typeof agentCodeMode === "object" && agentCodeMode !== null) {
    delete agentCodeMode.enabled;
  }
  return { config: copy, globalEnabled, agentEnabled };
}

export function buildFrontierModeConfigProof(params: {
  agentId: string;
  direct: OpenClawConfig;
  code: OpenClawConfig;
}): FrontierModeConfigProof {
  const direct = configWithoutMode(params.direct, params.agentId);
  const code = configWithoutMode(params.code, params.agentId);
  if (
    direct.globalEnabled !== false ||
    direct.agentEnabled !== false ||
    code.globalEnabled !== true ||
    code.agentEnabled !== true ||
    digestJson(direct.config) !== digestJson(code.config)
  ) {
    throw new Error(
      "frontier matrix Direct and Code configs must differ only at Code Mode enable flags",
    );
  }
  return {
    baseSha256: digestJson(direct.config),
    directSha256: digestJson(params.direct),
    codeSha256: digestJson(params.code),
  };
}

export function createFrozenFrontierMatrixChildIsolation(params: {
  agentId: string;
  authProfileId: string;
  credential: string;
  mode: FrontierMatrixMode;
  model: string;
  sourceEnv?: NodeJS.ProcessEnv;
}) {
  const separator = params.model.indexOf("/");
  if (separator <= 0 || separator === params.model.length - 1) {
    throw new Error("frontier matrix model must use provider/model form");
  }
  const provider = params.model.slice(0, separator);
  const isolation = createQaGatewayApiKeyCredentialIsolation({
    sourceEnv: params.sourceEnv ?? process.env,
    credential: params.credential,
    provider,
    profileId: params.authProfileId,
    agentIds: [params.agentId],
  });
  if (
    Object.keys(isolation.childBaseEnv).some((key) =>
      QA_GATEWAY_CREDENTIAL_ISOLATION_ENV_OMIT_PATTERNS.some((pattern) => pattern.test(key)),
    )
  ) {
    throw new Error("frontier matrix child environment contains provider routing inputs");
  }
  const pinnedModel = `${params.model}@${params.authProfileId}`;
  const tools = {
    allow: ["conversations_list", "conversations_send"],
    codeMode: { enabled: params.mode === "code" },
  };
  return {
    ...isolation,
    prepareConfigBeforeSpawn: async (
      context: Parameters<typeof isolation.prepareConfigBeforeSpawn>[0],
    ): Promise<OpenClawConfig> => {
      const config = await isolation.prepareConfigBeforeSpawn(context);
      return withCodeMode(
        {
          ...config,
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents?.defaults,
              model: {
                primary: pinnedModel,
                fallbacks: [],
              },
              models: {
                [params.model]: config.agents?.defaults?.models?.[params.model] ?? {},
              },
            },
            entries: {
              [params.agentId]: {
                ...config.agents?.entries?.[params.agentId],
                model: pinnedModel,
                tools,
              },
            },
          },
          tools: {
            ...tools,
            toolSearch: { enabled: false },
          },
        },
        params.agentId,
        params.mode,
      );
    },
  };
}

function identityBasis(plan: FrozenFrontierMatrixPlan): unknown {
  return {
    schemaVersion: plan.schemaVersion,
    campaign: plan.campaign,
    runDate: plan.runDate,
    model: plan.model,
    source: plan.source,
    task: plan.task,
    execution: plan.execution,
    cells: plan.cells.map(({ stateKey: _stateKey, ...cell }) => cell),
  };
}

function assertFrozenFrontierMatrixPlan(plan: FrozenFrontierMatrixPlan): void {
  assertFrozenIdentity(plan.source);
  const proof = plan.execution.proof;
  assertRetryCount(proof.providerRetry.maxRetries, "provider retry count");
  assertRetryCount(proof.encryptedPayloadRecovery.maxRecoveries, "encrypted recovery count");
  assertRetryCount(proof.transportRetry.maxRetries, "transport retry count");
  const modeProof = plan.execution.modeConfigProof;
  const taskIds = plan.task.order;
  if (
    plan.schemaVersion !== FRONTIER_MATRIX_SCHEMA_VERSION ||
    plan.campaign.evidenceAuthority !== "agent_exec_trace_v2" ||
    !isBoundedId(plan.campaign.id) ||
    !isBoundedId(plan.campaign.blockId) ||
    !isSha256(plan.campaign.nonceSha256) ||
    !isExactUtcCalendarDate(plan.runDate) ||
    !plan.model.provider.trim() ||
    !plan.model.model.trim() ||
    !plan.model.api.trim() ||
    plan.model.provider.length > 256 ||
    plan.model.model.length > 512 ||
    plan.model.api.length > 256 ||
    plan.model.ref !== `${plan.model.provider}/${plan.model.model}` ||
    plan.execution.concurrency !== 1 ||
    plan.execution.schedule !== "serial_task_major_abba" ||
    plan.execution.state !== "fresh_process_and_state_per_cell" ||
    !Number.isSafeInteger(plan.execution.identityObservationTimeoutMs) ||
    plan.execution.identityObservationTimeoutMs <= 0 ||
    plan.execution.identityObservationTimeoutMs > 300_000 ||
    (plan.execution.runner as { localModelLean?: unknown }).localModelLean !== false ||
    !plan.execution.runner.thinking.trim() ||
    plan.execution.runner.thinking.length > 64 ||
    !Number.isSafeInteger(plan.execution.runner.timeoutSeconds) ||
    plan.execution.runner.timeoutSeconds <= 0 ||
    plan.execution.runner.timeoutSeconds > 3_600 ||
    (plan.execution.sampling.seedSupport !== "supported" &&
      plan.execution.sampling.seedSupport !== "unsupported") ||
    !plan.execution.sampling.seed.trim() ||
    plan.execution.sampling.seed.length > 256 ||
    plan.execution.sampling.seedSha256 !== sha256(plan.execution.sampling.seed) ||
    plan.execution.sampling.temperature !== "provider_default" ||
    plan.execution.sampling.topP !== "provider_default" ||
    (proof.providerRetry.status !== "verified" &&
      proof.providerRetry.status !== "declared_unverified") ||
    proof.providerRetry.maxRetries === null ||
    (proof.encryptedPayloadRecovery.status !== "disabled" &&
      proof.encryptedPayloadRecovery.status !== "mandatory") ||
    proof.encryptedPayloadRecovery.maxRecoveries === null ||
    (proof.transportRetry.status !== "verified" && proof.transportRetry.status !== "unknown") ||
    (proof.transportRetry.status === "verified" && proof.transportRetry.maxRetries === null) ||
    (proof.encryptedPayloadRecovery.status === "disabled" &&
      proof.encryptedPayloadRecovery.maxRecoveries !== 0) ||
    proof.warmCold.build !== "warm_shared_immutable" ||
    proof.warmCold.gatewayProcess !== "cold_per_cell" ||
    proof.warmCold.openClawState !== "cold_fresh_per_cell" ||
    proof.warmCold.providerFirstCallCache !== "observed_per_trace" ||
    (proof.warmCold.transportPrewarm !== "observed_disabled" &&
      proof.warmCold.transportPrewarm !== "unobserved") ||
    (proof.warmCold.transportReuse !== "observed_disabled" &&
      proof.warmCold.transportReuse !== "unobserved") ||
    !isSha256(modeProof.baseSha256) ||
    !isSha256(modeProof.directSha256) ||
    !isSha256(modeProof.codeSha256) ||
    modeProof.directSha256 === modeProof.codeSha256 ||
    plan.task.subsetSha256 !== digestJson(plan.task.subset) ||
    plan.task.orderSha256 !== digestJson(plan.task.order) ||
    plan.task.manifestSha256 !== digestJson(plan.task.manifest) ||
    plan.task.subset.length !== plan.task.order.length ||
    plan.task.order.length === 0 ||
    taskIds.some((id) => !isBoundedId(id)) ||
    new Set(taskIds).size !== taskIds.length ||
    digestJson(plan.task.subset) !== digestJson([...plan.task.order].toSorted(compareUtf8)) ||
    plan.task.manifest.length !== plan.task.order.length ||
    plan.task.manifest.some((entry, index) => {
      const { sha256: entrySha256, ...contents } = entry;
      return (
        entry.index !== index ||
        entry.id !== plan.task.order[index] ||
        !isSha256(entry.fixtureSha256) ||
        !isSha256(entry.promptSha256) ||
        !isSha256(entry.oracleSha256) ||
        entrySha256 !== digestJson(contents)
      );
    }) ||
    plan.identitySha256 !== digestJson(identityBasis(plan))
  ) {
    throw new Error("frontier matrix frozen plan invariant failed");
  }
  if (
    canonicalJson(buildCells(plan.task.manifest, plan.identitySha256)) !== canonicalJson(plan.cells)
  ) {
    throw new Error("frontier matrix frozen cell schedule invariant failed");
  }
}

export function verifyFrozenFrontierMatrixPlan(plan: FrozenFrontierMatrixPlan): boolean {
  try {
    assertFrozenFrontierMatrixPlan(plan);
    return true;
  } catch {
    return false;
  }
}

export function frontierMatrixPreflightBlockers(plan: FrozenFrontierMatrixPlan): string[] {
  const blockers: string[] = [];
  if (plan.execution.proof.providerRetry.status !== "verified") {
    blockers.push("provider_retry_policy_unverified");
  }
  if (plan.execution.proof.encryptedPayloadRecovery.status !== "disabled") {
    blockers.push("mandatory_encrypted_payload_recovery");
  }
  if (plan.execution.proof.transportRetry.status !== "verified") {
    blockers.push("transport_retry_policy_unknown");
  }
  if (
    plan.execution.proof.warmCold.transportPrewarm !== "observed_disabled" ||
    plan.execution.proof.warmCold.transportReuse !== "observed_disabled"
  ) {
    blockers.push("transport_warm_cold_state_unobserved");
  }
  return blockers;
}
