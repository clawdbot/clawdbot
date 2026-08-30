import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import {
  TURN_MODEL_DEFAULT_REF,
  TURN_MODEL_DIFFERENTIAL_FIXTURES,
  TURN_MODEL_OVERRIDE_REF,
  turnModelRefLabel,
  turnModelVerdict,
  type TurnModelDifferentialFixture,
  type TurnModelSelectionVerdict,
} from "../../test-utils/turn-model-selection-differential.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { buildTestCtx } from "./test-ctx.js";

const selectAgentHarnessMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/harness/selection.js", () => ({
  selectAgentHarness: (...args: unknown[]) => selectAgentHarnessMock(...args),
}));

const { resolveVisibleRepliesPolicy } = await import("./dispatch-from-config.harness-defaults.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const recorderHarness = {
  id: "turn-model-recorder",
  label: "Turn model recorder",
  deliveryDefaults: { visibleReplies: "automatic" },
  supports: () => ({ supported: true as const, priority: 1 }),
  runAttempt: vi.fn(async () => ({}) as never),
} satisfies AgentHarness;

function createConfig(
  storePath: string,
  modelByChannel: TurnModelDifferentialFixture["modelByChannel"],
): OpenClawConfig {
  return {
    session: { store: storePath },
    agents: { defaults: { model: { primary: turnModelRefLabel(TURN_MODEL_DEFAULT_REF) } } },
    channels: modelByChannel ? { modelByChannel } : undefined,
  } as OpenClawConfig;
}

// Routing is the subject here; the harness is a recorder, not a provider runtime.
// Its complete generation prevents unrelated provider activation on a registry miss.
function resolveRoutingVisibleRepliesPolicy(
  params: Parameters<typeof resolveVisibleRepliesPolicy>[0],
) {
  return withPluginRuntimeGenerationScope(
    {
      config: params.cfg,
      metadataSnapshot: createPluginMetadataSnapshot({
        config: params.cfg,
        manifestRegistry: makeRegistry([]),
      }),
      pluginRegistry: createSessionConversationTestRegistry(),
    },
    () => resolveVisibleRepliesPolicy(params),
  );
}

function observeHarnessSelection(fixture: TurnModelDifferentialFixture): TurnModelSelectionVerdict {
  const storePath = path.join(tempDirs.make("turn-model-harness-"), "sessions.json");
  const sessionKey = "agent:main:telegram:group:selection";
  replaceSessionEntrySync({ agentId: "main", storePath, sessionKey }, fixture.child);
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: fixture.child };
  if (fixture.parent) {
    replaceSessionEntrySync(
      { agentId: "main", storePath, sessionKey: fixture.parent.key },
      fixture.parent.entry,
    );
    sessionStore[fixture.parent.key] = fixture.parent.entry;
  }

  selectAgentHarnessMock.mockClear();
  resolveRoutingVisibleRepliesPolicy({
    cfg: createConfig(storePath, fixture.modelByChannel),
    // Visible-reply defaults are queried only for direct delivery. The stored
    // chat type still drives the real channel matcher for group fixtures.
    chatType: "direct",
    ctx: buildTestCtx({ SessionKey: sessionKey, ...fixture.ctx }),
    entry: fixture.child,
    sessionAgentId: "main",
    sessionKey,
    sessionStore,
    turnModelOverride: fixture.heartbeat ? turnModelRefLabel(TURN_MODEL_OVERRIDE_REF) : undefined,
  });
  const call = selectAgentHarnessMock.mock.calls.at(-1)?.[0] as
    | { provider: string; modelId?: string }
    | undefined;
  if (!call?.modelId) {
    throw new Error(`harness path did not select a model for ${fixture.name}`);
  }
  return turnModelVerdict(
    { provider: call.provider, model: call.modelId },
    fixture.locked ? "locked" : undefined,
  );
}

describe("turn model selection harness-path differential", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createSessionConversationTestRegistry());
    selectAgentHarnessMock.mockImplementation(() => recorderHarness);
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it.each(TURN_MODEL_DIFFERENTIAL_FIXTURES)("pins observed $name behavior", (fixture) => {
    expect(observeHarnessSelection(fixture)).toEqual(fixture.expected.harness);
  });

  it.each([
    { mode: "turn", selectedProvider: "selected-provider" },
    { mode: "stored", selectedProvider: "stored-provider" },
    { mode: "channel", selectedProvider: "channel-provider" },
    { mode: "source", selectedProvider: undefined },
    { mode: "default", selectedProvider: "default-provider" },
    { mode: "selected-without-default", selectedProvider: "selected-provider" },
    { mode: "literal-turn", selectedProvider: undefined },
  ] as const)("prepares only the $mode visible-reply operand", ({ mode, selectedProvider }) => {
    const hasTurn =
      mode === "turn" || mode === "selected-without-default" || mode === "literal-turn";
    const hasStored = mode === "turn" || mode === "stored" || mode === "selected-without-default";
    const hasChannel = hasTurn || mode === "stored" || mode === "channel";
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: "default-provider/legacy",
          models: {
            "selected-provider/legacy": { alias: "chosen" },
            "unused-provider/ignored": { alias: "unused" },
          },
        },
        entries: { main: { workspace: "/workspace/harness-selection" } },
      },
      ...(hasChannel
        ? { channels: { modelByChannel: { telegram: { "*": "channel-provider/legacy" } } } }
        : {}),
      ...(mode === "literal-turn"
        ? {
            models: {
              providers: {
                literal: {
                  baseUrl: "https://literal.example/v1",
                  models: [
                    {
                      id: "literal/model",
                      name: "Literal model",
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      maxTokens: 1024,
                    },
                  ],
                },
              },
            },
          }
        : {}),
    };
    const manifestRegistry = makeRegistry(
      [
        "default-provider",
        "selected-provider",
        "stored-provider",
        "channel-provider",
        "unused-provider",
        "literal",
      ].map((id) => ({ id, channels: [], providers: [id] })),
    );
    const metadataSnapshot = createPluginMetadataSnapshot({
      config: cfg,
      workspaceDir: "/workspace/harness-selection",
      manifestRegistry,
    });
    const pluginRegistry = createSessionConversationTestRegistry();
    // Every candidate hook is registered; authoritative absence cannot hide unused work.
    const normalizedModels: string[] = [];
    for (const manifest of manifestRegistry.plugins) {
      pluginRegistry.plugins.push(
        createPluginRecord({
          id: manifest.id,
          source: manifest.source,
          rootDir: manifest.rootDir,
          origin: manifest.origin,
          providerIds: manifest.providers,
        }),
      );
      pluginRegistry.providers.push({
        pluginId: manifest.id,
        source: manifest.source,
        rootDir: manifest.rootDir,
        provider: {
          id: manifest.id,
          label: manifest.id,
          auth: [],
          normalizeModelId({ modelId }) {
            normalizedModels.push(`${manifest.id}/${modelId}`);
            if (manifest.id !== selectedProvider) {
              throw new Error(`Unused model normalization reached ${manifest.id}`);
            }
            return modelId === "legacy" ? "canonical" : `replayed-${modelId}`;
          },
        },
      });
    }
    selectAgentHarnessMock.mockClear();
    selectAgentHarnessMock.mockImplementation(({ provider }: { provider: string }) => ({
      ...recorderHarness,
      deliveryDefaults:
        mode === "selected-without-default" || (provider === "source-provider" && mode !== "source")
          ? undefined
          : mode === "source"
            ? { sourceVisibleReplies: "message_tool" }
            : recorderHarness.deliveryDefaults,
    }));

    const result = withPluginRuntimeGenerationScope(
      { config: cfg, metadataSnapshot, pluginRegistry },
      () =>
        resolveVisibleRepliesPolicy({
          cfg,
          chatType: "direct",
          ctx: buildTestCtx({ Provider: "source-provider", Surface: "source-provider" }),
          entry: {
            sessionId: "harness-selection",
            updatedAt: 1,
            delivery: normalizeSessionDeliveryState({
              context: { channel: "telegram" },
              origin: { provider: "source-provider" },
            }),
            ...(hasStored ? { providerOverride: "stored-provider", modelOverride: "legacy" } : {}),
          },
          sessionAgentId: "main",
          turnModelOverride: hasTurn
            ? mode === "literal-turn"
              ? "literal/literal/model"
              : "chosen"
            : undefined,
        }),
    );

    expect(result.harnessDefaultVisibleReplies).toBe(
      mode === "selected-without-default"
        ? undefined
        : mode === "source"
          ? "message_tool"
          : "automatic",
    );
    expect(normalizedModels).toEqual(selectedProvider ? [`${selectedProvider}/legacy`] : []);
    expect(
      selectAgentHarnessMock.mock.calls.map(([input]) => ({
        provider: input.provider,
        model: input.modelId,
      })),
    ).toEqual(
      mode === "source"
        ? [{ provider: "source-provider", model: undefined }]
        : mode === "default"
          ? [
              { provider: "source-provider", model: undefined },
              { provider: "default-provider", model: "canonical" },
            ]
          : [
              {
                provider: mode === "literal-turn" ? "literal" : selectedProvider,
                model: mode === "literal-turn" ? "literal/model" : "canonical",
              },
            ],
    );
  });

  it("resolves turn aliases in the session agent scope", () => {
    const sessionKey = "agent:worker:telegram:group:selection";
    const cfg = {
      agents: {
        defaults: {
          model: "openai/global-model",
          models: {
            "openai/global-model": { alias: "fast" },
          },
        },
        entries: {
          worker: {
            models: {
              "anthropic/worker-model": { alias: "fast" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    selectAgentHarnessMock.mockClear();
    resolveRoutingVisibleRepliesPolicy({
      cfg,
      chatType: "direct",
      ctx: buildTestCtx({ SessionKey: sessionKey }),
      entry: { sessionId: "worker-session", updatedAt: Date.now() },
      sessionAgentId: "worker",
      sessionKey,
      turnModelOverride: "fast",
    });

    expect(selectAgentHarnessMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        modelId: "worker-model",
        agentId: "worker",
      }),
    );
  });
});
