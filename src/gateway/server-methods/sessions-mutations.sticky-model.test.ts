import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const emptyPluginMetadataSnapshot = vi.hoisted(() => ({
  policyHash: "sticky-model-test-empty-plugin-policy",
  index: {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "sticky-model-test-empty-plugin-policy",
    generatedAtMs: 0,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  },
  registryDiagnostics: [],
  manifestRegistry: { plugins: [], diagnostics: [] },
  plugins: [],
  diagnostics: [],
  byPluginId: new Map(),
  normalizePluginId: (pluginId: string) => pluginId,
  owners: {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
  },
  metrics: {
    registrySnapshotMs: 0,
    manifestRegistryMs: 0,
    ownerMapsMs: 0,
    totalMs: 0,
    indexPluginCount: 0,
    manifestPluginCount: 0,
  },
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: () => emptyPluginMetadataSnapshot,
}));

vi.mock("../../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: () => undefined,
}));

const effects = vi.hoisted(() => ({
  stickyDispatch: vi.fn(() => "requested" as const),
  unexpectedCalls: [] as string[],
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => cfg,
}));

vi.mock("../../logging/subsystem.js", () => {
  const createLogger = (subsystem: string) => {
    const noop = () => {};
    return {
      subsystem,
      isEnabled: () => false,
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
      raw: noop,
      child: (name: string) => createLogger(`${subsystem}/${name}`),
    };
  };
  return { createSubsystemLogger: createLogger };
});

vi.mock("../../agents/sticky-model-selection.js", () => ({
  persistStickyModelSelectionBestEffort: effects.stickyDispatch,
}));

vi.mock("../../sessions/session-lifecycle-admission.js", () => ({
  collectActiveSessionWorkAdmissionIdentities: () => new Set(),
  runExclusiveSessionLifecycleMutation: async (params: {
    prepare?: () => Promise<void>;
    run: () => Promise<unknown>;
    finalize?: () => Promise<void>;
  }) => {
    await params.prepare?.();
    try {
      return await params.run();
    } finally {
      await params.finalize?.();
    }
  },
}));

vi.mock("../../plugins/host-hook-state.js", () => ({
  patchPluginSessionExtension: () => {
    effects.unexpectedCalls.push("patchPluginSessionExtension");
  },
}));

vi.mock("../../plugins/host-hooks.js", () => ({
  isPluginJsonValue: () => {
    effects.unexpectedCalls.push("isPluginJsonValue");
    return false;
  },
}));

vi.mock("../../cron/job-session-bindings.js", () => ({
  disableCronJobsBoundToSessions: () => {
    effects.unexpectedCalls.push("disableCronJobsBoundToSessions");
    return new Map();
  },
}));

vi.mock("../session-groups.js", () => ({
  ensureSessionGroupRegistered: () => {
    effects.unexpectedCalls.push("ensureSessionGroupRegistered");
  },
}));

vi.mock("../session-patch-hooks.js", () => ({
  triggerSessionPatchHook: () => {},
}));

vi.mock("./session-audit.js", () => ({
  appendSessionAudit: () => {
    effects.unexpectedCalls.push("appendSessionAudit");
  },
}));

vi.mock("./session-change-event.js", () => ({
  emitSessionsChanged: () => {},
}));

vi.mock("./sessions-patch-archive.js", () => ({
  prepareSessionPatchArchive: () => {
    effects.unexpectedCalls.push("prepareSessionPatchArchive");
  },
  validateSessionPatchArchiveProjection: () => {
    effects.unexpectedCalls.push("validateSessionPatchArchiveProjection");
  },
}));

vi.mock("./sessions-shared.js", () => ({
  loadSessionsRuntimeModule: () => {
    effects.unexpectedCalls.push("loadSessionsRuntimeModule");
    return {};
  },
  requireSessionKey: (key: unknown) => {
    const normalized = typeof key === "string" ? key.trim() : "";
    if (!normalized) {
      effects.unexpectedCalls.push("requireSessionKey:invalid");
      return null;
    }
    return normalized;
  },
  resolveSessionWorkerPlacementPatchError: () => undefined,
  sessionLog: {
    info: () => effects.unexpectedCalls.push("sessionLog.info"),
    warn: () => effects.unexpectedCalls.push("sessionLog.warn"),
  },
}));

import { sessionMutationHandlers } from "./sessions-mutations.js";

const cfg = {
  agents: {
    defaults: { model: "anthropic/claude-opus-4-6" },
    list: [
      { id: "main", default: true },
      { id: "work", model: "anthropic/claude-sonnet-4-6" },
    ],
  },
} satisfies OpenClawConfig;

let openClawTestState: OpenClawTestState;

function context(): GatewayRequestContext {
  return {
    getRuntimeConfig: () => cfg,
    loadGatewayModelCatalog: vi.fn(async () => [
      { provider: "anthropic", id: "claude-opus-4-6" },
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "openai", id: "gpt-5.6-sol" },
    ]),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map(),
  } as unknown as GatewayRequestContext;
}

function client(scopes: string[]): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes,
    },
  };
}

async function patchSession(params: Record<string, unknown>, scopes = ["operator.admin"]) {
  const responses: Parameters<RespondFn>[] = [];
  await sessionMutationHandlers["sessions.patch"]?.({
    params,
    client: client(scopes),
    context: context(),
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  expect(responses).toHaveLength(1);
  return responses[0]!;
}

beforeAll(async () => {
  openClawTestState = await createOpenClawTestState({ scenario: "minimal" });
});

beforeEach(() => {
  effects.stickyDispatch.mockClear();
  effects.unexpectedCalls.length = 0;
});

afterEach(() => {
  expect(effects.unexpectedCalls).toEqual([]);
});

afterAll(async () => {
  closeOpenClawAgentDatabasesForTest();
  await openClawTestState.cleanup();
});

describe("sessions.patch sticky model persistence", () => {
  it.each([
    { agentId: "main", sessionKey: "agent:main:dm:sticky" },
    { agentId: "work", sessionKey: "agent:work:dm:sticky" },
  ])(
    "persists an accepted model for the resolved $agentId agent",
    async ({ agentId, sessionKey }) => {
      await upsertSessionEntryCore(
        { agentId, sessionKey },
        { sessionId: `session-${agentId}`, updatedAt: 1 },
      );

      const response = await patchSession({ key: sessionKey, model: "openai/gpt-5.6-sol" });

      expect(response[0]).toBe(true);
      expect(effects.stickyDispatch).toHaveBeenCalledExactlyOnceWith({
        agentId,
        model: "openai/gpt-5.6-sol",
      });
    },
  );

  it("keeps a write-scoped model switch session-only without persisting the configured default", async () => {
    const sessionKey = "agent:main:dm:non-admin";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "session-non-admin", updatedAt: 1 },
    );

    const response = await patchSession({ key: sessionKey, model: "openai/gpt-5.6-sol" }, [
      "operator.write",
    ]);

    expect(response[0]).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
    });
    expect(effects.stickyDispatch).not.toHaveBeenCalled();
  });

  it.each([
    { name: "omitted", patch: { label: "Sticky" } },
    { name: "reset to the current default", patch: { model: "anthropic/claude-opus-4-6" } },
  ])("does not persist when model is $name", async ({ name, patch }) => {
    const sessionKey = `agent:main:dm:no-sticky-${name}`;
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: `session-${name}`,
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        modelOverrideSource: "user",
        modelOverrideRouteResolution: "resolved",
      },
    );

    const response = await patchSession({ key: sessionKey, ...patch });

    expect(response[0]).toBe(true);
    expect(effects.stickyDispatch).not.toHaveBeenCalled();
  });
});
