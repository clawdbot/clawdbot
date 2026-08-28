import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../../config/config.js";
import { loadCombinedSessionStoreForGatewayCore } from "../../config/sessions/combined-store-gateway.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { usageHandlers } from "./usage.js";

it.each([undefined, "agent:opus:slack:dm", "global"])(
  "keeps independent same-id transcripts with opus store key %s through the real usage handler",
  async (opusKey) => {
    const state = await createOpenClawTestState({ label: "usage-owner-integration" });
    try {
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: {}, opus: {} } },
        plugins: { enabled: false },
      });
      const config = getRuntimeConfig();
      const sessionId = "shared-usage-session";
      const mainKey = "agent:main:telegram:dm";
      for (const agentId of ["main", "opus"]) {
        const key = agentId === "main" ? mainKey : opusKey;
        const scope = {
          agentId,
          sessionId,
          sessionKey: key ?? `agent:${agentId}:${sessionId}`,
          storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
        };
        if (key) {
          await upsertSessionEntryCore(scope, {
            sessionId,
            updatedAt: Date.now(),
            label: `${agentId} chat`,
          });
        }
        await persistSessionTranscriptTurn(scope, {
          cwd: state.workspaceDir,
          updateMode: "none",
          messages: [
            {
              message: { role: "user", content: `${agentId} turn`, timestamp: Date.now() },
              now: Date.now(),
            },
          ],
        });
      }

      const projected = loadCombinedSessionStoreForGatewayCore(config);
      expect(projected.agentIdBySessionKey.get(mainKey)).toBe("main");
      if (opusKey) {
        expect(projected.agentIdBySessionKey.get(opusKey)).toBe("opus");
      }
      const respond = vi.fn();
      await expectDefined(
        usageHandlers["sessions.usage"],
        "usage handler",
      )({
        params: { agentScope: "all", range: "all", limit: 50 },
        context: { getRuntimeConfig: () => config },
        respond,
      } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
      expect(respond).toHaveBeenCalledOnce();
      const [ok, payload] = expectDefined(respond.mock.calls[0], "usage response");
      expect(ok).toBe(true);
      const result = payload as SessionsUsageResult;
      expect(result.sessions).toHaveLength(2);
      expect(result.sessions.map(({ key, agentId }) => ({ key, agentId }))).toEqual(
        expect.arrayContaining([
          { key: mainKey, agentId: "main" },
          { key: opusKey ?? `agent:opus:${sessionId}`, agentId: "opus" },
        ]),
      );
    } finally {
      await state.cleanup();
    }
  },
);
