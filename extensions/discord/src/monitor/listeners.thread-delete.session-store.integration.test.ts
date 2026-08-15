// Discord integration tests drive thread deletion through the real session store.
import fs from "node:fs/promises";
import path from "node:path";
import { ChannelType, type GatewayThreadDeleteDispatchData } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getSessionEntry,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { withEnvAsync, withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { DiscordThreadDeleteListener } from "./listeners.js";

const THREAD_ID = "112233445566778899";
const OTHER_THREAD_ID = "998877665544332211";

describe("DiscordThreadDeleteListener session-store integration", () => {
  it("deletes matching sessions from every configured agent store", async () => {
    await withStateDirEnv("openclaw-discord-thread-delete-", async ({ tempRoot, stateDir }) => {
      // macOS exposes os.tmpdir() through /var while SQLite resolves /private/var.
      const canonicalTempRoot = await fs.realpath(tempRoot);
      const canonicalStateDir = await fs.realpath(stateDir);

      await withEnvAsync({ OPENCLAW_STATE_DIR: canonicalStateDir }, async () => {
        const sharedStorePath = path.join(canonicalTempRoot, "shared", "sessions.json");
        const cfg = {
          session: { store: sharedStorePath },
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        } satisfies OpenClawConfig;
        const mainStorePath = resolveStorePath(cfg.session.store, { agentId: "main" });
        const workStorePath = resolveStorePath(cfg.session.store, { agentId: "work" });
        const mainMatchKey = `agent:main:discord:channel:${THREAD_ID}`;
        const workMatchKey = `agent:work:discord:channel:parent:thread:${THREAD_ID}`;
        const survivorKey = `agent:main:discord:channel:${OTHER_THREAD_ID}`;

        await upsertSessionEntry({
          agentId: "main",
          sessionKey: mainMatchKey,
          storePath: mainStorePath,
          entry: { sessionId: "main-thread-session", updatedAt: 1_000 },
        });
        await upsertSessionEntry({
          agentId: "work",
          sessionKey: workMatchKey,
          storePath: workStorePath,
          entry: { sessionId: "work-thread-session", updatedAt: 2_000 },
        });
        await upsertSessionEntry({
          agentId: "main",
          sessionKey: survivorKey,
          storePath: mainStorePath,
          entry: { sessionId: "main-survivor-session", updatedAt: 3_000 },
        });

        const listener = new DiscordThreadDeleteListener(cfg, "session-store-integration");
        const deletedThread: GatewayThreadDeleteDispatchData = {
          id: THREAD_ID,
          guild_id: "887766554433221100",
          parent_id: "776655443322110099",
          type: ChannelType.PublicThread,
        };

        await listener.handle(deletedThread);

        expect(
          getSessionEntry({
            agentId: "main",
            sessionKey: mainMatchKey,
            storePath: mainStorePath,
          }),
        ).toBeUndefined();
        expect(
          getSessionEntry({
            agentId: "work",
            sessionKey: workMatchKey,
            storePath: workStorePath,
          }),
        ).toBeUndefined();
        expect(
          getSessionEntry({
            agentId: "main",
            sessionKey: survivorKey,
            storePath: mainStorePath,
          }),
        ).toMatchObject({ sessionId: "main-survivor-session", updatedAt: 3_000 });
      });
    });
  });
});
