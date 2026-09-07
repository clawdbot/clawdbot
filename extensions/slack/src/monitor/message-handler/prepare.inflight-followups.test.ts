import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as sessionStore from "openclaw/plugin-sdk/session-store-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSlackThreadParticipationCache,
  hasSlackThreadParticipation,
} from "../../sent-thread-cache.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackMonitorContext } from "../context.js";
import { registerSlackSessionRun } from "../session-run-targets.js";
import { prepareSlackMessage } from "./prepare.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./prepare.test-helpers.js";

describe("Slack follow-ups before the first reply", () => {
  const fixture = createSlackSessionStoreFixture("openclaw-slack-inflight-");
  const rootTs = "1700000000.000001";
  const releases: Array<() => void> = [];

  beforeAll(() => fixture.setup());
  beforeEach(() => {
    clearSlackThreadParticipationCache();
    const { storePath } = fixture.makeTmpStorePath();
    vi.spyOn(sessionStore, "resolveStorePath").mockReturnValue(storePath);
  });
  afterEach(() => {
    releases.splice(0).forEach((release) => release());
    vi.restoreAllMocks();
    clearSlackThreadParticipationCache();
  });
  afterAll(() => fixture.cleanup());

  function createContext(
    threadParticipation = true,
    channelsConfig?: Parameters<typeof createInboundSlackTestContext>[0]["channelsConfig"],
  ) {
    const cfg: OpenClawConfig = {
      channels: { slack: { enabled: true, implicitMentions: { threadParticipation } } },
    };
    const ctx = createInboundSlackTestContext({ cfg, replyToMode: "all", channelsConfig });
    ctx.resolveUserName = async () => ({ name: "Alice" });
    return ctx;
  }

  async function prepare(ctx: SlackMonitorContext, message: Partial<SlackMessageEvent> = {}) {
    return prepareSlackMessage({
      ctx,
      account: createSlackTestAccount(),
      message: {
        type: "message",
        channel: "C123",
        channel_type: "channel",
        user: "U1",
        text: "Use the revised total",
        ts: "1700000001.000001",
        thread_ts: rootTs,
        parent_user_id: "U1",
        ...message,
      },
      opts: { source: "message" },
    });
  }

  function begin(prepared: NonNullable<Awaited<ReturnType<typeof prepare>>>) {
    const release = registerSlackSessionRun(
      prepared.ctx,
      { channelId: prepared.message.channel, threadTs: rootTs, eventScope: prepared.eventScope },
      prepared.route,
      { allowImplicitReplies: prepared.allowImplicitThreadReplies },
    );
    releases.push(release);
    return release;
  }

  it("admits human follow-ups during accepted work without persisting a delivered reply", async () => {
    const ctx = createContext();
    expect(await prepare(ctx)).toBeNull();
    const root = await prepare(ctx, {
      text: "<@B1> Check the report",
      ts: rootTs,
      thread_ts: undefined,
    });
    expect(root).not.toBeNull();
    if (!root) {
      throw new Error("Expected the mentioned request to be accepted");
    }
    const endRoot = begin(root);
    // Configuration reloads inherit the same Bolt app without reconnecting.
    const reloaded = Object.create(ctx) as SlackMonitorContext;
    reloaded.cfg = { ...ctx.cfg };
    expect((await prepare(reloaded))?.ctxPayload.MentionSource).toBe("implicit_thread");

    const followup = await prepare(ctx);
    expect(followup?.ctxPayload.MentionSource).toBe("implicit_thread");
    expect(hasSlackThreadParticipation("default", "C123", rootTs)).toBe(false);
    if (!followup) {
      throw new Error("Expected an in-flight follow-up");
    }
    const endFollowup = begin(followup);
    endRoot();
    expect((await prepare(ctx))?.ctxPayload.MentionSource).toBe("implicit_thread");
    endFollowup();
    expect(await prepare(ctx)).toBeNull();
  });

  it("keeps the explicit-mention policy authoritative during active work", async () => {
    const ctx = createContext(false);
    const root = await prepare(ctx, { text: "<@B1> Check the report" });
    if (!root) {
      throw new Error("Expected the mentioned request to be accepted");
    }
    begin(root);
    expect(await prepare(ctx)).toBeNull();
    expect(
      (await prepare(ctx, { text: "<@B1> Use the revised total" }))?.ctxPayload.MentionSource,
    ).toBe("explicit_bot");
  });

  it.each(["<@B1> /status", "<@B1> stop"])(
    "does not open a thread for control input %s",
    async (text) => {
      const ctx = createContext();
      const control = await prepare(ctx, { text });
      if (control) {
        begin(control);
      }
      expect(await prepare(ctx)).toBeNull();
    },
  );

  it("does not lend active participation across a thread, channel, monitor, or account", async () => {
    const ctx = createContext();
    const root = await prepare(ctx, { text: "<@B1> Check the report" });
    if (!root) {
      throw new Error("Expected the mentioned request to be accepted");
    }
    begin(root);
    expect(await prepare(ctx, { thread_ts: "1700000000.000999" })).toBeNull();
    expect(await prepare(ctx, { channel: "C_OTHER" })).toBeNull();
    releases.splice(0).forEach((release) => release());
    begin({ ...root, eventScope: { teamId: "T_OTHER", client: ctx.app.client } });
    expect(await prepare(ctx)).toBeNull();
    begin(root);
    expect(await prepare(createContext())).toBeNull();
    const otherAccount = { ...root, route: { ...root.route, accountId: "other" } };
    releases.splice(0).forEach((release) => release());
    begin(otherAccount);
    expect(await prepare(ctx)).toBeNull();
  });

  it("keeps room sender restrictions and other mentions authoritative during active work", async () => {
    const ctx = createContext(true, { C123: { users: ["U1"], ignoreOtherMentions: true } });
    ctx.allowFrom = ["U1"];
    const root = await prepare(ctx, { text: "<@B1> Check the report" });
    if (!root) {
      throw new Error("Expected the mentioned request to be accepted");
    }
    begin(root);
    expect(await prepare(ctx, { user: "U_OTHER" })).toBeNull();
    expect(await prepare(ctx, { text: "<@U_OTHER> Check the report" })).toBeNull();
    expect((await prepare(ctx))?.ctxPayload.MentionSource).toBe("implicit_thread");
  });

  it("does not open active participation for bots or admit them through a human run", async () => {
    const ctx = createContext(true, { C123: { allowBots: true, users: ["U1", "U_BOT"] } });
    const bot = await prepare(ctx, {
      text: "<@B1> Check the report",
      user: "U_BOT",
      bot_id: "B_OTHER",
    });
    if (!bot) {
      throw new Error("Expected the explicitly mentioned bot message to be accepted");
    }
    begin(bot);
    expect(await prepare(ctx)).toBeNull();
    const root = await prepare(ctx, { text: "<@B1> Check the report" });
    if (!root) {
      throw new Error("Expected the mentioned request to be accepted");
    }
    begin(root);
    expect(await prepare(ctx, { user: "U_BOT", bot_id: "B_OTHER" })).toBeNull();
    expect((await prepare(ctx))?.ctxPayload.MentionSource).toBe("implicit_thread");
  });

  it("does not let an overlapping ineligible publisher hide an accepted human turn", async () => {
    const ctx = createContext();
    const root = await prepare(ctx, { text: "<@B1> Check the report" });
    if (!root) {
      throw new Error("Expected the mentioned request to be accepted");
    }
    const endRoot = begin(root);
    begin({ ...root, allowImplicitThreadReplies: false });
    expect((await prepare(ctx))?.ctxPayload.MentionSource).toBe("implicit_thread");
    endRoot();
    expect(await prepare(ctx)).toBeNull();
  });
});
