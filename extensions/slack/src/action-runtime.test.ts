// Slack tests cover action runtime plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackActionContext } from "./action-runtime.js";
import { handleSlackAction, slackActionRuntime } from "./action-runtime.js";
import { parseSlackBlocksInput } from "./blocks-input.js";
import { buildSlackThreadingToolContext } from "./threading-tool-context.js";

const originalSlackActionRuntime = { ...slackActionRuntime };
const deleteSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const downloadSlackFile = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const editSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const getSlackMemberInfo = vi.fn(async (..._args: unknown[]) => ({}));
const listSlackEmojis = vi.fn(async (..._args: unknown[]) => ({}));
const listSlackPins = vi.fn(async (..._args: unknown[]) => ({}));
const listSlackReactions = vi.fn(async (..._args: unknown[]) => ({}));
const pinSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const reactSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));
const readSlackMessages = vi.fn(async (..._args: unknown[]) => ({}));
const removeOwnSlackReactions = vi.fn(async (..._args: unknown[]) => ["thumbsup"]);
const removeSlackReaction = vi.fn(async (..._args: unknown[]) => ({}));
const resolveSlackConversationInfo = vi.fn(
  async (
    ..._args: unknown[]
  ): Promise<{
    type: "channel" | "group" | "dm" | "unknown";
    name?: string;
    user?: string;
  }> => ({ type: "channel" }),
);
const sendSlackMessage = vi.fn(async (..._args: unknown[]) => ({ channelId: "C123" }));
const unpinSlackMessage = vi.fn(async (..._args: unknown[]) => ({}));

describe("handleSlackAction", () => {
  function slackConfig(overrides?: Record<string, unknown>): OpenClawConfig {
    return {
      channels: {
        slack: {
          botToken: "tok",
          ...overrides,
        },
      },
    } as OpenClawConfig;
  }

  it("rejects all actions before Slack API work for an enterprise org account", async () => {
    await expect(
      handleSlackAction(
        { action: "readMessages", channelId: "C123" },
        slackConfig({ enterpriseOrgInstall: true }),
      ),
    ).rejects.toThrow(/unavailable for Enterprise Grid org installs/);
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  function createReplyToFirstContext(hasRepliedRef: { value: boolean }) {
    return {
      currentChannelId: "C123",
      currentThreadTs: "1111111111.111111",
      replyToMode: "first" as const,
      hasRepliedRef,
    };
  }

  function createReplyToFirstScenario() {
    const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
    sendSlackMessage.mockClear();
    const hasRepliedRef = { value: false };
    const context = createReplyToFirstContext(hasRepliedRef);
    return { cfg, context, hasRepliedRef };
  }

  function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null) {
      throw new Error(`${label} was not an object`);
    }
    return value as Record<string, unknown>;
  }

  function requireArray(value: unknown, label: string): unknown[] {
    expect(Array.isArray(value)).toBe(true);
    if (!Array.isArray(value)) {
      throw new Error(`${label} was not an array`);
    }
    return value;
  }

  function requireMockCall(
    source: { mock: { calls: unknown[][] } },
    label: string,
    index = 0,
  ): unknown[] {
    const call = source.mock.calls[index];
    if (!call) {
      throw new Error(`missing ${label} call ${index + 1}`);
    }
    return call;
  }

  function requireMockArg(
    source: { mock: { calls: unknown[][] } },
    label: string,
    callIndex: number,
    argIndex: number,
  ): unknown {
    return requireMockCall(source, label, callIndex)[argIndex];
  }

  function requireRecordArg(
    source: { mock: { calls: unknown[][] } },
    label: string,
    callIndex: number,
    argIndex: number,
  ): Record<string, unknown> {
    return requireRecord(
      requireMockArg(source, label, callIndex, argIndex),
      `${label} call ${callIndex + 1} argument ${argIndex + 1}`,
    );
  }

  function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
    for (const [key, value] of Object.entries(fields)) {
      expect(record[key]).toEqual(value);
    }
  }

  function requireSlackSendCall(index: number) {
    const call = sendSlackMessage.mock.calls[index] as unknown[] | undefined;
    if (!call) {
      throw new Error(`missing Slack send call ${index + 1}`);
    }
    return call;
  }

  function expectSlackSendCall(
    index: number,
    target: string,
    content: string,
    optionFields: Record<string, unknown>,
  ) {
    const [actualTarget, actualContent, options] = requireSlackSendCall(index);
    expect(actualTarget).toBe(target);
    expect(actualContent).toBe(content);
    expectRecordFields(requireRecord(options, "Slack send options"), optionFields);
    return requireRecord(options, "Slack send options");
  }

  function expectLastSlackSend(content: string, cfg: OpenClawConfig, threadTs?: string) {
    expectSlackSendCall(sendSlackMessage.mock.calls.length - 1, "channel:C123", content, {
      cfg,
      mediaUrl: undefined,
      threadTs,
      blocks: undefined,
    });
  }

  function requireDetails(result: Awaited<ReturnType<typeof handleSlackAction>>) {
    return requireRecord(result.details, "action result details");
  }

  async function sendSecondMessageAndExpectNoThread(params: {
    cfg: OpenClawConfig;
    context: SlackActionContext;
  }) {
    await handleSlackAction(
      { action: "sendMessage", to: "channel:C123", content: "Second" },
      params.cfg,
      params.context,
    );
    expectLastSlackSend("Second", params.cfg);
  }

  it("fails closed for same-channel sends from thread-required contexts with no thread ts", async () => {
    const cfg = slackConfig();
    sendSlackMessage.mockClear();

    await expect(
      handleSlackAction(
        { action: "sendMessage", to: "channel:C123", content: "keep private" },
        cfg,
        {
          currentChannelId: "C123",
          replyToMode: "all",
          sameChannelThreadRequired: true,
        },
      ),
    ).rejects.toThrow("Slack thread context is required");
    expect(sendSlackMessage).not.toHaveBeenCalled();
  });

  it("allows explicit top-level sends from thread-required contexts", async () => {
    const cfg = slackConfig();
    sendSlackMessage.mockClear();

    await handleSlackAction(
      { action: "sendMessage", to: "channel:C123", content: "root", topLevel: true },
      cfg,
      {
        currentChannelId: "C123",
        replyToMode: "all",
        sameChannelThreadRequired: true,
      },
    );

    expectLastSlackSend("root", cfg);
  });

  it("forwards preformatted Slack fallback text without reparsing", async () => {
    const cfg = slackConfig();

    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "- Account: &lt;@U123&gt;",
        mediaUrl: "https://example.com/report.csv",
        textIsSlackMrkdwn: true,
      },
      cfg,
    );

    expectSlackSendCall(0, "channel:C123", "- Account: &lt;@U123&gt;", {
      cfg,
      mediaUrl: "https://example.com/report.csv",
      textIsSlackMrkdwn: true,
      blocks: undefined,
    });
    expect(sendSlackMessage).toHaveBeenCalledOnce();
  });

  async function resolveReadToken(cfg: OpenClawConfig): Promise<string | undefined> {
    readSlackMessages.mockClear();
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });
    await handleSlackAction({ action: "readMessages", channelId: "C1" }, cfg);
    const token = requireRecordArg(readSlackMessages, "readSlackMessages", 0, 1).token;
    return typeof token === "string" ? token : undefined;
  }

  async function resolveSendToken(cfg: OpenClawConfig): Promise<string | undefined> {
    sendSlackMessage.mockClear();
    await handleSlackAction({ action: "sendMessage", to: "channel:C1", content: "Hello" }, cfg);
    const token = requireRecordArg(sendSlackMessage, "sendSlackMessage", 0, 2).token;
    return typeof token === "string" ? token : undefined;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resolveSlackConversationInfo.mockReset().mockResolvedValue({ type: "channel" });
    Object.assign(slackActionRuntime, originalSlackActionRuntime, {
      deleteSlackMessage,
      downloadSlackFile,
      editSlackMessage,
      getSlackMemberInfo,
      listSlackEmojis,
      listSlackPins,
      listSlackReactions,
      parseSlackBlocksInput,
      pinSlackMessage,
      reactSlackMessage,
      readSlackMessages,
      removeOwnSlackReactions,
      removeSlackReaction,
      resolveSlackConversationInfo,
      sendSlackMessage,
      unpinSlackMessage,
    });
  });

  it.each([
    { name: "raw channel id", channelId: "C1", expectedChannelId: "C1" },
    { name: "channel: prefixed id", channelId: "channel:C1", expectedChannelId: "C1" },
    {
      name: "folded channel id",
      channelId: "channel:c08gqh53ejm",
      expectedChannelId: "C08GQH53EJM",
    },
  ])("adds reactions for $name", async ({ channelId, expectedChannelId }) => {
    const cfg = slackConfig();
    const result = await handleSlackAction(
      {
        action: "react",
        channelId,
        messageId: "123.456",
        emoji: "✅",
      },
      cfg,
    );
    expect(reactSlackMessage).toHaveBeenCalledWith(expectedChannelId, "123.456", "✅", { cfg });
    expect(JSON.parse((result.content[0] as { type: "text"; text: string }).text)).toEqual({
      ok: true,
      added: "✅",
    });
  });

  it("removes reactions on empty emoji", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "react",
        channelId: "C1",
        messageId: "123.456",
        emoji: "",
      },
      cfg,
    );
    expect(removeOwnSlackReactions).toHaveBeenCalledWith("C1", "123.456", { cfg });
  });

  it("rejects reaction clearing outside allowlisted Slack channels", async () => {
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      channels: {
        C_ALLOWED: { enabled: true },
      },
    });

    await expect(
      handleSlackAction(
        {
          action: "react",
          channelId: "C_OTHER",
          messageId: "123.456",
          emoji: "",
        },
        cfg,
      ),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(removeOwnSlackReactions).not.toHaveBeenCalled();
  });

  it("removes reactions when remove flag set", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "react",
        channelId: "C1",
        messageId: "123.456",
        emoji: "✅",
        remove: true,
      },
      cfg,
    );
    expect(removeSlackReaction).toHaveBeenCalledWith("C1", "123.456", "✅", { cfg });
  });

  it("rejects removes without emoji", async () => {
    await expect(
      handleSlackAction(
        {
          action: "react",
          channelId: "C1",
          messageId: "123.456",
          emoji: "",
          remove: true,
        },
        slackConfig(),
      ),
    ).rejects.toThrow(/Emoji is required/);
  });

  it("respects reaction gating", async () => {
    await expect(
      handleSlackAction(
        {
          action: "react",
          channelId: "C1",
          messageId: "123.456",
          emoji: "✅",
        },
        slackConfig({ actions: { reactions: false } }),
      ),
    ).rejects.toThrow(/Slack reactions are disabled/);
  });

  it("rejects Slack reaction reads for non-allowlisted target channels", async () => {
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      channels: {
        C_ALLOWED: { enabled: true },
      },
    });

    await expect(
      handleSlackAction({ action: "reactions", channelId: "C_OTHER", messageId: "123.456" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(listSlackReactions).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "reaction add",
      params: { action: "react", emoji: "✅" },
      providerCall: reactSlackMessage,
    },
    {
      name: "reaction removal",
      params: { action: "react", emoji: "✅", remove: true },
      providerCall: removeSlackReaction,
    },
    {
      name: "message edit",
      params: { action: "editMessage", content: "updated" },
      providerCall: editSlackMessage,
    },
    {
      name: "message deletion",
      params: { action: "deleteMessage" },
      providerCall: deleteSlackMessage,
    },
    {
      name: "pin",
      params: { action: "pinMessage" },
      providerCall: pinSlackMessage,
    },
    {
      name: "unpin",
      params: { action: "unpinMessage" },
      providerCall: unpinSlackMessage,
    },
  ])("rejects blocked Slack $name before mutation", async ({ params, providerCall }) => {
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      channels: {
        C_ALLOWED: { enabled: true },
      },
    });

    await expect(
      handleSlackAction(
        {
          channelId: "C_BLOCKED",
          messageId: "123.456",
          ...params,
        },
        cfg,
      ),
    ).rejects.toThrow("Slack read target channel is not allowed.");

    expect(providerCall).not.toHaveBeenCalled();
  });

  it("allows a delegated read of the exact current Slack channel and account", async () => {
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      channels: {
        C_ALLOWED: { enabled: true },
      },
    });

    await handleSlackAction(
      {
        action: "reactions",
        channelId: "C_CURRENT",
        messageId: "123.456",
      },
      cfg,
      {
        requesterAccountId: "DEFAULT",
        currentChannelProvider: "Slack",
        currentChannelId: "C_CURRENT",
      },
    );

    expect(listSlackReactions).toHaveBeenCalledWith("C_CURRENT", "123.456", { cfg });
  });

  it("does not borrow current Slack visibility from another account", async () => {
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      channels: {
        C_ALLOWED: { enabled: true },
      },
    });

    await expect(
      handleSlackAction(
        {
          action: "reactions",
          channelId: "C_CURRENT",
          messageId: "123.456",
        },
        cfg,
        {
          requesterAccountId: "other",
          currentChannelProvider: "slack",
          currentChannelId: "C_CURRENT",
        },
      ),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(listSlackReactions).not.toHaveBeenCalled();
  });

  it("allows delegated member info for the current Slack requester and account", async () => {
    const cfg = slackConfig();

    await handleSlackAction({ action: "memberInfo", userId: "U123" }, cfg, {
      conversationReadOrigin: "delegated",
      requesterAccountId: "DEFAULT",
      requesterSenderId: "u123",
      currentChannelProvider: "Slack",
    });

    expect(getSlackMemberInfo).toHaveBeenCalledWith("U123", { cfg });
  });

  it.each([
    {
      name: "another user",
      context: {
        conversationReadOrigin: "delegated" as const,
        requesterAccountId: "default",
        requesterSenderId: "U123",
        currentChannelProvider: "slack",
      },
      userId: "U999",
    },
    {
      name: "another account",
      context: {
        conversationReadOrigin: "delegated" as const,
        requesterAccountId: "other",
        requesterSenderId: "U123",
        currentChannelProvider: "slack",
      },
      userId: "U123",
    },
    {
      name: "another provider",
      context: {
        conversationReadOrigin: "delegated" as const,
        requesterAccountId: "default",
        requesterSenderId: "U123",
        currentChannelProvider: "telegram",
      },
      userId: "U123",
    },
    {
      name: "missing trusted context",
      context: undefined,
      userId: "U123",
    },
  ])("rejects delegated member info for $name before provider access", async (testCase) => {
    await expect(
      handleSlackAction(
        { action: "memberInfo", userId: testCase.userId },
        slackConfig(),
        testCase.context,
      ),
    ).rejects.toThrow("Delegated Slack member info is limited to the current requester.");

    expect(getSlackMemberInfo).not.toHaveBeenCalled();
  });

  it("allows a direct operator to inspect another Slack member", async () => {
    const cfg = slackConfig();

    await handleSlackAction({ action: "memberInfo", userId: "U999" }, cfg, {
      conversationReadOrigin: "direct-operator",
    });

    expect(getSlackMemberInfo).toHaveBeenCalledWith("U999", { cfg });
  });

  it("keeps explicitly disabled current Slack channels blocked", async () => {
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      channels: {
        C_CURRENT: { enabled: false },
      },
    });

    await expect(
      handleSlackAction(
        {
          action: "reactions",
          channelId: "C_CURRENT",
          messageId: "123.456",
        },
        cfg,
        {
          requesterAccountId: "default",
          currentChannelProvider: "slack",
          currentChannelId: "C_CURRENT",
        },
      ),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(resolveSlackConversationInfo).not.toHaveBeenCalled();
    expect(listSlackReactions).not.toHaveBeenCalled();
  });

  it("lets a direct operator read an unconfigured Slack channel", async () => {
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      channels: {
        C_ALLOWED: { enabled: true },
      },
    });

    await handleSlackAction(
      {
        action: "reactions",
        channelId: "C_OTHER",
        messageId: "123.456",
      },
      cfg,
      { conversationReadOrigin: "direct-operator" },
    );

    expect(listSlackReactions).toHaveBeenCalledWith("C_OTHER", "123.456", { cfg });
    expect(resolveSlackConversationInfo).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      channelId: "C_OTHER",
      operation: "read",
    });
  });

  it("keeps name-disabled Slack channels blocked for direct operators", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({
      type: "channel",
      name: "blocked-channel",
    });
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      dangerouslyAllowNameMatching: true,
      channels: {
        "#blocked-channel": { enabled: false },
      },
    });

    await expect(
      handleSlackAction(
        {
          action: "reactions",
          channelId: "C_BLOCKED",
          messageId: "123.456",
        },
        cfg,
        { conversationReadOrigin: "direct-operator" },
      ),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(resolveSlackConversationInfo).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      channelId: "C_BLOCKED",
      operation: "read",
      requireFreshName: true,
    });
    expect(listSlackReactions).not.toHaveBeenCalled();
  });

  it("keeps wildcard-disabled Slack channels blocked for direct operators", async () => {
    const cfg = slackConfig({
      groupPolicy: "open",
      channels: {
        "*": { enabled: false },
      },
    });

    await expect(
      handleSlackAction(
        {
          action: "reactions",
          channelId: "C_BLOCKED",
          messageId: "123.456",
        },
        cfg,
        { conversationReadOrigin: "direct-operator" },
      ),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(resolveSlackConversationInfo).not.toHaveBeenCalled();
    expect(listSlackReactions).not.toHaveBeenCalled();
  });

  it("lets an explicit name allow override a wildcard denial for direct operators", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({
      type: "channel",
      name: "allowed-channel",
    });
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      dangerouslyAllowNameMatching: true,
      channels: {
        "*": { enabled: false },
        "#allowed-channel": { enabled: true },
      },
    });

    await handleSlackAction(
      {
        action: "reactions",
        channelId: "C_ALLOWED",
        messageId: "123.456",
      },
      cfg,
      { conversationReadOrigin: "direct-operator" },
    );

    expect(listSlackReactions).toHaveBeenCalledWith("C_ALLOWED", "123.456", { cfg });
  });

  it("does not make direct reads depend on unrelated named allows", async () => {
    const cfg = slackConfig({
      groupPolicy: "open",
      dangerouslyAllowNameMatching: true,
      channels: {
        "#announcements": { enabled: true },
      },
      dm: { groupEnabled: true },
    });

    await handleSlackAction(
      {
        action: "reactions",
        channelId: "C_OTHER",
        messageId: "123.456",
      },
      cfg,
      { conversationReadOrigin: "direct-operator" },
    );

    expect(resolveSlackConversationInfo).not.toHaveBeenCalled();
    expect(listSlackReactions).toHaveBeenCalledWith("C_OTHER", "123.456", { cfg });
  });

  it("does not bypass a wildcard denial when Slack name lookup is unresolved", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({ type: "unknown" });
    const cfg = slackConfig({
      groupPolicy: "open",
      dangerouslyAllowNameMatching: true,
      channels: {
        "*": { enabled: false },
        "#allowed-channel": { enabled: true },
      },
      dm: { groupEnabled: true },
    });

    await expect(
      handleSlackAction(
        {
          action: "reactions",
          channelId: "C_UNRESOLVED",
          messageId: "123.456",
        },
        cfg,
        { conversationReadOrigin: "direct-operator" },
      ),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(listSlackReactions).not.toHaveBeenCalled();
  });

  it("does not bypass a name denial when Slack metadata lookup is unresolved", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({ type: "unknown" });
    const cfg = slackConfig({
      groupPolicy: "open",
      dangerouslyAllowNameMatching: true,
      channels: {
        "#blocked-channel": { enabled: false },
      },
      dm: { groupEnabled: true },
    });

    await expect(
      handleSlackAction(
        {
          action: "reactions",
          channelId: "C_UNRESOLVED",
          messageId: "123.456",
        },
        cfg,
      ),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(listSlackReactions).not.toHaveBeenCalled();
  });

  it("lets a direct operator read a DM when group reads are disabled", async () => {
    const cfg = slackConfig({
      groupPolicy: "disabled",
      dmPolicy: "pairing",
    });

    await handleSlackAction(
      {
        action: "reactions",
        channelId: "D_OTHER",
        messageId: "123.456",
      },
      cfg,
      { conversationReadOrigin: "direct-operator" },
    );

    expect(listSlackReactions).toHaveBeenCalledWith("D_OTHER", "123.456", { cfg });
    expect(resolveSlackConversationInfo).not.toHaveBeenCalled();
  });

  it("lets a delegated model read its current Slack DM", async () => {
    const cfg = slackConfig({
      groupPolicy: "disabled",
      dmPolicy: "pairing",
    });

    await handleSlackAction(
      {
        action: "reactions",
        channelId: "D_CURRENT",
        messageId: "123.456",
      },
      cfg,
      {
        conversationReadOrigin: "delegated",
        requesterAccountId: "default",
        currentChannelProvider: "slack",
        currentChannelId: "D_CURRENT",
      },
    );

    expect(listSlackReactions).toHaveBeenCalledWith("D_CURRENT", "123.456", { cfg });
    expect(resolveSlackConversationInfo).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "allowFrom peer",
      overrides: { dmPolicy: "allowlist", allowFrom: ["slack:U0ALLOWED"] },
    },
    {
      name: "per-DM peer",
      overrides: { dmPolicy: "pairing", dms: { U0ALLOWED: { historyLimit: 5 } } },
    },
    {
      name: "default target peer",
      overrides: { dmPolicy: "pairing", defaultTo: "user:U0ALLOWED" },
    },
  ])(
    "lets a delegated model read an explicitly configured Slack DM via $name",
    async (testCase) => {
      resolveSlackConversationInfo.mockResolvedValueOnce({ type: "dm", user: "U0ALLOWED" });
      const cfg = slackConfig(testCase.overrides);

      await handleSlackAction(
        {
          action: "reactions",
          channelId: "D_ALLOWED",
          messageId: "123.456",
        },
        cfg,
        { conversationReadOrigin: "delegated" },
      );

      expect(resolveSlackConversationInfo).toHaveBeenCalledOnce();
      expect(listSlackReactions).toHaveBeenCalledWith("D_ALLOWED", "123.456", { cfg });
    },
  );

  it("blocks an unconfigured delegated Slack DM before provider content access", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({ type: "dm", user: "U0OTHER01" });
    const cfg = slackConfig({
      dmPolicy: "pairing",
    });

    await expect(
      handleSlackAction(
        {
          action: "reactions",
          channelId: "D_OTHER",
          messageId: "123.456",
        },
        cfg,
        { conversationReadOrigin: "delegated" },
      ),
    ).rejects.toThrow("Slack read target channel is not allowed.");

    expect(resolveSlackConversationInfo).toHaveBeenCalledOnce();
    expect(listSlackReactions).not.toHaveBeenCalled();
  });

  it("does not treat an open-DM wildcard as a configured read target", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({ type: "dm", user: "U0OTHER01" });
    const cfg = slackConfig({
      dmPolicy: "open",
      allowFrom: ["*"],
    });

    await expect(
      handleSlackAction(
        {
          action: "reactions",
          channelId: "D_OTHER",
          messageId: "123.456",
        },
        cfg,
        { conversationReadOrigin: "delegated" },
      ),
    ).rejects.toThrow("Slack read target channel is not allowed.");

    expect(listSlackReactions).not.toHaveBeenCalled();
  });

  it("fails closed when Slack cannot resolve a delegated DM peer", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({ type: "dm" });
    const cfg = slackConfig({
      dmPolicy: "allowlist",
      allowFrom: ["U0ALLOWED"],
    });

    await expect(
      handleSlackAction(
        {
          action: "reactions",
          channelId: "D_UNKNOWN",
          messageId: "123.456",
        },
        cfg,
        { conversationReadOrigin: "delegated" },
      ),
    ).rejects.toThrow("Slack read target channel is not allowed.");

    expect(listSlackReactions).not.toHaveBeenCalled();
  });

  it("lets a direct operator read an enabled Slack group DM", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({ type: "group" });
    const cfg = slackConfig({
      groupPolicy: "disabled",
      dm: {
        groupEnabled: true,
        groupChannels: ["G_ALLOWED"],
      },
    });

    await handleSlackAction(
      {
        action: "reactions",
        channelId: "G_ALLOWED",
        messageId: "123.456",
      },
      cfg,
      { conversationReadOrigin: "direct-operator" },
    );

    expect(listSlackReactions).toHaveBeenCalledWith("G_ALLOWED", "123.456", { cfg });
  });

  it("blocks a C-prefixed MPIM when direct group-DM reads are disabled", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({ type: "group" });
    const cfg = slackConfig({
      groupPolicy: "open",
      dm: { groupEnabled: false },
    });

    await expect(
      handleSlackAction(
        {
          action: "reactions",
          channelId: "C_MPIM",
          messageId: "123.456",
        },
        cfg,
        { conversationReadOrigin: "direct-operator" },
      ),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(listSlackReactions).not.toHaveBeenCalled();
  });

  it("blocks a C-prefixed MPIM from delegated channel allowlists", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({ type: "group" });
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      channels: {
        C_MPIM: { enabled: true },
      },
      dm: { groupEnabled: false },
    });

    await expect(
      handleSlackAction(
        {
          action: "reactions",
          channelId: "C_MPIM",
          messageId: "123.456",
        },
        cfg,
      ),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(listSlackReactions).not.toHaveBeenCalled();
  });

  it("rejects unknown Slack topology unless both possible read policies allow it", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({ type: "unknown" });
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      channels: {
        C_AMBIGUOUS: { enabled: true },
      },
      dm: { groupEnabled: false },
    });

    await expect(
      handleSlackAction(
        {
          action: "reactions",
          channelId: "C_AMBIGUOUS",
          messageId: "123.456",
        },
        cfg,
      ),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(listSlackReactions).not.toHaveBeenCalled();
  });

  it("allows unknown Slack topology when both possible read policies allow it", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({ type: "unknown" });
    const cfg = slackConfig({
      groupPolicy: "open",
      dm: { groupEnabled: true },
    });

    await handleSlackAction(
      {
        action: "reactions",
        channelId: "C_AMBIGUOUS",
        messageId: "123.456",
      },
      cfg,
    );

    expect(listSlackReactions).toHaveBeenCalledWith("C_AMBIGUOUS", "123.456", { cfg });
  });

  it.each([
    {
      name: "disabled scope",
      overrides: { groupPolicy: "disabled" },
      channelId: "C_OTHER",
      channelType: undefined,
    },
    {
      name: "explicitly disabled channel",
      overrides: {
        groupPolicy: "allowlist",
        channels: { C_BLOCKED: { enabled: false } },
      },
      channelId: "C_BLOCKED",
      channelType: undefined,
    },
    {
      name: "disabled DM scope",
      overrides: {
        groupPolicy: "open",
        dmPolicy: "disabled",
      },
      channelId: "D_BLOCKED",
      channelType: undefined,
    },
    {
      name: "disabled group DM scope",
      overrides: {
        groupPolicy: "open",
        dm: { groupEnabled: false },
      },
      channelId: "G_BLOCKED",
      channelType: "group" as const,
    },
  ])("keeps $name blocked for direct operators", async ({ overrides, channelId, channelType }) => {
    if (channelType) {
      resolveSlackConversationInfo.mockResolvedValueOnce({ type: channelType });
    }
    await expect(
      handleSlackAction(
        {
          action: "reactions",
          channelId,
          messageId: "123.456",
        },
        slackConfig(overrides),
        { conversationReadOrigin: "direct-operator" },
      ),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(listSlackReactions).not.toHaveBeenCalled();
  });

  it("passes threadTs to sendSlackMessage for thread replies", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Hello thread",
        threadTs: "1234567890.123456",
      },
      cfg,
    );
    expectSlackSendCall(0, "channel:C123", "Hello thread", {
      cfg,
      mediaUrl: undefined,
      threadTs: "1234567890.123456",
      blocks: undefined,
    });
  });

  it("passes replyBroadcast to sendSlackMessage for thread replies", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Hello thread",
        threadTs: "1234567890.123456",
        replyBroadcast: true,
      },
      cfg,
    );
    expectSlackSendCall(0, "channel:C123", "Hello thread", {
      cfg,
      mediaUrl: undefined,
      threadTs: "1234567890.123456",
      replyBroadcast: true,
      blocks: undefined,
    });
  });

  it("returns a friendly error when downloadFile cannot fetch the attachment", async () => {
    downloadSlackFile.mockResolvedValueOnce(null);
    const result = await handleSlackAction(
      {
        action: "downloadFile",
        fileId: "F123",
        channelId: "C1",
      },
      slackConfig(),
    );
    expect(requireMockArg(downloadSlackFile, "downloadSlackFile", 0, 0)).toBe("F123");
    expect(requireRecordArg(downloadSlackFile, "downloadSlackFile", 0, 1).maxBytes).toBe(
      20 * 1024 * 1024,
    );
    expect(requireDetails(result).ok).toBe(false);
  });

  it("fails closed for downloadFile when no channel target can be authorized", async () => {
    await expect(
      handleSlackAction({ action: "downloadFile", fileId: "F123" }, slackConfig()),
    ).rejects.toThrow(
      "Slack file download requires channelId or to so the read target can be authorized.",
    );
    expect(downloadSlackFile).not.toHaveBeenCalled();
  });

  it("uses current channel context to authorize downloadFile", async () => {
    downloadSlackFile.mockResolvedValueOnce(null);
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      channels: {
        C1: { enabled: true },
      },
    });

    const result = await handleSlackAction({ action: "downloadFile", fileId: "F123" }, cfg, {
      currentChannelId: "C1",
    });

    expectRecordFields(requireRecordArg(downloadSlackFile, "downloadSlackFile", 0, 1), {
      channelId: "C1",
    });
    expect(requireDetails(result).ok).toBe(false);
  });

  it("passes download scope (channel/thread) to downloadSlackFile", async () => {
    downloadSlackFile.mockResolvedValueOnce(null);

    const result = await handleSlackAction(
      {
        action: "downloadFile",
        fileId: "F123",
        to: "channel:C1",
        replyTo: "123.456",
      },
      slackConfig(),
    );

    expect(requireMockArg(downloadSlackFile, "downloadSlackFile", 0, 0)).toBe("F123");
    expectRecordFields(requireRecordArg(downloadSlackFile, "downloadSlackFile", 0, 1), {
      channelId: "C1",
      threadId: "123.456",
    });
    expect(requireDetails(result).ok).toBe(false);
  });

  it("returns non-image downloadFile results as file metadata instead of image content", async () => {
    downloadSlackFile.mockResolvedValueOnce({
      path: "/tmp/openclaw-media/report.pdf",
      contentType: "application/pdf",
      placeholder: "[Slack file: report.pdf (fileId: F123)]",
    });

    const result = await handleSlackAction(
      {
        action: "downloadFile",
        fileId: "F123",
        channelId: "C1",
      },
      slackConfig(),
    );

    expect(result.content).toHaveLength(1);
    const firstContent = requireRecord(result.content[0], "first content item");
    expect(firstContent.type).toBe("text");
    expect(String(firstContent.text)).toContain("/tmp/openclaw-media/report.pdf");
    expect(result.content.map((entry) => entry.type)).not.toContain("image");
    const details = requireDetails(result);
    expectRecordFields(details, {
      ok: true,
      fileId: "F123",
      path: "/tmp/openclaw-media/report.pdf",
      contentType: "application/pdf",
    });
    expect(details.media).toEqual({
      mediaUrl: "/tmp/openclaw-media/report.pdf",
      outbound: false,
      contentType: "application/pdf",
    });
  });

  it("forwards resolved botToken to action functions instead of relying on config re-read", async () => {
    downloadSlackFile.mockResolvedValueOnce(null);
    await handleSlackAction(
      { action: "downloadFile", fileId: "F123", channelId: "C1" },
      slackConfig(),
    );
    expect(requireRecordArg(downloadSlackFile, "downloadSlackFile", 0, 1).token).toBe("tok");
  });

  it("keeps resolved userToken for downloadFile reads when configured", async () => {
    downloadSlackFile.mockResolvedValueOnce(null);
    await handleSlackAction(
      { action: "downloadFile", fileId: "F123", channelId: "C1" },
      slackConfig({
        accounts: {
          default: {
            botToken: "xoxb-bot",
            userToken: "xoxp-user",
          },
        },
      }),
    );
    expect(requireRecordArg(downloadSlackFile, "downloadSlackFile", 0, 1).token).toBe("xoxp-user");
  });

  it.each([
    {
      name: "JSON blocks",
      blocks: JSON.stringify([
        { type: "section", text: { type: "mrkdwn", text: "*Deploy* status" } },
      ]),
      expectedBlocks: [{ type: "section", text: { type: "mrkdwn", text: "*Deploy* status" } }],
    },
    {
      name: "array blocks",
      blocks: [{ type: "divider" }],
      expectedBlocks: [{ type: "divider" }],
    },
  ])("accepts $name and allows empty content", async ({ blocks, expectedBlocks }) => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "",
        blocks,
      },
      cfg,
    );
    expectSlackSendCall(0, "channel:C123", "", {
      cfg,
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: expectedBlocks,
    });
  });

  it.each([
    {
      name: "invalid blocks JSON",
      blocks: "{not json",
      expectedError: /blocks must be valid JSON/i,
    },
    { name: "empty blocks arrays", blocks: "[]", expectedError: /at least one block/i },
  ])("rejects $name", async ({ blocks, expectedError }) => {
    await expect(
      handleSlackAction(
        {
          action: "sendMessage",
          to: "channel:C123",
          content: "",
          blocks,
        },
        slackConfig(),
      ),
    ).rejects.toThrow(expectedError);
  });

  it("requires at least one of content, blocks, or mediaUrl", async () => {
    await expect(
      handleSlackAction(
        {
          action: "sendMessage",
          to: "channel:C123",
          content: "",
        },
        slackConfig(),
      ),
    ).rejects.toThrow(/requires content, blocks, or mediaUrl/i);
  });

  it("routes uploadFile through sendSlackMessage with upload metadata", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "uploadFile",
        to: "user:U123",
        filePath: "/tmp/report.png",
        initialComment: "fresh report",
        filename: "report-final.png",
        title: "Report Final",
        threadTs: "111.222",
      },
      cfg,
    );

    expectSlackSendCall(0, "user:U123", "fresh report", {
      cfg,
      mediaUrl: "/tmp/report.png",
      threadTs: "111.222",
      uploadFileName: "report-final.png",
      uploadTitle: "Report Final",
    });
  });

  it("rejects replyBroadcast for uploadFile", async () => {
    await expect(
      handleSlackAction(
        {
          action: "uploadFile",
          to: "channel:C123",
          filePath: "/tmp/report.txt",
          threadTs: "111.222",
          replyBroadcast: true,
        },
        slackConfig(),
      ),
    ).rejects.toThrow(/replyBroadcast is only supported for text or block thread replies/i);
  });

  it("sends media before a separate blocks message", async () => {
    sendSlackMessage.mockResolvedValueOnce({ channelId: "C123" });
    sendSlackMessage.mockResolvedValueOnce({ channelId: "C123" });

    const cfg = slackConfig();
    const result = await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "hello",
        mediaUrl: "https://example.com/file.png",
        blocks: JSON.stringify([{ type: "divider" }]),
      },
      cfg,
    );

    expect(sendSlackMessage).toHaveBeenCalledTimes(2);
    expectSlackSendCall(0, "channel:C123", "", {
      cfg,
      mediaUrl: "https://example.com/file.png",
      threadTs: undefined,
    });
    expect(requireRecordArg(sendSlackMessage, "sendSlackMessage", 0, 2)).not.toHaveProperty(
      "blocks",
    );
    expectSlackSendCall(1, "channel:C123", "hello", {
      cfg,
      blocks: [{ type: "divider" }],
      threadTs: undefined,
    });
    expect(requireRecordArg(sendSlackMessage, "sendSlackMessage", 1, 2)).not.toHaveProperty(
      "mediaUrl",
    );
    expect(result.details).toEqual({
      ok: true,
      result: { channelId: "C123" },
    });
  });

  it("keeps oversized text and native blocks in the same resolved thread", async () => {
    const cfg = slackConfig({ replyToMode: "first" });
    const hasRepliedRef = { value: false };
    const context = createReplyToFirstContext(hasRepliedRef);
    const content = "x".repeat(8001);
    const blocks = [{ type: "divider" }];
    sendSlackMessage.mockResolvedValueOnce({ channelId: "content" });

    const result = await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content,
        blocks,
        replyBroadcast: true,
      },
      cfg,
      context,
    );

    expect(sendSlackMessage).toHaveBeenCalledOnce();
    expectSlackSendCall(0, "channel:C123", content, {
      cfg,
      blocks,
      replyBroadcast: true,
      separateTextAndBlocks: true,
      threadTs: "1111111111.111111",
    });
    expect(hasRepliedRef.value).toBe(true);
    expect(result.details).toEqual({
      ok: true,
      result: { channelId: "content" },
    });
  });

  it("separates explicitly marked short text from native blocks", async () => {
    const cfg = slackConfig();
    const content = "Short portable table fallback";
    const blocks = [{ type: "divider" }];

    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content,
        blocks,
        separateTextAndBlocks: true,
      },
      cfg,
    );

    expect(sendSlackMessage).toHaveBeenCalledOnce();
    expectSlackSendCall(0, "channel:C123", content, {
      cfg,
      blocks,
      separateTextAndBlocks: true,
      threadTs: undefined,
    });
  });

  it.each([
    {
      name: "JSON blocks",
      blocks: JSON.stringify([{ type: "divider" }]),
      expectedBlocks: [{ type: "divider" }],
    },
    {
      name: "array blocks",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
      expectedBlocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
    },
  ])("passes $name to editSlackMessage", async ({ blocks, expectedBlocks }) => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "editMessage",
        channelId: "C123",
        messageId: "123.456",
        content: "",
        blocks,
      },
      cfg,
    );
    const editCall = requireMockCall(editSlackMessage, "editSlackMessage");
    expect(editCall[0]).toBe("C123");
    expect(editCall[1]).toBe("123.456");
    expect(editCall[2]).toBe("");
    expectRecordFields(requireRecordArg(editSlackMessage, "editSlackMessage", 0, 3), {
      cfg,
      blocks: expectedBlocks,
    });
  });

  it("requires content or blocks for editMessage", async () => {
    await expect(
      handleSlackAction(
        {
          action: "editMessage",
          channelId: "C123",
          messageId: "123.456",
          content: "",
        },
        slackConfig(),
      ),
    ).rejects.toThrow(/requires content or blocks/i);
  });

  it("auto-injects threadTs from context when replyToMode=all", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Threaded reply",
      },
      cfg,
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expectLastSlackSend("Threaded reply", cfg, "1111111111.111111");
  });

  it("auto-injects threadTs for matching DM user targets", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "user:U123",
        content: "Threaded DM reply",
      },
      cfg,
      {
        currentChannelId: "slack:U123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expectSlackSendCall(0, "user:U123", "Threaded DM reply", {
      cfg,
      mediaUrl: undefined,
      threadTs: "1111111111.111111",
      blocks: undefined,
    });
  });

  it("auto-injects threadTs for routable DM targets while retaining the native channel", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "user:U123",
        content: "Threaded DM reply",
      },
      cfg,
      {
        currentChannelId: "D123",
        currentMessagingTarget: "user:U123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expectSlackSendCall(0, "user:U123", "Threaded DM reply", {
      cfg,
      mediaUrl: undefined,
      threadTs: "1111111111.111111",
      blocks: undefined,
    });
  });

  it.each([
    { name: "topLevel true", patch: { topLevel: true } },
    { name: "threadTs null", patch: { threadTs: null } },
  ] as const)("does not auto-inject threadTs for $name", async (testCase) => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Channel root",
        ...testCase.patch,
      },
      cfg,
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expectLastSlackSend("Channel root", cfg);
  });

  it("replyToMode=first threads first message then stops", async () => {
    const { cfg, context } = createReplyToFirstScenario();

    await handleSlackAction(
      { action: "sendMessage", to: "channel:C123", content: "First" },
      cfg,
      context,
    );

    expectLastSlackSend("First", cfg, "1111111111.111111");
    await sendSecondMessageAndExpectNoThread({ cfg, context });
  });

  it("replyToMode=first threads standalone message-tool sends without ReplyToId", async () => {
    const cfg = slackConfig({ replyToMode: "first" });
    const hasRepliedRef = { value: false };
    const context = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      hasRepliedRef,
      context: {
        ChatType: "channel",
        To: "channel:C123",
        CurrentMessageId: "1111111111.111111",
      },
    });

    await handleSlackAction(
      { action: "sendMessage", to: "channel:C123", content: "First" },
      cfg,
      context,
    );

    expectLastSlackSend("First", cfg, "1111111111.111111");
    await sendSecondMessageAndExpectNoThread({ cfg, context });
  });

  it("does not use standalone current-message anchors for different channels", async () => {
    const cfg = slackConfig({ replyToMode: "first" });
    const hasRepliedRef = { value: false };
    const context = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      hasRepliedRef,
      context: {
        ChatType: "channel",
        To: "channel:C123",
        CurrentMessageId: "1111111111.111111",
      },
    });

    await handleSlackAction(
      { action: "sendMessage", to: "channel:C999", content: "Other channel" },
      cfg,
      context,
    );

    expectSlackSendCall(0, "channel:C999", "Other channel", {
      cfg,
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: undefined,
    });
    expect(hasRepliedRef.value).toBe(false);
  });

  it("replyToMode=first normalizes channel target when accounting explicit threadTs", async () => {
    const { cfg, context, hasRepliedRef } = createReplyToFirstScenario();

    await handleSlackAction(
      {
        action: "sendMessage",
        to: "#c123",
        content: "Explicit",
        threadTs: "9999999999.999999",
      },
      cfg,
      context,
    );

    expect(hasRepliedRef.value).toBe(true);
    await sendSecondMessageAndExpectNoThread({ cfg, context });
  });

  it("replyToMode=first marks hasRepliedRef even when threadTs is explicit", async () => {
    const { cfg, context, hasRepliedRef } = createReplyToFirstScenario();

    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Explicit",
        threadTs: "9999999999.999999",
      },
      cfg,
      context,
    );

    expectLastSlackSend("Explicit", cfg, "9999999999.999999");
    expect(hasRepliedRef.value).toBe(true);
    await sendSecondMessageAndExpectNoThread({ cfg, context });
  });

  it("replyToMode=first consumes a routable DM target with a native channel context", async () => {
    const cfg = slackConfig();
    const hasRepliedRef = { value: false };
    const context = {
      currentChannelId: "D123",
      currentMessagingTarget: "user:U123",
      currentThreadTs: "1111111111.111111",
      replyToMode: "first" as const,
      hasRepliedRef,
    };

    await handleSlackAction(
      {
        action: "sendMessage",
        to: "user:U123",
        content: "Explicit",
        threadTs: "9999999999.999999",
      },
      cfg,
      context,
    );

    expect(hasRepliedRef.value).toBe(true);
    await handleSlackAction(
      { action: "sendMessage", to: "user:U123", content: "Second" },
      cfg,
      context,
    );
    expectSlackSendCall(1, "user:U123", "Second", {
      cfg,
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: undefined,
    });
  });

  it("replyToMode=first without hasRepliedRef does not thread", async () => {
    const cfg = slackConfig();
    await handleSlackAction({ action: "sendMessage", to: "channel:C123", content: "No ref" }, cfg, {
      currentChannelId: "C123",
      currentThreadTs: "1111111111.111111",
      replyToMode: "first",
    });
    expectLastSlackSend("No ref", cfg);
  });

  it("does not auto-inject threadTs when replyToMode=off", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      { action: "sendMessage", to: "channel:C123", content: "No thread" },
      cfg,
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "off",
      },
    );
    expectLastSlackSend("No thread", cfg);
  });

  it("keeps same-channel sends and uploads top-level for a prepared channel override", async () => {
    const cfg = slackConfig({
      replyToMode: "all",
      channels: { C123: { replyToMode: "off" } },
    });
    const context = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      context: {
        ChatType: "channel",
        To: "channel:C123",
        CurrentMessageId: "1111111111.111111",
        ReplyToId: "1111111111.111111",
        ReplyToMode: "off",
      },
    });

    await handleSlackAction(
      { action: "sendMessage", to: "channel:C123", content: "Channel root" },
      cfg,
      context,
    );
    await handleSlackAction(
      {
        action: "uploadFile",
        to: "channel:C123",
        filePath: "/tmp/report.png",
        initialComment: "fresh report",
      },
      cfg,
      context,
    );

    expectSlackSendCall(0, "channel:C123", "Channel root", {
      cfg,
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: undefined,
    });
    expectSlackSendCall(1, "channel:C123", "fresh report", {
      cfg,
      mediaUrl: "/tmp/report.png",
      threadTs: undefined,
      uploadFileName: undefined,
      uploadTitle: undefined,
    });
  });

  it("does not auto-inject threadTs when sending to different channel", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      { action: "sendMessage", to: "channel:C999", content: "Other channel" },
      cfg,
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expectSlackSendCall(0, "channel:C999", "Other channel", {
      cfg,
      mediaUrl: undefined,
      threadTs: undefined,
      blocks: undefined,
    });
  });

  it("explicit threadTs overrides context threadTs", async () => {
    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "sendMessage",
        to: "channel:C123",
        content: "Explicit wins",
        threadTs: "9999999999.999999",
      },
      cfg,
      {
        currentChannelId: "C123",
        currentThreadTs: "1111111111.111111",
        replyToMode: "all",
      },
    );
    expectLastSlackSend("Explicit wins", cfg, "9999999999.999999");
  });

  it("handles channel target without prefix when replyToMode=all", async () => {
    const cfg = slackConfig();
    await handleSlackAction({ action: "sendMessage", to: "C123", content: "Bare target" }, cfg, {
      currentChannelId: "C123",
      currentThreadTs: "1111111111.111111",
      replyToMode: "all",
    });
    expectSlackSendCall(0, "C123", "Bare target", {
      cfg,
      mediaUrl: undefined,
      threadTs: "1111111111.111111",
      blocks: undefined,
    });
  });

  it("adds normalized timestamps to readMessages payloads", async () => {
    readSlackMessages.mockResolvedValueOnce({
      messages: [{ ts: "1712345678.123456", text: "hi" }],
      hasMore: false,
    });

    const result = await handleSlackAction(
      { action: "readMessages", channelId: "C1" },
      slackConfig(),
    );

    const details = requireDetails(result);
    expect(details.ok).toBe(true);
    expect(details.hasMore).toBe(false);
    const messages = requireArray(details.messages, "read messages");
    expectRecordFields(requireRecord(messages[0], "first message"), {
      ts: "1712345678.123456",
      timestampMs: 1712345678123,
    });
  });

  it("passes threadId through to readSlackMessages", async () => {
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

    const cfg = slackConfig();
    await handleSlackAction(
      { action: "readMessages", channelId: "C1", threadId: "1712345678.123456" },
      cfg,
    );

    expect(requireMockArg(readSlackMessages, "readSlackMessages", 0, 0)).toBe("C1");
    expectRecordFields(requireRecordArg(readSlackMessages, "readSlackMessages", 0, 1), {
      cfg,
      threadId: "1712345678.123456",
      limit: undefined,
      before: undefined,
      after: undefined,
    });
  });

  it("parses string readMessages limits before reading Slack messages", async () => {
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

    await handleSlackAction(
      { action: "readMessages", channelId: "C1", limit: "20" },
      slackConfig(),
    );

    expectRecordFields(requireRecordArg(readSlackMessages, "readSlackMessages", 0, 1), {
      limit: 20,
    });
  });

  it("rejects fractional readMessages limits before reading Slack messages", async () => {
    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C1", limit: 2.5 }, slackConfig()),
    ).rejects.toThrow("limit must be a positive integer.");
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("reads from allowlisted Slack target channels", async () => {
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

    const cfg = slackConfig({
      groupPolicy: "allowlist",
      channels: {
        C_ALLOWED: { enabled: true },
      },
    });
    await handleSlackAction({ action: "readMessages", channelId: "C_ALLOWED" }, cfg);

    expect(requireMockArg(readSlackMessages, "readSlackMessages", 0, 0)).toBe("C_ALLOWED");
  });

  it("resolves name-allowlisted reads from a core-shaped Slack threading context", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({
      type: "channel",
      name: "allowed-channel",
    });
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

    const cfg = slackConfig({
      groupPolicy: "allowlist",
      dangerouslyAllowNameMatching: true,
      channels: {
        "#allowed-channel": { enabled: true },
      },
    });
    const context = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      context: {
        ChatType: "channel",
        Channel: "slack",
        To: "channel:C0123456789",
      },
    });

    await handleSlackAction({ action: "readMessages", channelId: "C0123456789" }, cfg, context);

    expect(resolveSlackConversationInfo).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      channelId: "C0123456789",
      operation: "read",
      requireFreshName: true,
    });
    expect(requireMockArg(readSlackMessages, "readSlackMessages", 0, 0)).toBe("C0123456789");
  });

  it("does not treat the core Channel provider value as a Slack room name", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({
      type: "channel",
      name: "actual-room",
    });

    const cfg = slackConfig({
      groupPolicy: "allowlist",
      dangerouslyAllowNameMatching: true,
      channels: {
        "#slack": { enabled: true },
      },
    });
    const context = buildSlackThreadingToolContext({
      cfg,
      accountId: null,
      context: {
        ChatType: "channel",
        Channel: "slack",
        To: "channel:C0123456789",
      },
    });

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C0123456789" }, cfg, context),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(resolveSlackConversationInfo).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      channelId: "C0123456789",
      operation: "read",
      requireFreshName: true,
    });
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("does not authorize different Slack targets with the current context channel ID", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({
      type: "channel",
      name: "other-channel",
    });

    const cfg = slackConfig({
      groupPolicy: "allowlist",
      dangerouslyAllowNameMatching: true,
      channels: {
        "#allowed-channel": { enabled: true },
      },
    });

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C9876543210" }, cfg, {
        currentChannelId: "C0123456789",
      }),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(resolveSlackConversationInfo).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      channelId: "C9876543210",
      operation: "read",
      requireFreshName: true,
    });
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("requests read-scoped metadata for name-allowlisted channels", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({
      type: "channel",
      name: "allowed-channel",
    });
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

    const cfg = slackConfig({
      userToken: "xoxp-reader",
      groupPolicy: "allowlist",
      dangerouslyAllowNameMatching: true,
      channels: {
        "#allowed-channel": { enabled: true },
      },
    });
    await handleSlackAction({ action: "readMessages", channelId: "C0123456789" }, cfg);

    expect(resolveSlackConversationInfo).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      channelId: "C0123456789",
      operation: "read",
      requireFreshName: true,
    });
    expect(requireMockArg(readSlackMessages, "readSlackMessages", 0, 0)).toBe("C0123456789");
  });

  it("resolves Slack target channel names before applying wildcard fallback denial", async () => {
    resolveSlackConversationInfo.mockResolvedValueOnce({
      type: "channel",
      name: "allowed-channel",
    });
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

    const cfg = slackConfig({
      groupPolicy: "allowlist",
      dangerouslyAllowNameMatching: true,
      channels: {
        "*": { enabled: false },
        "#allowed-channel": { enabled: true },
      },
    });
    await handleSlackAction({ action: "readMessages", channelId: "C0123456789" }, cfg);

    expect(resolveSlackConversationInfo).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      channelId: "C0123456789",
      operation: "read",
      requireFreshName: true,
    });
    expect(requireMockArg(readSlackMessages, "readSlackMessages", 0, 0)).toBe("C0123456789");
  });

  it("does not let a name match override an explicit channel-id denial", async () => {
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      dangerouslyAllowNameMatching: true,
      channels: {
        C0123456789: { enabled: false },
        "#allowed-channel": { enabled: true },
      },
    });

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C0123456789" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(resolveSlackConversationInfo).not.toHaveBeenCalled();
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("fails closed before reading when Slack cannot resolve the target name", async () => {
    resolveSlackConversationInfo.mockRejectedValueOnce(new Error("missing_scope"));
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      dangerouslyAllowNameMatching: true,
      channels: {
        "#allowed-channel": { enabled: true },
      },
    });

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C0123456789" }, cfg),
    ).rejects.toThrow("missing_scope");
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("rejects Slack reads for non-allowlisted target channels", async () => {
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      channels: {
        C_ALLOWED: { enabled: true },
      },
    });

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C_OTHER" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("allows Slack reads from unlisted targets when group policy is open", async () => {
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

    const cfg = slackConfig({
      groupPolicy: "open",
      channels: {
        C_CONFIGURED: { enabled: true },
      },
    });
    await handleSlackAction({ action: "readMessages", channelId: "C_OTHER" }, cfg);

    expect(requireMockArg(readSlackMessages, "readSlackMessages", 0, 0)).toBe("C_OTHER");
  });

  it("rejects Slack reads from disabled targets when group policy is open", async () => {
    const cfg = slackConfig({
      groupPolicy: "open",
      channels: {
        C_DISABLED: { enabled: false },
      },
    });

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C_DISABLED" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(readSlackMessages).not.toHaveBeenCalled();
  });

  it("fails closed for read-like Slack actions when provider config is missing", async () => {
    const cfg = {} as OpenClawConfig;

    await expect(
      handleSlackAction({ action: "readMessages", channelId: "C1" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(readSlackMessages).not.toHaveBeenCalled();

    await expect(
      handleSlackAction({ action: "reactions", channelId: "C1", messageId: "123.456" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(listSlackReactions).not.toHaveBeenCalled();

    await expect(
      handleSlackAction({ action: "downloadFile", fileId: "F123", channelId: "C1" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(downloadSlackFile).not.toHaveBeenCalled();

    await expect(handleSlackAction({ action: "listPins", channelId: "C1" }, cfg)).rejects.toThrow(
      "Slack read target channel is not allowed.",
    );
    expect(listSlackPins).not.toHaveBeenCalled();
  });

  it("rejects Slack file downloads for non-allowlisted target channels", async () => {
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      channels: {
        C_ALLOWED: { enabled: true },
      },
    });

    await expect(
      handleSlackAction({ action: "downloadFile", fileId: "F123", channelId: "C_OTHER" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(downloadSlackFile).not.toHaveBeenCalled();
  });

  it("rejects Slack pin reads for non-allowlisted target channels", async () => {
    const cfg = slackConfig({
      groupPolicy: "allowlist",
      channels: {
        C_ALLOWED: { enabled: true },
      },
    });

    await expect(
      handleSlackAction({ action: "listPins", channelId: "C_OTHER" }, cfg),
    ).rejects.toThrow("Slack read target channel is not allowed.");
    expect(listSlackPins).not.toHaveBeenCalled();
  });

  it("passes messageId through to readSlackMessages", async () => {
    readSlackMessages.mockResolvedValueOnce({ messages: [], hasMore: false });

    const cfg = slackConfig();
    await handleSlackAction(
      {
        action: "readMessages",
        channelId: "C1",
        threadId: "1712345678.123456",
        messageId: "1712345678.654321",
      },
      cfg,
    );

    expect(requireMockArg(readSlackMessages, "readSlackMessages", 0, 0)).toBe("C1");
    expectRecordFields(requireRecordArg(readSlackMessages, "readSlackMessages", 0, 1), {
      cfg,
      threadId: "1712345678.123456",
      messageId: "1712345678.654321",
    });
  });

  it("adds normalized timestamps to pin payloads", async () => {
    listSlackPins.mockResolvedValueOnce([{ message: { ts: "1712345678.123456", text: "pin" } }]);

    const result = await handleSlackAction({ action: "listPins", channelId: "C1" }, slackConfig());

    const details = requireDetails(result);
    expect(details.ok).toBe(true);
    const pins = requireArray(details.pins, "pins");
    const firstPin = requireRecord(pins[0], "first pin");
    expectRecordFields(requireRecord(firstPin.message, "first pin message"), {
      ts: "1712345678.123456",
      timestampMs: 1712345678123,
    });
  });

  it("uses user token for reads when available", async () => {
    const token = await resolveReadToken(
      slackConfig({
        accounts: {
          default: {
            botToken: "xoxb-bot",
            userToken: "xoxp-user",
          },
        },
      }),
    );
    expect(token).toBe("xoxp-user");
  });

  it("falls back to bot token for reads when user token missing", async () => {
    const token = await resolveReadToken(
      slackConfig({
        accounts: {
          default: {
            botToken: "xoxb-bot",
          },
        },
      }),
    );
    expect(token).toBeUndefined();
  });

  it("uses bot token for writes when userTokenReadOnly is true", async () => {
    const token = await resolveSendToken(
      slackConfig({
        accounts: {
          default: {
            botToken: "xoxb-bot",
            userToken: "xoxp-user",
            userTokenReadOnly: true,
          },
        },
      }),
    );
    expect(token).toBeUndefined();
  });

  it("allows user token writes when bot token is missing", async () => {
    const token = await resolveSendToken({
      channels: {
        slack: {
          accounts: {
            default: {
              userToken: "xoxp-user",
              userTokenReadOnly: false,
            },
          },
        },
      },
    } as OpenClawConfig);
    expect(token).toBe("xoxp-user");
  });

  it("returns all emojis when no limit is provided", async () => {
    listSlackEmojis.mockResolvedValueOnce({
      ok: true,
      emoji: { party: "https://example.com/party.png", wave: "https://example.com/wave.png" },
    });

    const result = await handleSlackAction({ action: "emojiList" }, slackConfig());

    const details = requireDetails(result);
    expect(details.ok).toBe(true);
    expect(details.emojis).toEqual({
      ok: true,
      emoji: { party: "https://example.com/party.png", wave: "https://example.com/wave.png" },
    });
  });

  it("applies limit to emoji-list results", async () => {
    listSlackEmojis.mockResolvedValueOnce({
      ok: true,
      emoji: {
        wave: "https://example.com/wave.png",
        party: "https://example.com/party.png",
        tada: "https://example.com/tada.png",
      },
    });

    const result = await handleSlackAction({ action: "emojiList", limit: 2 }, slackConfig());

    const details = requireDetails(result);
    expect(details.ok).toBe(true);
    expect(details.emojis).toEqual({
      ok: true,
      emoji: {
        party: "https://example.com/party.png",
        tada: "https://example.com/tada.png",
      },
    });
  });

  it("rejects fractional emoji-list limits before reading emojis", async () => {
    await expect(
      handleSlackAction({ action: "emojiList", limit: 2.5 }, slackConfig()),
    ).rejects.toThrow("limit must be a positive integer.");
    expect(listSlackEmojis).not.toHaveBeenCalled();
  });
});
