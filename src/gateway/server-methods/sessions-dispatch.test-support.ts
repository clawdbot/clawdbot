import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const dispatchTestMocks = vi.hoisted(() => ({
  findLiveByOwner: vi.fn(),
  resolveTarget: vi.fn(),
}));

export function getDispatchTestMocks() {
  return dispatchTestMocks;
}

vi.mock("../../agents/worktrees/service.js", () => ({
  managedWorktrees: {
    findLiveByOwner: dispatchTestMocks.findLiveByOwner,
  },
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    resolveGatewaySessionStoreTargetWithStore: dispatchTestMocks.resolveTarget,
  };
});

import { sessionDispatchHandlers } from "./sessions-dispatch.js";

export const dispatchTestSessionKey = "agent:main:cloud-test";
export const dispatchTestSessionId = "session-cloud-test";

export function makeReclaimedPlacement(): Extract<
  WorkerSessionPlacementRecord,
  { state: "reclaimed" }
> {
  return {
    sessionId: dispatchTestSessionId,
    agentId: "main",
    sessionKey: dispatchTestSessionKey,
    executionMode: "worker-turn",
    state: "reclaimed",
    environmentId: "environment-previous",
    generation: 4,
    activeOwnerEpoch: 1,
    workspaceBaseManifestRef: "manifest-previous",
    remoteWorkspaceDir: "/worker/session-cloud-test",
    workerBundleHash: "c".repeat(64),
    lastTranscriptAckCursor: 3,
    lastLiveEventAckCursor: 2,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    turnClaim: null,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
  };
}

export function makeFailedPlacement(): Extract<WorkerSessionPlacementRecord, { state: "failed" }> {
  return {
    ...makeReclaimedPlacement(),
    state: "failed",
    recoveryError: "gateway restarted during worker dispatch",
    turnClaim: null,
  };
}

export function makeSessionTarget(entry?: {
  sessionId: string;
  worktree?: { id: string; branch: string; repoRoot: string };
  agentHarnessId?: string;
  agentRuntimeOverride?: string;
  archivedAt?: number;
  modelSelectionLocked?: boolean;
  providerOverride?: string;
  modelOverride?: string;
}) {
  // Pin an anthropic model by default: the effective-runtime fallback consults
  // the process-global harness registry, so the default openai model resolves
  // to "codex" whenever a sibling test in the shard registered that harness.
  const pinnedEntry = entry
    ? { providerOverride: "anthropic", modelOverride: "claude-test", ...entry }
    : undefined;
  return {
    agentId: "main",
    storePath: "/tmp/openclaw-agent.sqlite",
    canonicalKey: dispatchTestSessionKey,
    storeKeys: [dispatchTestSessionKey],
    store: pinnedEntry ? { [dispatchTestSessionKey]: pinnedEntry } : {},
  };
}

export function makeDispatchTestContext(
  overrides: Partial<GatewayRequestContext> = {},
): GatewayRequestContext {
  return {
    getRuntimeConfig: () => ({
      cloudWorkers: {
        profiles: {
          test: { provider: "fake", region: "test", size: "small" },
        },
      },
    }),
    ...overrides,
  } as unknown as GatewayRequestContext;
}

export async function invokeSessionDispatch(
  context: GatewayRequestContext,
  target: { profileId: string; machineClass?: string } | { deviceId: string } = {
    profileId: "test",
  },
) {
  const respond = vi.fn() as unknown as RespondFn;
  await expectDefined(
    sessionDispatchHandlers["sessions.dispatch"],
    'sessionDispatchHandlers["sessions.dispatch"] test invariant',
  )({
    req: { id: "dispatch-request" } as never,
    params: { key: dispatchTestSessionKey, ...target },
    respond,
    context,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

export async function invokeSessionMove(
  context: GatewayRequestContext,
  params: {
    expected: { generation: number; environmentId: string; ownerEpoch: number };
    target:
      | { kind: "gateway" }
      | { kind: "profile"; profileId: string }
      | { kind: "device"; deviceId: string };
  },
) {
  const respond = vi.fn() as unknown as RespondFn;
  await expectDefined(
    sessionDispatchHandlers["sessions.move"],
    'sessionDispatchHandlers["sessions.move"] test invariant',
  )({
    req: { id: "move-request" } as never,
    params: { key: dispatchTestSessionKey, ...params },
    respond,
    context,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

export async function invokeSessionReclaim(context: GatewayRequestContext) {
  const respond = vi.fn() as unknown as RespondFn;
  await expectDefined(
    sessionDispatchHandlers["sessions.reclaim"],
    'sessionDispatchHandlers["sessions.reclaim"] test invariant',
  )({
    req: { id: "reclaim-request" } as never,
    params: { key: dispatchTestSessionKey },
    respond,
    context,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}
