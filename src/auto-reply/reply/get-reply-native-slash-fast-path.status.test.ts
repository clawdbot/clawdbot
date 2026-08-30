import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createModelManifestPluginContext } from "../../agents/model-selection-shared.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import * as providerModelNormalizationRuntime from "../../agents/provider-model-normalization.runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { resolveDefaultModel } from "./directive-handling.defaults.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

type NativeStatusSelectionCase = {
  selection: string;
  source: "user" | "auto" | undefined;
  channelModel?: string;
  deliveryChannel?: string;
  directSenderId?: string;
  directUserId?: string;
  expectedModel?: string;
  expectedProvider?: string;
  groupId?: string;
  locked?: boolean;
  modelParentSessionKey?: string;
  preparedModel?: string;
  preparedProvider?: string;
};

const buildStatusReplyMock = vi.hoisted(() => vi.fn());

vi.mock("./commands-status.js", () => ({
  buildStatusReply: (...args: unknown[]) => buildStatusReplyMock(...args),
}));

const { maybeResolveNativeSlashCommandFastReply } =
  await import("./get-reply-native-slash-fast-path.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const createTypingController = (): TypingController => ({
  onReplyStart: async () => {},
  startTypingLoop: async () => {},
  startTypingOnText: async () => {},
  refreshTypingTtl: () => {},
  isActive: () => false,
  markRunComplete: () => {},
  markDispatchIdle: () => {},
  cleanup: vi.fn(),
});

describe("native /status channel model routing", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createSessionConversationTestRegistry());
    vi.spyOn(preparedModelCatalog, "loadPreparedModelCatalog").mockResolvedValue([
      {
        id: "gpt-5.5",
        name: "GPT",
        provider: "openai",
        contextWindow: 400_000,
        reasoning: false,
      },
      {
        id: "claude-fable-5",
        name: "Fable",
        provider: "anthropic",
        contextWindow: 1_000_000,
        reasoning: true,
      },
    ]);
    buildStatusReplyMock.mockReset();
    buildStatusReplyMock.mockResolvedValue({ text: "selected model status" });
  });

  const statusSelectionCases: NativeStatusSelectionCase[] = [
    { selection: "user override", source: "user" },
    { selection: "automatic fallback", source: "auto" },
    {
      selection: "channel override",
      source: undefined,
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "configured channel model alias",
      source: undefined,
      channelModel: "Fable",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "current command channel over stale session delivery",
      source: undefined,
      deliveryChannel: "discord",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "parent group override for a topic",
      source: undefined,
      groupId: "123:topic:77",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "thread-only model parent session override",
      source: undefined,
      groupId: "unmatched-thread",
      modelParentSessionKey: "agent:main:telegram:group:123:thread:77",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "native direct peer override before wildcard",
      source: undefined,
      directUserId: "native-peer-42",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "current direct sender override before wildcard",
      source: undefined,
      directSenderId: "live-peer-43",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "current direct sender over another channel's persisted peer",
      source: undefined,
      deliveryChannel: "discord",
      directUserId: "stale-discord-peer",
      directSenderId: "live-telegram-peer",
      expectedProvider: "anthropic",
      expectedModel: "claude-fable-5",
    },
    {
      selection: "locked model selection",
      source: undefined,
      locked: true,
    },
    {
      selection: "prepared non-default heartbeat or fallback model",
      source: undefined,
      preparedProvider: "xai",
      preparedModel: "grok-4.3",
      expectedProvider: "xai",
      expectedModel: "grok-4.3",
    },
  ];

  it.each(statusSelectionCases)(
    "preserves canonical native /status $selection",
    async (testCase) => {
      const targetSessionKey = "agent:main:main";
      const workspaceDir = tempDirs.make("openclaw-native-status-");
      const storePath = path.join(workspaceDir, "sessions.json");
      const {
        channelModel = "anthropic/claude-fable-5",
        deliveryChannel = "telegram",
        directSenderId,
        directUserId,
        expectedModel = "gpt-5.5",
        expectedProvider = "openai",
        groupId = "123",
        locked = false,
        modelParentSessionKey,
        preparedModel = "gpt-5.5",
        preparedProvider = "openai",
        source,
      } = testCase;
      const isDirect = directUserId !== undefined || directSenderId !== undefined;
      const overrideKey = directSenderId ?? directUserId ?? "123";
      const conflictingDirectUserId =
        directSenderId !== undefined && directUserId !== undefined ? directUserId : undefined;
      const cfg = markCompleteReplyConfig({
        session: { store: storePath },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            modelPolicy: { allow: ["openai/*", "anthropic/*", "xai/*"] },
            models: {
              "anthropic/claude-fable-5": {
                alias: "Fable",
                params: { thinking: "high", fastMode: true },
              },
            },
          },
          entries: { main: { workspace: workspaceDir } },
        },
        channels: {
          modelByChannel: {
            telegram: {
              [overrideKey]: channelModel,
              ...(conflictingDirectUserId ? { [conflictingDirectUserId]: "xai/grok-4.3" } : {}),
              "*": "openai/gpt-5.5",
            },
            discord: { "123": "openai/gpt-5.5" },
          },
        },
      } as OpenClawConfig);
      const snapshot = createPluginMetadataSnapshot({
        config: cfg,
        workspaceDir,
        manifestRegistry: makeRegistry([]),
      });

      await withPluginRuntimeGenerationScope(
        {
          config: cfg,
          metadataSnapshot: snapshot,
          pluginRegistry: createSessionConversationTestRegistry(),
        },
        async () => {
          const manifestPluginContext = createModelManifestPluginContext({
            cfg,
            agentId: "main",
            workspaceDir,
            pluginMetadataSnapshot: snapshot,
          });
          await replaceSessionEntry(
            { agentId: "main", sessionKey: targetSessionKey, storePath },
            {
              sessionId: "status-session",
              updatedAt: Date.now(),
              contextTokens: 1_000_000,
              delivery: normalizeSessionDeliveryState({
                context: { channel: deliveryChannel },
                ...(directUserId
                  ? { origin: { provider: deliveryChannel, nativeDirectUserId: directUserId } }
                  : {}),
              }),
              ...(isDirect ? {} : { groupId }),
              ...(locked ? { modelSelectionLocked: true } : {}),
              ...(source
                ? {
                    providerOverride: "anthropic",
                    modelOverride: "claude-fable-5",
                    modelOverrideSource: source,
                    ...(source === "auto"
                      ? {
                          modelOverrideFallbackOriginProvider: "openai",
                          modelOverrideFallbackOriginModel: "gpt-5.5",
                          modelProvider: "openai",
                          model: "gpt-5.5",
                        }
                      : {}),
                  }
                : {}),
            },
          );

          const result = await maybeResolveNativeSlashCommandFastReply({
            ctx: buildTestCtx({
              Body: "/status",
              CommandBody: "/status",
              CommandSource: "native",
              CommandAuthorized: true,
              Provider: "telegram",
              Surface: "telegram",
              ChatType: isDirect ? "direct" : "group",
              ...(directSenderId
                ? { From: `telegram:${directSenderId}`, SenderId: directSenderId }
                : {}),
              ...(modelParentSessionKey ? { ModelParentSessionKey: modelParentSessionKey } : {}),
              SessionKey: "telegram:slash:123",
              CommandTargetSessionKey: targetSessionKey,
              CommandTurn: {
                kind: "native",
                source: "native",
                authorized: true,
                commandName: "status",
                body: "/status",
              },
            }),
            cfg,
            agentId: "main",
            agentDir: path.join(workspaceDir, "agent"),
            agentCfg: undefined,
            commandAuthorized: true,
            defaultProvider: "openai",
            defaultModel: "gpt-5.5",
            aliasIndex: {
              byKey: new Map(),
              byAlias: new Map([
                [
                  "fable",
                  { alias: "Fable", ref: { provider: "anthropic", model: "claude-fable-5" } },
                ],
              ]),
            },
            preparedDefaultModel: { provider: "openai", model: "gpt-5.5" },
            preparedInitialModel: { provider: preparedProvider, model: preparedModel },
            preparedPrimaryModel: { provider: "openai", model: "gpt-5.5" },
            provider: preparedProvider,
            model: preparedModel,
            workspaceDir,
            manifestPluginContext,
            typing: createTypingController(),
          });

          const statusCall = buildStatusReplyMock.mock.calls[0]?.[0];
          expect(statusCall).toMatchObject({ provider: expectedProvider, model: expectedModel });
          if (expectedProvider === "anthropic") {
            await expect(statusCall.resolveDefaultThinkingLevel()).resolves.toBe("high");
          }
          if (source) {
            expect(statusCall.sessionEntry).toMatchObject({
              providerOverride: "anthropic",
              modelOverride: "claude-fable-5",
              modelOverrideSource: source,
            });
          } else {
            expect(statusCall.sessionEntry).not.toHaveProperty("providerOverride");
            expect(statusCall.sessionEntry).not.toHaveProperty("modelOverride");
          }
          expect(result).toMatchObject({ reply: { text: "selected model status" } });
        },
      );
    },
  );

  it.each([
    {
      selection: "raw inherited pin",
      parentModel: "legacy-pin",
      resolved: false,
      channelModel: undefined,
      expectedModel: "captured-pin",
      normalizedInputs: ["legacy-pin"],
    },
    {
      selection: "resolved inherited pin",
      parentModel: "captured-pin",
      resolved: true,
      channelModel: undefined,
      expectedModel: "captured-pin",
      normalizedInputs: [],
    },
    {
      selection: "raw inherited configured alias",
      parentModel: "fast",
      resolved: false,
      channelModel: undefined,
      expectedModel: "alias-target",
      normalizedInputs: ["fast"],
    },
    {
      selection: "resolved alias-like inherited pin",
      parentModel: "fast",
      resolved: true,
      channelModel: undefined,
      expectedModel: "fast",
      normalizedInputs: [],
    },
    {
      selection: "raw channel ref with captured context",
      parentModel: undefined,
      resolved: false,
      channelModel: "fixture/legacy-pin",
      expectedModel: "captured-pin",
      normalizedInputs: ["legacy-pin"],
    },
    {
      selection: "agent-configured channel alias with captured context",
      parentModel: undefined,
      resolved: false,
      channelModel: "fast",
      expectedModel: "captured-alias",
      normalizedInputs: ["alias-target"],
    },
    {
      selection: "static default without a selected override",
      parentModel: undefined,
      resolved: false,
      channelModel: undefined,
      expectedModel: "default",
      normalizedInputs: [],
    },
  ])("preserves native status preparation for $selection", async (testCase) => {
    const workspaceDir = tempDirs.make("native-status-prepared-");
    const storePath = path.join(workspaceDir, "sessions.json");
    const targetSessionKey = "agent:main:telegram:group:child";
    const parentSessionKey = "agent:main:telegram:group:parent";
    const cfg = markCompleteReplyConfig<OpenClawConfig>({
      session: { store: storePath },
      agents: {
        defaults: {
          model: "fixture/default",
          models: { "unrelated-provider/unused": { alias: "unused" } },
        },
        entries: {
          main: {
            workspace: workspaceDir,
            models: { "fixture/alias-target": { alias: "fast" } },
          },
        },
      },
      channels: testCase.channelModel
        ? { modelByChannel: { telegram: { "*": testCase.channelModel } } }
        : undefined,
    });
    const snapshot = createPluginMetadataSnapshot({
      config: cfg,
      workspaceDir,
      manifestRegistry: makeRegistry([{ id: "fixture", channels: [], providers: ["fixture"] }]),
    });
    const normalize = vi
      .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
      .mockImplementation(
        ({ provider, context, config, workspaceDir: hookWorkspace, pluginMetadataSnapshot }) => {
          if (provider !== "fixture") {
            throw new Error("Unselected provider normalization must remain dormant");
          }
          if (context.modelId === "captured-pin") {
            return "replayed-pin";
          }
          if (context.modelId === "legacy-pin" || context.modelId === "alias-target") {
            return config === cfg &&
              hookWorkspace === workspaceDir &&
              pluginMetadataSnapshot === snapshot
              ? context.modelId === "legacy-pin"
                ? "captured-pin"
                : "captured-alias"
              : "ambient-model";
          }
          return undefined;
        },
      );
    const prepareDefaultModel = vi.fn(() => ({ provider: "fixture", model: "executed-default" }));

    await withPluginRuntimeGenerationScope(
      {
        config: cfg,
        metadataSnapshot: snapshot,
        pluginRegistry: createSessionConversationTestRegistry(),
      },
      async () => {
        const manifestPluginContext = createModelManifestPluginContext({
          cfg,
          agentId: "main",
          workspaceDir,
          pluginMetadataSnapshot: snapshot,
        });
        const defaults = resolveDefaultModel({ cfg, agentId: "main" });
        await replaceSessionEntry(
          { agentId: "main", sessionKey: targetSessionKey, storePath },
          {
            sessionId: "status-child",
            updatedAt: 1,
            groupId: "child",
            ...(testCase.parentModel ? { parentSessionKey } : {}),
          },
        );
        if (testCase.parentModel) {
          await replaceSessionEntry(
            { agentId: "main", sessionKey: parentSessionKey, storePath },
            {
              sessionId: "status-parent",
              updatedAt: 1,
              providerOverride: "fixture",
              modelOverride: testCase.parentModel,
              modelOverrideSource: "user",
              ...(testCase.resolved ? { modelOverrideRouteResolution: "resolved" } : {}),
            },
          );
        }
        const result = await maybeResolveNativeSlashCommandFastReply({
          ctx: buildTestCtx({
            Body: "/status",
            CommandBody: "/status",
            CommandSource: "native",
            CommandAuthorized: true,
            Provider: "telegram",
            Surface: "telegram",
            ChatType: "group",
            SessionKey: "telegram:slash:child",
            CommandTargetSessionKey: targetSessionKey,
            CommandTurn: {
              kind: "native",
              source: "native",
              authorized: true,
              commandName: "status",
              body: "/status",
            },
          }),
          cfg,
          agentId: "main",
          agentDir: path.join(workspaceDir, "agent"),
          agentCfg: cfg.agents?.defaults,
          commandAuthorized: true,
          ...defaults,
          manifestPluginContext,
          provider: defaults.defaultProvider,
          model: defaults.defaultModel,
          preparedDefaultModel: prepareDefaultModel,
          preparedInitialModel: prepareDefaultModel,
          preparedPrimaryModel: prepareDefaultModel,
          workspaceDir,
          typing: createTypingController(),
        });

        expect(buildStatusReplyMock.mock.calls[0]?.[0]).toMatchObject({
          provider: "fixture",
          model: testCase.expectedModel,
        });
        expect(normalize.mock.calls.map(([{ context }]) => context.modelId)).toEqual(
          testCase.normalizedInputs,
        );
        expect(prepareDefaultModel).not.toHaveBeenCalled();
        expect(result).toMatchObject({ reply: { text: "selected model status" } });
      },
    );
  });
});
