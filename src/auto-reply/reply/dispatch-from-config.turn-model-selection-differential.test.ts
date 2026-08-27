import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
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
  resolveVisibleRepliesPolicy({
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
    resolveVisibleRepliesPolicy({
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
