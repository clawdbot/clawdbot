import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  readAgentRunTerminalOutcome,
  recordAgentRunTerminalOutcome,
} from "../channels/turn/agent-run-terminal-outcome.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import type { PluginHookReplyPayloadSendingEvent } from "../plugins/hook-types.js";
import { dispatchInboundMessage } from "./dispatch.js";
import { resolveGroupThreadConfig } from "./group-thread-config.js";
import { buildThreadingToolContext } from "./reply/agent-runner-utils.js";
import type {
  DispatchFromConfigParams,
  DispatchFromConfigResult,
} from "./reply/dispatch-from-config.types.js";
import { createReplyDispatcher } from "./reply/reply-dispatcher.js";
import type { ReplyDispatchRuntimeInfo } from "./reply/reply-dispatcher.types.js";
import {
  buildChannelSourceTurnId,
  readChannelSourceTurnId,
  setChannelSourceTurnId,
} from "./reply/source-turn-id.js";
import type { MsgContext } from "./templating.js";

vi.mock("./reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: () => {
    throw new Error("The fixture must provide its participant reply resolver");
  },
}));

const replyHooks = vi.hoisted(() => {
  const state: {
    enabled: boolean;
    events: PluginHookReplyPayloadSendingEvent[];
    rewriteText?: string;
  } = { enabled: false, events: [] };
  return state;
});

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (name: string) => replyHooks.enabled && name === "reply_payload_sending",
    runReplyPayloadSending: async (event: PluginHookReplyPayloadSendingEvent) => {
      replyHooks.events.push(event);
      return replyHooks.rewriteText === undefined
        ? undefined
        : { payload: { ...event.payload, text: replyHooks.rewriteText } };
    },
  }),
}));

const roster: OpenClawConfig["agents"] = {
  entries: {
    alice: { identity: { name: "Alice", emoji: "🦉" } },
    bob: { identity: { name: "Bob" } },
    carol: { identity: { name: "Carol" } },
  },
};

function config(
  entry: NonNullable<OpenClawConfig["broadcast"]>[string] = ["alice", "bob"],
): OpenClawConfig {
  return { agents: roster, broadcast: { "telegram:-100123": entry } };
}

function dispatch(
  params: {
    cfg?: OpenClawConfig;
    enableHooks?: boolean;
    text?: string;
    context?: Partial<MsgContext>;
    abortSignal?: AbortSignal;
    replyOptions?: DispatchFromConfigParams["replyOptions"];
    reply?: (turn: DispatchFromConfigParams, index: number) => string[] | Promise<string[]>;
    result?: (
      turn: DispatchFromConfigParams,
      result: DispatchFromConfigResult,
    ) => DispatchFromConfigResult;
  } = {},
) {
  const turns: DispatchFromConfigParams[] = [];
  const delivered: {
    text: string | undefined;
    participant: ReplyDispatchRuntimeInfo["participant"];
  }[] = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (payload, info) => {
      delivered.push({ text: payload.text, participant: info.participant });
    },
  });
  const text = params.text ?? "Discuss the proposal.";
  const done = dispatchInboundMessage({
    cfg: params.cfg ?? config(),
    ctx: {
      Body: text,
      BodyForAgent: text,
      CommandBody: text,
      CommandSource: "text",
      ChatType: "group",
      SessionKey: "agent:routed:telegram:group:-100123",
      AgentId: "routed",
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:-100123",
      NativeChannelId: "-100123",
      From: "telegram:group:-100123",
      To: "telegram:-100123",
      MessageSid: "physical-1",
      ...params.context,
    },
    dispatcher,
    outboundHooks: params.enableHooks ? "enabled" : "disabled",
    replyOptions: { abortSignal: params.abortSignal, ...params.replyOptions },
    dispatchReplyFromConfig: async (turn) => {
      const index = turns.push(turn) - 1;
      const replies = await (params.reply?.(turn, index) ?? ["A useful answer."]);
      let final = 0;
      for (const replyText of replies) {
        final += Number(turn.dispatcher.sendFinalReply({ text: replyText }));
      }
      const result = { queuedFinal: final > 0, counts: { tool: 0, block: 0, final } };
      return params.result?.(turn, result) ?? result;
    },
  });
  return { done, turns, delivered };
}

describe("agent group thread dispatch", () => {
  it("shares post-hook finals in continuation digests", async () => {
    replyHooks.enabled = true;
    replyHooks.rewriteText = "Bob, this is the public final.";
    try {
      const run = dispatch({
        cfg: config({ agents: ["alice", "bob"], maxRounds: 2, maxTurns: 4 }),
        enableHooks: true,
        reply: (_turn, index) =>
          index === 0 ? ["Bob, this is the unfiltered draft."] : ["NO_REPLY"],
      });
      await run.done;
      expect(run.turns).toHaveLength(4);
      const continuation = expectDefined(run.turns[3], "expected Bob's continuation");
      expect(continuation.ctx.BodyForAgent).toContain("Bob, this is the public final.");
      expect(continuation.ctx.BodyForAgent).not.toContain("unfiltered draft");
    } finally {
      replyHooks.enabled = false;
      replyHooks.rewriteText = undefined;
    }
  });

  it.each([
    { name: "operator UI", context: { Provider: "webchat", Surface: "webchat" } },
    { name: "internal event", context: { InternalTurnSource: "heartbeat" as const } },
  ])("does not fan out an $name with an external reply target", async ({ context }) => {
    const run = dispatch({ context });
    await run.done;
    expect(run.turns).toHaveLength(1);
    expect(run.turns[0]?.ctx.AgentId).toBe("routed");
    expect(expectDefined(run.delivered[0], "expected ordinary reply").participant).toBeUndefined();
  });

  it("resolves the configured room by its canonical route peer rather than a transport alias", async () => {
    const run = dispatch({
      context: { ConversationRoutePeerId: "-100123", NativeChannelId: "transport-room" },
    });
    await run.done;
    expect(run.turns.map((turn) => turn.ctx.AgentId)).toEqual(["alice", "bob"]);
    expect(run.turns.every((turn) => turn.ctx.SessionKey?.includes(":group:-100123"))).toBe(true);
  });

  it.each([
    { text: "@Bob, review this.", participants: ["bob"] },
    { text: "@Alice and @Bob, review this.", participants: ["alice", "bob"] },
    { text: "Bob already reviewed Alice's idea 🦉.", participants: ["alice", "bob"] },
    { text: "Reach me at person@Bob.example.", participants: ["alice", "bob"] },
    { text: "@someone_else, review this.", participants: ["alice", "bob"] },
  ])("selects explicit participant addresses in '$text'", async ({ text, participants }) => {
    const run = dispatch({ text });
    await run.done;
    expect(run.turns.map((turn) => turn.ctx.AgentId)).toEqual(participants);
    expect(run.delivered.map((reply) => reply.participant?.agentId)).toEqual(participants);
    expect(run.delivered.map((reply) => reply.participant?.name)).toEqual(
      participants.map((id) => (id === "alice" ? "Alice" : "Bob")),
    );
  });

  it("can disable selection and leaves a single configured participant unlabeled", async () => {
    const all = dispatch({
      cfg: config({ agents: ["alice", "bob"], mentionGating: false }),
      text: "@Bob",
    });
    await all.done;
    expect(all.turns.map((turn) => turn.ctx.AgentId)).toEqual(["alice", "bob"]);
    const single = dispatch({ cfg: config(["bob"]) });
    await single.done;
    expect(single.delivered).toEqual([{ text: "A useful answer.", participant: undefined }]);
  });

  it("isolates participant sessions across account and thread while retaining conversation scope", async () => {
    const keys = new Set<string | undefined>();
    for (const AccountId of ["work", "personal"]) {
      for (const MessageThreadId of [7, 8]) {
        const run = dispatch({ context: { AccountId, MessageThreadId } });
        await run.done;
        for (const { ctx } of run.turns) {
          expect(ctx.SessionKey).toBe(
            `agent:${ctx.AgentId}:telegram:group:-100123:thread:telegram-account-${AccountId}:thread:${MessageThreadId}`,
          );
          keys.add(ctx.SessionKey);
        }
      }
    }
    expect(keys.size).toBe(8);
  });

  it("continues responders and addressed siblings with bounded attributed finals, then stops on all-pass", async () => {
    const aliceReply = `Bob, check this analysis. ${"a".repeat(6_000)}`;
    const run = dispatch({
      cfg: config({ agents: ["alice", "bob", "carol"], maxRounds: 4, maxTurns: 12 }),
      reply: (_turn, index) => (index === 0 ? [aliceReply] : ["NO_REPLY"]),
    });
    await run.done;
    expect(run.turns.map((turn) => turn.ctx.AgentId)).toEqual([
      "alice",
      "bob",
      "carol",
      "alice",
      "bob",
    ]);
    const bobContinuation = expectDefined(run.turns[4], "expected Bob's continuation").ctx;
    expect(bobContinuation.BodyForAgent).toContain("Alice (alice):");
    expect(bobContinuation.BodyForAgent).toContain("Bob, check this analysis.");
    expect(bobContinuation.BodyForAgent).toContain("NO_REPLY");
    expect(bobContinuation.BodyForAgent!.length).toBeLessThan(17_000);
    expect(
      expectDefined(run.turns[3], "expected Alice's continuation").ctx.BodyForAgent,
    ).not.toContain("Bob, check this analysis.");
    expect(run.turns.slice(0, 3).map((turn) => turn.ctx.MessageSid)).toEqual([
      "physical-1",
      "physical-1",
      "physical-1",
    ]);
    expect(new Set(run.turns.slice(3).map((turn) => turn.ctx.MessageSid)).size).toBe(2);
    expect(run.turns.slice(3).every((turn) => turn.ctx.MessageSid !== "physical-1")).toBe(true);
    expect(run.delivered).toHaveLength(1);
  });

  it.each([undefined, "physical-full-1"])(
    "keeps continuation reply targets physical and transcript identities distinct (full ID: %s)",
    async (fullMessageId) => {
      const context: Partial<MsgContext> = {
        AccountId: "work",
        MessageThreadId: 7,
        MessageSidFull: fullMessageId,
        MessageSidFirst: "physical-first",
        MessageSidLast: "physical-last",
      };
      const originalSourceId = buildChannelSourceTurnId({
        provider: "telegram",
        accountId: "work",
        conversationId: "telegram:-100123",
        messageId: fullMessageId ?? "physical-1",
      });
      setChannelSourceTurnId(context, originalSourceId);
      const run = dispatch({
        cfg: config({ agents: ["alice", "bob"], maxRounds: 2, maxTurns: 4 }),
        context,
      });
      await run.done;
      const continuations = run.turns.slice(2).map((turn) => turn.ctx);
      expect(continuations).toHaveLength(2);
      for (const ctx of continuations) {
        expect(
          buildThreadingToolContext({
            sessionCtx: ctx,
            config: undefined,
            hasRepliedRef: undefined,
          }).currentMessageId,
        ).toBe(fullMessageId ?? "physical-1");
        expect(ctx.MessageSid).not.toBe("physical-1");
        expect(ctx.MessageSidFirst).toBe("physical-first");
        expect(ctx.MessageSidLast).toBe("physical-last");
      }
      expect(new Set(continuations.map((ctx) => ctx.MessageSid)).size).toBe(2);
      const sourceIds = continuations.map(readChannelSourceTurnId);
      expect(sourceIds.every(Boolean)).toBe(true);
      expect(sourceIds).not.toContain(originalSourceId);
      expect(new Set(sourceIds).size).toBe(2);
    },
  );

  it.each([2, 4])(
    "reserves maxTurns=%i before parallel launch without counting physical replies",
    async (maxTurns) => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const run = dispatch({
        cfg: config({ agents: ["alice", "bob", "carol"], maxRounds: 4, maxTurns }),
        reply: async () => {
          await gate;
          return ["First delivery.", "Second delivery."];
        },
      });
      try {
        await vi.waitFor(() => expect(run.turns).toHaveLength(Math.min(3, maxTurns)));
      } finally {
        release();
      }
      await run.done;
      expect(run.turns).toHaveLength(maxTurns);
      expect(run.delivered).toHaveLength(maxTurns * 2);
    },
  );

  it("honors the round ceiling even while every participant keeps replying", async () => {
    const run = dispatch({ cfg: config({ agents: ["alice", "bob"], maxRounds: 2, maxTurns: 32 }) });
    await run.done;
    expect(run.turns).toHaveLength(4);
    expect(run.delivered).toHaveLength(4);
  });

  it.each([
    { beforeStart: true, source: "ordinary" },
    { beforeStart: false, source: "ordinary" },
    { beforeStart: true, source: "lifecycle" },
    { beforeStart: false, source: "lifecycle" },
  ])(
    "propagates $source cancellation and stops launches (already aborted: $beforeStart)",
    async ({ beforeStart, source }) => {
      const controller = new AbortController();
      if (beforeStart) {
        controller.abort();
      }
      const cfg = config({ agents: ["alice", "bob"], maxRounds: 4, maxTurns: 8 });
      cfg.broadcast = { ...cfg.broadcast, strategy: "sequential" };
      const participantSignals: (AbortSignal | undefined)[] = [];
      const run = dispatch({
        cfg,
        replyOptions:
          source === "ordinary"
            ? { abortSignal: controller.signal }
            : {
                turnAdoptionLifecycle: {
                  abortSignal: controller.signal,
                  onAdopted: async () => {},
                },
              },
        reply: ({ replyOptions }) => {
          participantSignals.push(replyOptions?.abortSignal);
          controller.abort();
          return ["This turn completed."];
        },
      });
      await run.done;
      expect(run.turns).toHaveLength(beforeStart ? 0 : 1);
      expect(participantSignals.every((signal) => signal?.aborted)).toBe(true);
    },
  );

  it("adopts the inbound once before participants and settles once after all participants", async () => {
    const events: string[] = [];
    const run = dispatch({
      replyOptions: {
        turnAdoptionLifecycle: {
          onAdopted: async () => {
            events.push("adopted");
          },
          onSettled: () => {
            events.push("settled");
          },
        },
      },
      reply: async ({ ctx }) => {
        events.push(`${ctx.AgentId}:started`);
        await Promise.resolve();
        events.push(`${ctx.AgentId}:completed`);
        return ["Done."];
      },
    });
    await run.done;
    expect(events[0]).toBe("adopted");
    expect(events.at(-1)).toBe("settled");
    expect(events.filter((event) => event === "adopted")).toHaveLength(1);
    expect(events.filter((event) => event === "settled")).toHaveLength(1);
    expect(events.filter((event) => event.endsWith(":completed"))).toEqual([
      "alice:completed",
      "bob:completed",
    ]);
  });

  it("shares an in-flight root budget across equivalent thread ids, while isolating accounts and other threads", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = dispatch({
      context: { AccountId: "work", MessageThreadId: 7 },
      reply: async () => {
        await gate;
        return ["Done."];
      },
    });
    try {
      await vi.waitFor(() => expect(first.turns).toHaveLength(2));
      const duplicate = dispatch({ context: { AccountId: "work", MessageThreadId: "7" } });
      const otherAccount = dispatch({ context: { AccountId: "personal", MessageThreadId: 7 } });
      const otherThread = dispatch({ context: { AccountId: "work", MessageThreadId: 8 } });
      await Promise.all([duplicate.done, otherAccount.done, otherThread.done]);
      expect(duplicate.turns).toHaveLength(0);
      expect(duplicate.delivered).toHaveLength(0);
      expect(otherAccount.turns).toHaveLength(2);
      expect(otherThread.turns).toHaveLength(2);
    } finally {
      release();
      await first.done;
    }
    expect(first.turns).toHaveLength(2);
  });

  it.each(["session", "native command", "conversation binding"])(
    "keeps an ACP %s exclusive even in a configured group room",
    async (source) => {
      const targetSessionKey = "agent:routed:acp:bound";
      const binding: SessionBindingRecord = {
        bindingId: "group-thread-acp-binding",
        targetSessionKey,
        targetKind: "session",
        conversation: { channel: "telegram", accountId: "default", conversationId: "-100123" },
        status: "active",
        boundAt: 1,
      };
      const adapter: SessionBindingAdapter = {
        channel: "telegram",
        accountId: "default",
        listBySession: (key) => (key === targetSessionKey ? [binding] : []),
        resolveByConversation: (ref) => (ref.conversationId === "-100123" ? binding : null),
      };
      if (source === "conversation binding") {
        registerSessionBindingAdapter(adapter);
      }
      try {
        const context: Partial<MsgContext> =
          source === "session"
            ? { SessionKey: targetSessionKey }
            : source === "native command"
              ? {
                  CommandSource: "native",
                  CommandTargetSessionKey: targetSessionKey,
                  CommandBody: "/status",
                }
              : {};
        const run = dispatch({ context });
        await run.done;
        expect(run.turns).toHaveLength(1);
        const dispatched = expectDefined(run.turns[0], "expected exclusive ACP dispatch");
        expect(dispatched.ctx.AgentId).toBe("routed");
        expect(dispatched.ctx.SessionKey).toBe(
          context.SessionKey ?? "agent:routed:telegram:group:-100123",
        );
        if (source === "native command") {
          expect(dispatched.ctx.CommandTargetSessionKey).toBe(targetSessionKey);
        }
        expect(expectDefined(run.delivered[0], "expected ACP reply").participant).toBeUndefined();
      } finally {
        if (source === "conversation binding") {
          unregisterSessionBindingAdapter({ channel: "telegram", accountId: "default", adapter });
        }
      }
    },
  );

  it("attributes parallel reply hooks to each participant's own run and session", async () => {
    replyHooks.events.length = 0;
    replyHooks.enabled = true;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = dispatch({
      enableHooks: true,
      reply: async ({ ctx, replyOptions }) => {
        replyOptions?.onAgentRunStart?.(`run-${ctx.AgentId}`);
        await gate;
        return [`Answer from ${ctx.AgentId}.`];
      },
    });
    try {
      await vi.waitFor(() => expect(run.turns).toHaveLength(2));
    } finally {
      release();
      try {
        await run.done;
      } finally {
        replyHooks.enabled = false;
      }
    }
    expect(
      replyHooks.events.map(({ payload, runId, sessionKey }) => ({
        text: payload.text,
        runId,
        sessionKey,
      })),
    ).toEqual([
      {
        text: "Answer from alice.",
        runId: "run-alice",
        sessionKey: "agent:alice:telegram:group:-100123",
      },
      {
        text: "Answer from bob.",
        runId: "run-bob",
        sessionKey: "agent:bob:telegram:group:-100123",
      },
    ]);
  });

  it("preserves intentional silence for a message-tool-only group without starting follow-up rounds", async () => {
    const run = dispatch({
      cfg: config({ agents: ["alice", "bob"], maxRounds: 4, maxTurns: 8 }),
      reply: () => ["NO_REPLY"],
      result: (_turn, result) => ({
        ...result,
        sourceReplyDeliveryMode: "message_tool_only",
        deliberateSilentTerminalReply: true,
      }),
    });
    expect(await run.done).toMatchObject({
      queuedFinal: false,
      sourceReplyDeliveryMode: "message_tool_only",
      deliberateSilentTerminalReply: true,
    });
    expect(run.turns).toHaveLength(2);
    expect(run.delivered).toHaveLength(0);
  });

  it.each(["throw", "reported"])(
    "reports a %s participant failure while still delivering its sibling's reply",
    async (failure) => {
      const run = dispatch({
        reply: ({ ctx }) => {
          if (ctx.AgentId === "alice") {
            if (failure === "throw") {
              throw new Error("Participant run failed.");
            }
            return ["NO_REPLY"];
          }
          return ["Bob completed the review."];
        },
        result: ({ ctx }, result) =>
          recordAgentRunTerminalOutcome(result, ctx.AgentId === "alice" ? "failed" : "completed"),
      });
      const result = await run.done;
      expect(readAgentRunTerminalOutcome(result)).toBe("failed");
      expect(result.queuedFinal).toBe(true);
      expect(run.turns).toHaveLength(2);
      expect(run.delivered).toEqual([
        { text: "Bob completed the review.", participant: { agentId: "bob", name: "Bob" } },
      ]);
    },
  );

  it("retains normal single-agent dispatch outside a configured room", async () => {
    const run = dispatch({ cfg: { agents: roster } });
    await run.done;
    expect(run.turns).toHaveLength(1);
    expect(run.turns[0]?.ctx.SessionKey).toBe("agent:routed:telegram:group:-100123");
    expect(expectDefined(run.delivered[0], "expected ordinary reply").participant).toBeUndefined();
  });
});

describe("group thread entry compatibility", () => {
  it("prefers a qualified WhatsApp entry and keeps unqualified arrays single-pass and WhatsApp-only", () => {
    const cfg: OpenClawConfig = {
      agents: roster,
      broadcast: {
        "1203@g.us": ["alice", "bob"],
        "whatsapp:1203@g.us": { agents: ["carol"], maxRounds: 3, maxTurns: 8 },
      },
    };
    expect(
      resolveGroupThreadConfig({ cfg, channel: "whatsapp", peerId: "1203@g.us" }),
    ).toMatchObject({
      agents: ["carol"],
      qualified: true,
      maxRounds: 3,
      maxTurns: 8,
    });
    const legacy: OpenClawConfig = { agents: roster, broadcast: { "1203@g.us": ["alice", "bob"] } };
    expect(
      resolveGroupThreadConfig({ cfg: legacy, channel: "whatsapp", peerId: "1203@g.us" }),
    ).toMatchObject({
      agents: ["alice", "bob"],
      qualified: false,
      mentionGating: false,
      maxRounds: 1,
      maxTurns: 2,
    });
    expect(
      resolveGroupThreadConfig({ cfg: legacy, channel: "telegram", peerId: "1203@g.us" }),
    ).toBeUndefined();
  });
});
