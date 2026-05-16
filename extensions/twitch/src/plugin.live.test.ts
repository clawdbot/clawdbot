/**
 * Live Twitch IRC verification for the runStoppablePassiveMonitor lifecycle
 * pattern used by the Twitch gateway.
 *
 * This test connects to irc.chat.twitch.tv using the same twurple stack the
 * Twitch plugin uses, then drives that connection through the helper this PR
 * wires into twitchPlugin.gateway.startAccount. It asserts the post-fix
 * invariant — startAccount-shaped task stays pending after a successful
 * connection and only resolves when the abort signal fires — using real
 * network rather than mocks.
 *
 * Skipped by default. Enable with:
 *   TWITCH_LIVE_TEST=1
 *   TWITCH_USERNAME=<bot username>
 *   TWITCH_ACCESS_TOKEN=<oauth:token without the "oauth:" prefix>
 *   TWITCH_CLIENT_ID=<client id>
 *   TWITCH_CHANNEL=<channel name to join>
 */

import { StaticAuthProvider } from "@twurple/auth";
import { ChatClient } from "@twurple/chat";
import { runStoppablePassiveMonitor } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";

const LIVE = process.env.TWITCH_LIVE_TEST === "1";
const HAS_CREDS = Boolean(
  process.env.TWITCH_USERNAME &&
  process.env.TWITCH_ACCESS_TOKEN &&
  process.env.TWITCH_CLIENT_ID &&
  process.env.TWITCH_CHANNEL,
);

const maybeDescribe = LIVE && HAS_CREDS ? describe : describe.skip;

maybeDescribe("twitch live IRC lifecycle (skipped unless TWITCH_LIVE_TEST=1)", () => {
  it("real twurple connection + runStoppablePassiveMonitor stays pending until abort, then stops cleanly", async () => {
    const accessTokenRaw = process.env.TWITCH_ACCESS_TOKEN!.replace(/^oauth:/, "");
    const clientId = process.env.TWITCH_CLIENT_ID!;
    const channel = process.env.TWITCH_CHANNEL!;
    const username = process.env.TWITCH_USERNAME!;

    const start = Date.now();
    const log = (msg: string) => {
      console.log(`[T+${Date.now() - start}ms] ${msg}`);
    };

    log(`username=${username} channel=#${channel}`);

    const authProvider = new StaticAuthProvider(clientId, accessTokenRaw, [
      "chat:read",
      "chat:edit",
    ]);

    const abort = new AbortController();
    let connectedAt: number | null = null;
    let settled = false;
    let stopCalled = false;

    const task = runStoppablePassiveMonitor({
      abortSignal: abort.signal,
      start: async () => {
        const chat = new ChatClient({
          authProvider,
          channels: [channel],
          authIntents: ["chat"],
        });

        chat.onConnect(() => {
          connectedAt = Date.now() - start;
          log(`Connected to Twitch as ${username}`);
        });
        chat.onJoin((joinedChannel: string, joinedUser: string) => {
          log(`Joined #${joinedChannel} as ${joinedUser}`);
        });
        chat.onDisconnect((manually: boolean, reason?: Error) => {
          log(`Disconnected (manual=${manually}, reason=${reason?.message ?? "n/a"})`);
        });

        chat.connect();

        return {
          stop: () => {
            stopCalled = true;
            log(`stop() invoked`);
            chat.quit();
          },
        };
      },
    })
      .then(() => {
        settled = true;
        log(`task RESOLVED`);
      })
      .catch((err: unknown) => {
        settled = true;
        log(`task REJECTED: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      });

    // Wait long enough that the original bug would have manifested.
    // The reported time-to-restart in #60071 is ~2ms after connect.
    const WATCH_MS = 15_000;
    await new Promise((resolve) => setTimeout(resolve, WATCH_MS));

    expect(connectedAt, "expected onConnect within the watch window").not.toBeNull();
    expect(settled, "task must not have settled before abort").toBe(false);
    log(
      `--- t+${WATCH_MS}ms checkpoint: connected=${connectedAt}ms, settled=${settled}, stopCalled=${stopCalled}`,
    );

    abort.abort();
    log(`abort() called`);

    await task;

    expect(settled).toBe(true);
    expect(stopCalled, "stop hook must run on abort").toBe(true);
    log(`PASS — promise pending for ${WATCH_MS}ms after connect, then stopped on abort`);
  }, 60_000);
});
