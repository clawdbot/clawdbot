import { afterEach, describe, expect, it } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { formatDurationCompact } from "../../infra/format-time/format-duration.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { TemplateContext } from "../templating.js";
import { buildThreadingToolContext } from "./agent-runner-utils.js";
import { applyReplyThreading } from "./reply-payloads.js";
import {
  formatRunLabel,
  formatRunStatus,
  resolveSubagentLabel,
  sortSubagentRuns,
} from "./subagents-utils.js";

function createSlackThreadingPlugin(): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
    threading: {
      buildToolContext: ({ context }) => ({
        currentChannelId: context.To?.replace(/^channel:/, ""),
        currentThreadTs:
          context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
        replyToMode: "all",
      }),
    },
  } as ChannelPlugin;
}

describe("buildThreadingToolContext", () => {
  const cfg = {} as OpenClawConfig;

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("uses the recipient id for WhatsApp without origin routing metadata", () => {
    const sessionCtx = {
      Provider: "whatsapp",
      From: "123@g.us",
      To: "+15550001",
    } as TemplateContext;

    const result = buildThreadingToolContext({
      sessionCtx,
      config: cfg,
      hasRepliedRef: undefined,
    });

    expect(result.currentChannelId).toBe("+15550001");
  });

  it("falls back to To for WhatsApp when From is missing", () => {
    const sessionCtx = {
      Provider: "whatsapp",
      To: "+15550001",
    } as TemplateContext;

    const result = buildThreadingToolContext({
      sessionCtx,
      config: cfg,
      hasRepliedRef: undefined,
    });

    expect(result.currentChannelId).toBe("+15550001");
  });

  it("uses the recipient id for other channels", () => {
    const sessionCtx = {
      Provider: "telegram",
      From: "user:42",
      To: "chat:99",
    } as TemplateContext;

    const result = buildThreadingToolContext({
      sessionCtx,
      config: cfg,
      hasRepliedRef: undefined,
    });

    expect(result.currentChannelId).toBe("chat:99");
  });

  it("uses raw signal direct targets for tool context without provider-specific normalization", () => {
    const sessionCtx = {
      Provider: "signal",
      ChatType: "direct",
      From: "signal:+15550001",
      To: "signal:+15550002",
    } as TemplateContext;

    const result = buildThreadingToolContext({
      sessionCtx,
      config: cfg,
      hasRepliedRef: undefined,
    });

    expect(result.currentChannelId).toBe("signal:+15550002");
  });

  it("keeps raw signal group ids for tool context", () => {
    const sessionCtx = {
      Provider: "signal",
      ChatType: "group",
      To: "signal:group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
    } as TemplateContext;

    const result = buildThreadingToolContext({
      sessionCtx,
      config: cfg,
      hasRepliedRef: undefined,
    });

    expect(result.currentChannelId).toBe(
      "signal:group:VWATOdKF2hc8zdOS76q9tb0+5BI522e03QLDAq/9yPg=",
    );
  });

  it("uses chat_id for iMessage direct chats without provider-specific normalization", () => {
    const sessionCtx = {
      Provider: "imessage",
      ChatType: "direct",
      From: "imessage:+15550001",
      To: "chat_id:12",
    } as TemplateContext;

    const result = buildThreadingToolContext({
      sessionCtx,
      config: cfg,
      hasRepliedRef: undefined,
    });

    expect(result.currentChannelId).toBe("chat_id:12");
  });

  it("uses chat_id for iMessage groups", () => {
    const sessionCtx = {
      Provider: "imessage",
      ChatType: "group",
      From: "imessage:group:7",
      To: "chat_id:7",
    } as TemplateContext;

    const result = buildThreadingToolContext({
      sessionCtx,
      config: cfg,
      hasRepliedRef: undefined,
    });

    expect(result.currentChannelId).toBe("chat_id:7");
  });

  it("uses raw Slack channel ids without implicit thread context", () => {
    const sessionCtx = {
      Provider: "slack",
      To: "channel:C1",
      MessageThreadId: "123.456",
    } as TemplateContext;

    const result = buildThreadingToolContext({
      sessionCtx,
      config: { channels: { slack: { replyToMode: "all" } } } as OpenClawConfig,
      hasRepliedRef: undefined,
    });

    expect(result.currentChannelId).toBe("channel:C1");
    expect(result.currentThreadTs).toBeUndefined();
  });

  it("uses Slack plugin threading context when the plugin registry is active", () => {
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "slack", plugin: createSlackThreadingPlugin(), source: "test" },
      ]),
    );
    const sessionCtx = {
      Provider: "slack",
      To: "channel:C1",
      MessageThreadId: "123.456",
    } as TemplateContext;

    const result = buildThreadingToolContext({
      sessionCtx,
      config: { channels: { slack: { replyToMode: "all" } } } as OpenClawConfig,
      hasRepliedRef: undefined,
    });

    expect(result.currentChannelId).toBe("C1");
    expect(result.currentThreadTs).toBe("123.456");
  });
});

describe("applyReplyThreading auto-threading", () => {
  it("sets replyToId to currentMessageId even without [[reply_to_current]] tag", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "Hello" }],
      replyToMode: "first",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBe("42");
  });

  it("threads only first payload when mode is 'first'", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "A" }, { text: "B" }],
      replyToMode: "first",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(2);
    expect(result[0].replyToId).toBe("42");
    expect(result[1].replyToId).toBeUndefined();
  });

  it("threads only first payload when mode is 'batched' and the turn is batched", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "A" }, { text: "B" }],
      replyToMode: "batched",
      currentMessageId: "42",
      replyThreading: { implicitCurrentMessage: "allow" },
    });

    expect(result).toHaveLength(2);
    expect(result[0].replyToId).toBe("42");
    expect(result[1].replyToId).toBeUndefined();
  });

  it("can disable implicit reply threading for the current turn", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "Hello" }],
      replyToMode: "batched",
      currentMessageId: "42",
      replyThreading: { implicitCurrentMessage: "deny" },
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBeUndefined();
  });

  it("still honors explicit reply tags when implicit reply threading is disabled", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "Hello [[reply_to_current]]" }],
      replyToMode: "batched",
      currentMessageId: "42",
      replyThreading: { implicitCurrentMessage: "deny" },
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBe("42");
  });

  it("threads all payloads when mode is 'all'", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "A" }, { text: "B" }],
      replyToMode: "all",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(2);
    expect(result[0].replyToId).toBe("42");
    expect(result[1].replyToId).toBe("42");
  });

  it("strips replyToId when mode is 'off'", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "A" }],
      replyToMode: "off",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBeUndefined();
  });

  it("does not bypass off mode for Slack when reply is implicit", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "A" }],
      replyToMode: "off",
      replyToChannel: "slack",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBeUndefined();
  });

  it("keeps explicit tags for Slack when off mode allows explicit tags", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "[[reply_to_current]]A" }],
      replyToMode: "off",
      replyToChannel: "slack",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBe("42");
    expect(result[0].replyToTag).toBe(true);
  });

  it("keeps explicit tags for Telegram when off mode is enabled", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "[[reply_to_current]]A" }],
      replyToMode: "off",
      replyToChannel: "telegram",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBe("42");
    expect(result[0].replyToTag).toBe(true);
  });

  it("resolves [[reply_to_current]] to currentMessageId when replyToMode is 'all'", () => {
    // Mattermost-style scenario: agent responds with [[reply_to_current]] and replyToMode
    // is "all". The tag should resolve to the inbound message id.
    const result = applyReplyThreading({
      payloads: [{ text: "[[reply_to_current]] some reply text" }],
      replyToMode: "all",
      currentMessageId: "mm-post-abc123",
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBe("mm-post-abc123");
    expect(result[0].replyToTag).toBe(true);
    expect(result[0].text).toBe("some reply text");
  });

  it("resolves [[reply_to:<id>]] to explicit id when replyToMode is 'all'", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "[[reply_to:mm-post-xyz789]] threaded reply" }],
      replyToMode: "all",
      currentMessageId: "mm-post-abc123",
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBe("mm-post-xyz789");
    expect(result[0].text).toBe("threaded reply");
  });

  it("prefers explicit reply_to over reply_to_current when both tags are present", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "hi [[reply_to_current]] [[reply_to:mm-post-xyz789]]" }],
      replyToMode: "all",
      currentMessageId: "mm-post-abc123",
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBe("mm-post-xyz789");
    expect(result[0].text).toBe("hi");
  });

  it("sets replyToId via implicit threading when replyToMode is 'all'", () => {
    // Even without explicit tags, replyToMode "all" should set replyToId
    // to currentMessageId for threading.
    const result = applyReplyThreading({
      payloads: [{ text: "hello" }],
      replyToMode: "all",
      currentMessageId: "mm-post-abc123",
    });

    expect(result).toHaveLength(1);
    expect(result[0].replyToId).toBe("mm-post-abc123");
  });
});

const baseRun: SubagentRunRecord = {
  runId: "run-1",
  childSessionKey: "agent:main:subagent:abc",
  requesterSessionKey: "agent:main:main",
  requesterDisplayKey: "main",
  task: "do thing",
  cleanup: "keep",
  createdAt: 1000,
  startedAt: 1000,
};

describe("subagents utils", () => {
  it("resolves labels from label, task, or fallback", () => {
    expect(resolveSubagentLabel({ ...baseRun, label: "Label" })).toBe("Label");
    expect(resolveSubagentLabel({ ...baseRun, label: " ", task: "Task" })).toBe("Task");
    expect(resolveSubagentLabel({ ...baseRun, label: " ", task: " " }, "fallback")).toBe(
      "fallback",
    );
  });

  it("formats run labels with truncation", () => {
    const long = "x".repeat(100);
    const run = { ...baseRun, label: long };
    const formatted = formatRunLabel(run, { maxLength: 10 });
    expect(formatted.startsWith("x".repeat(10))).toBe(true);
    expect(formatted.endsWith("…")).toBe(true);
  });

  it("sanitizes leaked internal runtime context from formatted run labels", () => {
    const run = {
      ...baseRun,
      label: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
    };

    expect(formatRunLabel(run)).toBe("subagent");
  });

  it("sorts subagent runs by newest start/created time", () => {
    const runs: SubagentRunRecord[] = [
      { ...baseRun, runId: "run-1", createdAt: 1000, startedAt: 1000 },
      { ...baseRun, runId: "run-2", createdAt: 1200, startedAt: 1200 },
      { ...baseRun, runId: "run-3", createdAt: 900 },
    ];
    const sorted = sortSubagentRuns(runs);
    expect(sorted.map((run) => run.runId)).toEqual(["run-2", "run-1", "run-3"]);
  });

  it("formats run status from outcome and timestamps", () => {
    expect(formatRunStatus({ ...baseRun })).toBe("running");
    expect(formatRunStatus({ ...baseRun, endedAt: 2000, outcome: { status: "ok" } })).toBe("done");
    expect(formatRunStatus({ ...baseRun, endedAt: 2000, outcome: { status: "timeout" } })).toBe(
      "timeout",
    );
  });

  it("formats duration compact for seconds and minutes", () => {
    expect(formatDurationCompact(45_000)).toBe("45s");
    expect(formatDurationCompact(65_000)).toBe("1m5s");
  });
});
