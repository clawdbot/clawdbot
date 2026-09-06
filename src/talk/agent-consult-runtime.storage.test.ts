import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createRuntimeAgent } from "../plugins/runtime/runtime-agent.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { consultRealtimeVoiceAgent } from "./agent-consult-runtime.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "voice-consult-store" });
});
afterEach(async () => {
  await state.cleanup();
});

describe("voice consult concrete store ownership", () => {
  it.each([
    { parentAgentId: "main", locked: false },
    { parentAgentId: "other", locked: false },
    { parentAgentId: "main", locked: true },
  ])(
    "keeps parent $parentAgentId policy and routing in its configured store (locked=$locked)",
    async ({ parentAgentId, locked }) => {
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: { workspace: state.workspaceDir }, other: {} },
          ownership: "explicit",
        },
      };
      const runEmbeddedAgent = vi.fn(async () => ({
        payloads: [{ text: "Checked" }],
        meta: { durationMs: 0 },
      }));
      const agentRuntime = { ...createRuntimeAgent(), runEmbeddedAgent };
      const spawnedBy = `agent:${parentAgentId}:parent`;
      const parentStore = agentRuntime.session.resolveStorePath(cfg.session?.store, {
        agentId: parentAgentId,
      });
      const createdActor = {
        type: "human" as const,
        source: "profile" as const,
        id: "parent-creator",
      };
      await replaceSessionEntry(
        { agentId: parentAgentId, sessionKey: spawnedBy, storePath: parentStore },
        {
          sessionId: "parent-session",
          updatedAt: 1,
          createdVia: "operator",
          createdActor,
          sandbox: "required",
          modelSelectionLocked: locked,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "discord", to: "channel:synthetic", accountId: "test-account" },
          }),
        },
      );
      const sessionKey = "agent:main:voice-child";
      const storePath = state.statePath("consult", "sessions.sqlite");
      const consult = consultRealtimeVoiceAgent({
        cfg,
        agentRuntime,
        logger: { warn: vi.fn() },
        agentId: "main",
        sessionKey,
        storePath,
        spawnedBy,
        contextMode: "isolated",
        messageProvider: "webchat",
        lane: "talk",
        runIdPrefix: "test-consult",
        args: { question: "Check this" },
        transcript: [],
        surface: "test voice",
        userLabel: "User",
      });
      if (locked) {
        await expect(consult).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toBeUndefined();
        return;
      }
      await expect(consult).resolves.toEqual({ text: "Checked" });
      expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })).toMatchObject({
        sandbox: "required",
        createdActor,
        spawnedBy,
      });
      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          messageProvider: "discord",
          messageTo: "channel:synthetic",
          agentAccountId: "test-account",
          sessionTarget: expect.objectContaining({ agentId: "main", sessionKey, storePath }),
        }),
      );
    },
  );
});
