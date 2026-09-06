import "./directive-handling.mixed-inline.test-harness.js";
import { describe, expect, it } from "vitest";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../../sessions/model-overrides.js";
import {
  lifecycleEvents,
  persistenceMocks,
} from "./directive-handling.mixed-inline.test-harness.js";
import {
  applyMixedDirectives,
  createSessionEntry,
} from "./directive-handling.mixed-inline.test-helpers.js";
import { refreshQueuedFollowupSession } from "./queue.js";

describe("mixed inline directives / model selection", () => {
  describe.each(["", "please reply "])("model scope with prefix %j", (prefix) => {
    it.each([
      { scope: undefined, flag: "", owner: true, target: undefined, writes: false },
      { scope: "session", flag: "", owner: true, target: undefined, writes: false },
      { scope: "agent", flag: "", owner: true, target: "agent", writes: true },
      { scope: "global", flag: "", owner: true, target: "defaults", writes: true },
      { scope: "global", flag: " --session", owner: true, target: undefined, writes: false },
      { scope: "session", flag: " --agent", owner: true, target: "agent", writes: true },
      { scope: "agent", flag: " --global", owner: true, target: "defaults", writes: true },
      { scope: "agent", flag: "", owner: false, target: undefined, writes: false },
      { scope: "global", flag: "", owner: false, target: undefined, writes: false },
    ] as const)(
      "resolves scope=$scope flag=$flag owner=$owner without widening authority",
      async ({ scope, flag, owner, target, writes }) => {
        const { result, sessionEntry } = await applyMixedDirectives({
          body: `${prefix}/model openai/gpt-5.6-luna${flag}`,
          cfg: { agents: { defaults: { modelSelectionScope: scope } } },
          senderIsOwner: owner,
          allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
        });

        expect(sessionEntry).toMatchObject({
          providerOverride: "openai",
          modelOverride: "gpt-5.6-luna",
          modelOverrideSource: "user",
        });
        const acknowledgement = {
          text: expect.stringContaining(writes ? "update requested" : "default unchanged"),
        };
        expect(result).toMatchObject(
          prefix
            ? { kind: "continue", directiveAck: acknowledgement }
            : { kind: "reply", reply: acknowledgement },
        );
        if (writes) {
          expect(persistStickyModelSelectionBestEffort).toHaveBeenCalledExactlyOnceWith({
            agentId: "main",
            model: "openai/gpt-5.6-luna",
            ...(target ? { target } : {}),
          });
        } else {
          expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
        }
      },
    );
  });

  it("adopts an authoritative model lock and emits no losing side effects", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
    });
    const lockedEntry = { ...sessionEntry, updatedAt: 2, modelSelectionLocked: true };
    persistenceMocks.persist.mockResolvedValueOnce({
      status: "model-selection-locked",
      entry: lockedEntry,
    });

    const { result, sessionStore } = await applyMixedDirectives({
      body: "please reply /model openai/gpt-5.6-luna",
      sessionEntry,
      storePath: "/tmp/sessions.json",
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      senderIsOwner: true,
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: MODEL_SELECTION_LOCKED_MESSAGE, isError: true },
      preRunRejection: "session-directive-rejected",
    });
    expect(persistenceMocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ requireModelSelectionUnlocked: true }),
    );
    expect(sessionEntry).toEqual(lockedEntry);
    expect(sessionStore["agent:main:dm:1"]).toEqual(lockedEntry);
    expect(lifecycleEvents).toEqual([]);
    expect(triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("reports a locked valid model instead of an ignored unauthorized sibling", async () => {
    const sessionEntry = createSessionEntry();
    const lockedEntry = { ...sessionEntry, updatedAt: 2, modelSelectionLocked: true };
    persistenceMocks.persist.mockResolvedValueOnce({
      status: "model-selection-locked",
      entry: lockedEntry,
    });

    const { result } = await applyMixedDirectives({
      body: "please reply\n/trace raw\n/model openai/gpt-5.6-luna",
      sessionEntry,
      storePath: "/tmp/sessions.json",
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      gatewayClientScopes: [],
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: MODEL_SELECTION_LOCKED_MESSAGE, isError: true },
      preRunRejection: "session-directive-rejected",
    });
    expect(sessionEntry).toEqual(lockedEntry);
    expect(persistenceMocks.persist).toHaveBeenCalledOnce();
    expect(triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
