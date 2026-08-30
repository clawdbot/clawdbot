import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
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
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const buildStatusReplyMock = vi.hoisted(() => vi.fn());

vi.mock("./commands-status.js", () => ({
  buildStatusReply: (...args: unknown[]) => buildStatusReplyMock(...args),
}));

const { maybeResolveNativeSlashCommandFastReply } =
  await import("./get-reply-native-slash-fast-path.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createTypingController(): TypingController {
  return {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };
}

async function seedFixture(
  storePath: string,
  sessionKey: string,
  fixture: TurnModelDifferentialFixture,
): Promise<void> {
  await replaceSessionEntry({ agentId: "main", storePath, sessionKey }, fixture.child);
  if (fixture.parent) {
    await replaceSessionEntry(
      { agentId: "main", storePath, sessionKey: fixture.parent.key },
      fixture.parent.entry,
    );
  }
}

function createConfig(
  storePath: string,
  modelByChannel: TurnModelDifferentialFixture["modelByChannel"],
): OpenClawConfig {
  return markCompleteReplyConfig({
    session: { store: storePath },
    agents: {
      defaults: {
        model: { primary: turnModelRefLabel(TURN_MODEL_DEFAULT_REF) },
        modelPolicy: { allow: ["*/*"] },
      },
    },
    channels: modelByChannel ? { modelByChannel } : undefined,
  } as OpenClawConfig);
}

async function observeStatusSelection(
  fixture: TurnModelDifferentialFixture,
): Promise<TurnModelSelectionVerdict> {
  const storePath = path.join(tempDirs.make("turn-model-status-"), "sessions.json");
  const sessionKey = "agent:main:telegram:group:selection";
  await seedFixture(storePath, sessionKey, fixture);
  const cfg = createConfig(storePath, fixture.modelByChannel);

  buildStatusReplyMock.mockClear();
  buildStatusReplyMock.mockResolvedValue({ text: "status" });
  // Status rendering and catalog loading are stubbed; this routing fixture owns
  // a complete generation so a selected provider miss cannot activate plugins.
  await withPluginRuntimeGenerationScope(
    {
      config: cfg,
      metadataSnapshot: createPluginMetadataSnapshot({
        config: cfg,
        workspaceDir: "/tmp/workspace",
        manifestRegistry: makeRegistry([]),
      }),
      pluginRegistry: createSessionConversationTestRegistry(),
    },
    () =>
      maybeResolveNativeSlashCommandFastReply({
        ctx: buildTestCtx({
          Body: "/status",
          BodyForAgent: "/status",
          RawBody: "/status",
          CommandBody: "/status",
          CommandSource: "native",
          CommandAuthorized: true,
          SessionKey: "telegram:slash:selection",
          CommandTargetSessionKey: sessionKey,
          CommandTurn: {
            kind: "native",
            source: "native",
            authorized: true,
            commandName: "status",
            body: "/status",
          },
          ...fixture.ctx,
        }),
        cfg,
        agentId: "main",
        agentDir: "/tmp/agent",
        agentCfg: undefined,
        commandAuthorized: true,
        defaultProvider: TURN_MODEL_DEFAULT_REF.provider,
        defaultModel: TURN_MODEL_DEFAULT_REF.model,
        aliasIndex: { byAlias: new Map(), byKey: new Map() },
        preparedDefaultModel: TURN_MODEL_DEFAULT_REF,
        preparedInitialModel: fixture.heartbeat ? TURN_MODEL_OVERRIDE_REF : TURN_MODEL_DEFAULT_REF,
        preparedPrimaryModel: TURN_MODEL_DEFAULT_REF,
        provider: fixture.heartbeat
          ? TURN_MODEL_OVERRIDE_REF.provider
          : TURN_MODEL_DEFAULT_REF.provider,
        model: fixture.heartbeat ? TURN_MODEL_OVERRIDE_REF.model : TURN_MODEL_DEFAULT_REF.model,
        workspaceDir: "/tmp/workspace",
        typing: createTypingController(),
      }),
  );

  const call = buildStatusReplyMock.mock.calls[0]?.[0] as
    | { provider: string; model: string; sessionEntry?: SessionEntry }
    | undefined;
  if (!call) {
    throw new Error(`status path did not build a reply for ${fixture.name}`);
  }
  const ref = call.sessionEntry?.modelOverride
    ? {
        provider: call.sessionEntry.providerOverride ?? call.provider,
        model: call.sessionEntry.modelOverride,
      }
    : { provider: call.provider, model: call.model };
  return turnModelVerdict(
    ref,
    fixture.locked ? "locked" : fixture.heartbeat ? "heartbeat" : undefined,
  );
}

describe("turn model selection status-path differential", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createSessionConversationTestRegistry());
    vi.spyOn(preparedModelCatalog, "loadPreparedModelCatalog").mockResolvedValue([]);
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(TURN_MODEL_DIFFERENTIAL_FIXTURES)("pins observed $name behavior", async (fixture) => {
    await expect(observeStatusSelection(fixture)).resolves.toEqual(fixture.expected.status);
  });
});
