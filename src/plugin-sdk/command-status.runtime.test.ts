/**
 * Tests command status runtime lazy loading and direct status reply behavior.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as modelSelectionConfig from "../agents/model-selection-config.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";

const buildStatusReply = vi.fn(async (params: unknown) => params);
const loadSessionEntry = vi.fn();
const resolveSessionAgentId = vi.fn();
const listAgentEntries = vi.fn();
const resolveDefaultModelForAgent = vi.spyOn(modelSelectionConfig, "resolveDefaultModelForAgent");
let statusConfig: OpenClawConfig = {};
const resolveDefaultModel = vi.fn();
const createModelSelectionState = vi.fn();
const resolveCurrentDirectiveLevels = vi.fn();

vi.mock("../auto-reply/reply/commands-status.js", () => ({
  buildStatusReply,
}));

vi.mock("../gateway/session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: loadSessionEntry,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentEntries,
  resolveSessionAgentId,
}));

vi.mock("../auto-reply/reply/directive-handling.defaults.js", () => ({
  resolveDefaultModel,
}));

vi.mock("../auto-reply/reply/model-selection.js", () => ({
  createModelSelectionState,
}));

vi.mock("../auto-reply/reply/directive-handling.levels.js", () => ({
  resolveCurrentDirectiveLevels,
}));

const { resolveDirectStatusReplyForSessionCore } = await import("./command-status.runtime.js");

afterAll(() => resolveDefaultModelForAgent.mockRestore());

function resolveStatus(
  params: Parameters<typeof resolveDirectStatusReplyForSessionCore>[0],
  metadataSnapshot = createPluginMetadataSnapshot({
    config: statusConfig,
    manifestRegistry: { plugins: [], diagnostics: [] },
  }),
) {
  // The mocked Gateway read still belongs to one complete metadata generation.
  return withPluginRuntimeGenerationScope({ config: statusConfig, metadataSnapshot }, () =>
    resolveDirectStatusReplyForSessionCore(params),
  );
}

function expectResolvedReasoningLevel(value: unknown, expected: string) {
  expect((value as { resolvedReasoningLevel?: unknown }).resolvedReasoningLevel).toBe(expected);
}

function requireBuildStatusReplyParams(index = 0): unknown {
  const call = buildStatusReply.mock.calls[index];
  if (!call) {
    throw new Error(`expected buildStatusReply call ${index}`);
  }
  return call[0];
}

describe("resolveDirectStatusReplyForSessionCore", () => {
  beforeEach(() => {
    buildStatusReply.mockReset();
    loadSessionEntry.mockReset();
    resolveSessionAgentId.mockReset();
    listAgentEntries.mockReset();
    resolveDefaultModelForAgent.mockReset();
    resolveDefaultModel.mockReset();
    createModelSelectionState.mockReset();
    resolveCurrentDirectiveLevels.mockReset();

    buildStatusReply.mockImplementation(async (params: unknown) => params);
    statusConfig = {
      agents: { defaults: { reasoningDefault: "off" } },
    };
    loadSessionEntry.mockReturnValue({
      cfg: statusConfig,
      canonicalKey: "main",
      entry: {
        sessionId: "sess-main",
      },
      store: {},
      storePath: "/tmp/sessions.json",
    });
    resolveSessionAgentId.mockReturnValue("main");
    listAgentEntries.mockReturnValue([]);
    resolveDefaultModelForAgent.mockReturnValue({ provider: "openai", model: "gpt-5.4" });
    resolveDefaultModel.mockReturnValue({ defaultProvider: "openai", defaultModel: "gpt-5.4" });
    createModelSelectionState.mockResolvedValue({
      resolveThinkingCatalog: vi.fn(async () => []),
      resolveDefaultThinkingLevel: vi.fn(async () => "off"),
      resolveDefaultReasoningLevel: vi.fn(async () => "on"),
    });
    resolveCurrentDirectiveLevels.mockResolvedValue({
      currentThinkLevel: "off",
      currentFastMode: false,
      currentVerboseLevel: "off",
      currentReasoningLevel: "off",
      currentElevatedLevel: "off",
    });
  });

  it("prepares the canonical persisted override ahead of runtime and default status models", async () => {
    const registry = makeRegistry([
      { id: "status-models", channels: [], providers: ["fixture-provider"] },
    ]);
    for (const plugin of registry.plugins) {
      plugin.modelIdNormalization = {
        providers: { "fixture-provider": { aliases: { "legacy-status": "selected-status" } } },
      };
    }
    const metadataSnapshot = createPluginMetadataSnapshot({
      config: statusConfig,
      manifestRegistry: registry,
    });
    loadSessionEntry.mockReturnValue({
      cfg: statusConfig,
      canonicalKey: "main",
      entry: {
        sessionId: "sess-main",
        updatedAt: 1,
        providerOverride: "fixture-provider",
        modelOverride: "legacy-status",
        modelProvider: "previous-provider",
        model: "previous-model",
      },
      store: {},
      storePath: "/tmp/sessions.json",
    });

    const result = await resolveStatus(
      {
        cfg: {},
        sessionKey: "main",
        channel: "cli",
        senderIsOwner: true,
        isAuthorizedSender: true,
        isGroup: false,
        defaultGroupActivation: () => "always",
      },
      metadataSnapshot,
    );

    expect(result).toMatchObject({ provider: "fixture-provider", model: "selected-status" });
    expect(createModelSelectionState).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedInitialModel: { provider: "fixture-provider", model: "selected-status" },
        preparedPrimaryModel: { provider: "openai", model: "gpt-5.4" },
      }),
    );
  });

  it("treats agentCfg reasoningDefault as explicit for direct /status", async () => {
    const result = await resolveStatus({
      cfg: {},
      sessionKey: "main",
      channel: "cli",
      senderIsOwner: true,
      isAuthorizedSender: true,
      isGroup: false,
      defaultGroupActivation: () => "always",
    });

    expect(buildStatusReply).toHaveBeenCalledOnce();
    expectResolvedReasoningLevel(requireBuildStatusReplyParams(), "off");
    expectResolvedReasoningLevel(result, "off");
  });

  it("allows configured reasoning defaults for authorized direct /status senders", async () => {
    statusConfig = {
      agents: { defaults: { reasoningDefault: "stream" } },
    };
    loadSessionEntry.mockReturnValue({
      cfg: statusConfig,
      canonicalKey: "main",
      entry: {
        sessionId: "sess-main",
      },
      store: {},
      storePath: "/tmp/sessions.json",
    });
    resolveCurrentDirectiveLevels.mockResolvedValueOnce({
      currentThinkLevel: "off",
      currentFastMode: false,
      currentVerboseLevel: "off",
      currentReasoningLevel: "stream",
      currentElevatedLevel: "off",
    });

    const result = await resolveStatus({
      cfg: {},
      sessionKey: "main",
      channel: "cli",
      senderIsOwner: false,
      isAuthorizedSender: true,
      isGroup: false,
      defaultGroupActivation: () => "always",
    });

    expectResolvedReasoningLevel(result, "stream");
  });

  it("hides configured reasoning defaults from unauthorized direct /status senders", async () => {
    statusConfig = {
      agents: { defaults: { reasoningDefault: "stream" } },
    };
    loadSessionEntry.mockReturnValue({
      cfg: statusConfig,
      canonicalKey: "main",
      entry: {
        sessionId: "sess-main",
      },
      store: {},
      storePath: "/tmp/sessions.json",
    });
    resolveCurrentDirectiveLevels.mockResolvedValueOnce({
      currentThinkLevel: "off",
      currentFastMode: false,
      currentVerboseLevel: "off",
      currentReasoningLevel: "stream",
      currentElevatedLevel: "off",
    });

    const result = await resolveStatus({
      cfg: {},
      sessionKey: "main",
      channel: "cli",
      senderIsOwner: false,
      isAuthorizedSender: false,
      isGroup: false,
      defaultGroupActivation: () => "always",
    });

    expectResolvedReasoningLevel(result, "off");
  });

  it("hides session reasoning state from unauthorized direct /status senders", async () => {
    statusConfig = {};
    loadSessionEntry.mockReturnValue({
      cfg: statusConfig,
      canonicalKey: "main",
      entry: {
        sessionId: "sess-main",
        reasoningLevel: "stream",
      },
      store: {},
      storePath: "/tmp/sessions.json",
    });
    resolveCurrentDirectiveLevels.mockResolvedValueOnce({
      currentThinkLevel: "off",
      currentFastMode: false,
      currentVerboseLevel: "off",
      currentReasoningLevel: "stream",
      currentElevatedLevel: "off",
    });

    const result = await resolveStatus({
      cfg: {},
      sessionKey: "main",
      channel: "cli",
      senderIsOwner: false,
      isAuthorizedSender: false,
      isGroup: false,
      defaultGroupActivation: () => "always",
    });

    expectResolvedReasoningLevel(result, "off");
  });

  it("allows session reasoning state for authorized direct /status senders", async () => {
    statusConfig = {};
    loadSessionEntry.mockReturnValue({
      cfg: statusConfig,
      canonicalKey: "main",
      entry: {
        sessionId: "sess-main",
        reasoningLevel: "stream",
      },
      store: {},
      storePath: "/tmp/sessions.json",
    });
    resolveCurrentDirectiveLevels.mockResolvedValueOnce({
      currentThinkLevel: "off",
      currentFastMode: false,
      currentVerboseLevel: "off",
      currentReasoningLevel: "stream",
      currentElevatedLevel: "off",
    });

    const result = await resolveStatus({
      cfg: {},
      sessionKey: "main",
      channel: "cli",
      senderIsOwner: false,
      isAuthorizedSender: true,
      isGroup: false,
      defaultGroupActivation: () => "always",
    });

    expectResolvedReasoningLevel(result, "stream");
  });
});
