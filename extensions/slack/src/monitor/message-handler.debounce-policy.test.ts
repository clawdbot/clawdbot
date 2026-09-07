import { App } from "@slack/bolt";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { expect, it, vi } from "vitest";
import { resolveSlackAccount } from "../accounts.js";
import type { SlackMessageEvent } from "../types.js";
import { createSlackMonitorContext } from "./context.js";
import { createSlackMessageHandler } from "./message-handler.js";

const prepare = vi.hoisted(() => vi.fn(async (_params: { message: SlackMessageEvent }) => null));
vi.mock("./message-handler/pipeline.runtime.js", () => ({
  prepareSlackMessage: prepare,
  dispatchPreparedSlackMessage: vi.fn(),
}));

it("updates Slack delay and flushes newly buffered top-level keys before immediate work", async () => {
  const cfg: OpenClawConfig = { messages: { inbound: { debounceMs: 0 } } };
  setRuntimeConfigSnapshot(cfg, cfg);
  prepare.mockClear();
  const app = new App({
    token: "synthetic-token",
    signingSecret: "synthetic-signing-secret",
    tokenVerificationEnabled: false,
  });
  const abort = new AbortController();
  const handler = createSlackMessageHandler({
    ctx: createSlackMonitorContext({
      cfg,
      accountId: "default",
      app,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      botToken: "synthetic-token",
      botUserId: "BOT",
      identityHealth: { lifecycle: "ready", lastError: null },
      teamId: "TEAM",
      apiAppId: "APP",
      historyLimit: 0,
      sessionScope: "per-sender",
      mainKey: "main",
      dmEnabled: true,
      dmPolicy: "open",
      allowFrom: [],
      allowNameMatching: false,
      groupDmEnabled: false,
      groupDmChannels: [],
      groupPolicy: "open",
      useAccessGroups: true,
      reactionMode: "off",
      reactionAllowlist: [],
      replyToMode: "off",
      threadHistoryScope: "thread",
      threadInheritParent: false,
      slashCommand: {
        enabled: false,
        name: "openclaw",
        ephemeral: true,
        sessionPrefix: "slack:slash",
      },
      textLimit: 4000,
      typingReaction: "",
      mediaMaxBytes: 1024,
    }),
    account: resolveSlackAccount({ cfg, accountId: "default" }),
    abortSignal: abort.signal,
  });
  let sequence = 0;
  const enqueue = (text: string, channel = "D1") =>
    handler(
      { type: "message", channel, user: "USER", ts: `123.${++sequence}`, text },
      { source: "message" },
    );
  const publish = (debounceMs: number) => {
    const current = { messages: { inbound: { debounceMs } } };
    setRuntimeConfigSnapshot(current, current);
  };
  const bodies = () => prepare.mock.calls.map(([params]) => params.message.text);
  vi.useFakeTimers();
  try {
    await enqueue("immediate");
    expect(bodies()).toEqual(["immediate"]);
    publish(25);
    await enqueue("first");
    await enqueue("second");
    expect(bodies()).toEqual(["immediate"]);
    await vi.advanceTimersByTimeAsync(25);
    expect(bodies()).toEqual(["immediate", "first\nsecond"]);
    await enqueue("pending top level", "C1");
    publish(0);
    await enqueue("after disable", "C1");
    expect(bodies()).toEqual(["immediate", "first\nsecond", "pending top level", "after disable"]);
  } finally {
    abort.abort();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    clearRuntimeConfigSnapshot();
  }
});
