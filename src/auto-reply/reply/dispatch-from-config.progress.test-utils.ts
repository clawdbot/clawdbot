// Imported by dispatch-from-config.test.ts to keep its mocked suite in one Vitest module graph.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  createDispatcher,
  emptyConfig,
  hookMocks,
  replyMediaPathMocks,
  sessionStoreMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticGroupReplyConfig,
  messageToolGroupReplyConfig,
  dispatchReplyFromConfig,
  setNoAbort,
  firstMockArg,
  firstToolResultPayload,
  requireToolResultHandler,
  globalBeforeAll0,
  describe0BeforeEach0,
} from "./dispatch-from-config.test-harness.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("dispatchReplyFromConfig", () => {
  beforeEach(describe0BeforeEach0);

  it("reports verbose progress visibility to the channel", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    let isActive: (() => boolean) | undefined;
    let activeDuringRun: boolean | undefined;
    let activeAfterLevelChange: boolean | undefined;
    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      activeDuringRun = isActive?.();
      sessionStoreMocks.currentEntry = {
        verboseLevel: "off",
      };
      activeAfterLevelChange = isActive?.();
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        onVerboseProgressVisibility: (getter) => {
          isActive = getter;
        },
      },
    });

    expect(activeDuringRun).toBe(true);
    expect(activeAfterLevelChange).toBe(false);

    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    let isActiveOff: (() => boolean) | undefined;
    let activeDuringOffRun: boolean | undefined;
    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver: async () => {
        activeDuringOffRun = isActiveOff?.();
        return { text: "done" } satisfies ReplyPayload;
      },
      replyOptions: {
        onVerboseProgressVisibility: (getter) => {
          isActiveOff = getter;
        },
      },
    });

    expect(activeDuringOffRun).toBe(false);
  });

  it.each([
    { stored: "off", override: "full", expected: ["Tool summary", "Tool failure output"] },
    { stored: "full", override: "off", expected: [] },
    { stored: "full", override: "on", expected: ["Tool summary"] },
  ] as const)(
    "delivers admitted run verbosity $override instead of stored $stored",
    async ({ stored, override, expected }) => {
      setNoAbort();
      sessionStoreMocks.currentEntry = {
        sessionId: "session",
        updatedAt: 0,
        verboseLevel: stored,
      };
      const dispatcher = createDispatcher();
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "telegram",
          ChatType: "direct",
          SessionKey: "agent:main:telegram:direct:U1",
        }),
        cfg: emptyConfig,
        dispatcher,
        replyOptions: { sourceReplyDeliveryMode: "message_tool_only" },
        replyResolver: async (_ctx, opts) => {
          opts?.onRunVerbosityResolved?.({
            verboseLevelOverride: override,
            resolvedVerboseLevel: override,
          });
          await opts?.onToolResult?.({ text: "Tool summary" });
          await opts?.onToolResult?.({ text: "Tool failure output", isError: true });
          return undefined;
        },
      });
      expect(
        vi.mocked(dispatcher.sendToolResult).mock.calls.map(([payload]) => payload.text),
      ).toEqual(expected);
      expect(sessionStoreMocks.currentEntry.verboseLevel).toBe(stored);
      expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    },
  );

  it("clears an earlier admitted verbosity override for an inherited queued run", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = { verboseLevel: "off" };
    const dispatcher = createDispatcher();
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        ChatType: "direct",
        SessionKey: "agent:main:telegram:direct:U1",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver: async (_ctx, opts) => {
        opts?.onRunVerbosityResolved?.({
          verboseLevelOverride: "full",
          resolvedVerboseLevel: "full",
        });
        await opts?.onToolResult?.({ text: "Explicit turn" });
        opts?.onRunVerbosityResolved?.({ resolvedVerboseLevel: "on" });
        await opts?.onToolResult?.({ text: "Inherited off" });
        sessionStoreMocks.currentEntry = { verboseLevel: "on" };
        await opts?.onToolResult?.({ text: "Inherited live on" });
        return { text: "Done" };
      },
    });
    expect(
      vi.mocked(dispatcher.sendToolResult).mock.calls.map(([payload]) => payload.text),
    ).toEqual(["Explicit turn", "Inherited live on"]);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "Done" });
  });

  it("keeps verbose commentary in the channel draft when that draft owns progress", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = { verboseLevel: "on" };
    const dispatcher = createDispatcher();
    const onItemEvent = vi.fn();

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "group",
        From: "telegram:group:-100123",
        SessionKey: "agent:main:telegram:group:-100123",
      }),
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver: async (_ctx, opts) => {
        expect(opts?.commentaryPayloadsEnabled).toBe(false);
        await opts?.onItemEvent?.({
          itemId: "commentary-draft-1",
          kind: "preamble",
          progressText: "Inspecting the dispatch path.",
        });
        return { text: "Done." } satisfies ReplyPayload;
      },
      replyOptions: {
        commentaryProgressEnabled: true,
        progressPreambleEnabled: true,
        commentaryPayloadsEnabled: true,
        shouldDeliverCommentaryPayloads: () => false,
        onItemEvent,
      },
    });

    expect(onItemEvent).toHaveBeenCalledExactlyOnceWith({
      itemId: "commentary-draft-1",
      kind: "preamble",
      progressText: "Inspecting the dispatch path.",
    });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith({ text: "Done." });
  });

  it.each([
    { surface: "slack", verboseLevel: "on", nextVerboseLevel: "off", durableCommentary: true },
    { surface: "slack", verboseLevel: "off", nextVerboseLevel: "on", durableCommentary: false },
    { surface: "discord", verboseLevel: "on", nextVerboseLevel: "off", durableCommentary: true },
    { surface: "discord", verboseLevel: "off", nextVerboseLevel: "on", durableCommentary: false },
  ] as const)(
    "routes $surface commentary through one owner with verbose $verboseLevel",
    async ({ surface, verboseLevel, nextVerboseLevel, durableCommentary }) => {
      setNoAbort();
      sessionStoreMocks.currentEntry = {
        verboseLevel,
      };
      const dispatcher = createDispatcher();
      const ctx = buildTestCtx({
        Provider: surface,
        Surface: surface,
        ChatType: "group",
        From: `${surface}:channel:C123`,
        SessionKey: `agent:main:${surface}:channel:C123`,
      });
      const onItemEvent = vi.fn();
      let isVerboseProgressActive = () => false;

      const replyResolver = async (
        _ctx: MsgContext,
        opts?: GetReplyOptions,
        _cfg?: OpenClawConfig,
      ) => {
        sessionStoreMocks.currentEntry = {
          verboseLevel: nextVerboseLevel,
        };
        expect(isVerboseProgressActive()).toBe(durableCommentary);
        expect(opts?.commentaryPayloadsEnabled).toBe(durableCommentary);
        await opts?.onItemEvent?.({
          itemId: "commentary-1",
          kind: "preamble",
          progressText: "Inspecting the dispatch path.",
          ...(durableCommentary ? { suppressDurableProgress: true } : {}),
        });
        await opts?.onBlockReply?.({
          text: "Inspecting the dispatch path.",
          isCommentary: true,
        });
        return { text: "Done." } satisfies ReplyPayload;
      };

      await dispatchReplyFromConfig({
        ctx,
        cfg: automaticGroupReplyConfig,
        dispatcher,
        replyResolver,
        replyOptions: {
          suppressDefaultToolProgressMessages: true,
          commentaryProgressEnabled: true,
          progressPreambleEnabled: true,
          commentaryPayloadsEnabled: true,
          shouldDeliverCommentaryPayloads: () => isVerboseProgressActive(),
          onVerboseProgressVisibility: (getter) => {
            isVerboseProgressActive = getter;
          },
          onItemEvent,
        },
      });

      expect(onItemEvent).toHaveBeenCalledExactlyOnceWith({
        itemId: "commentary-1",
        kind: "preamble",
        progressText: "Inspecting the dispatch path.",
        ...(durableCommentary ? { suppressDurableProgress: true } : {}),
      });
      expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
      if (durableCommentary) {
        expect(dispatcher.sendBlockReply).toHaveBeenCalledExactlyOnceWith({
          text: "Inspecting the dispatch path.",
          isCommentary: true,
        });
      } else {
        expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
      }
      expect(dispatcher.sendFinalReply).toHaveBeenCalledExactlyOnceWith({ text: "Done." });
    },
  );

  it("forwards channel-owned group progress callbacks while source delivery is suppressed", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:group:-100123",
      SessionKey: "agent:main:telegram:group:-100123",
    });
    const onToolStart = vi.fn();
    const onItemEvent = vi.fn();
    const onCommandOutput = vi.fn();
    const onToolResult = vi.fn();

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolStart?.({ name: "exec", phase: "start" });
      await opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running exec" });
      await opts?.onCommandOutput?.({ phase: "end", name: "exec", status: "ok", exitCode: 0 });
      await opts?.onToolResult?.({ text: "exec: ok" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolStart,
        onItemEvent,
        onCommandOutput,
        onToolResult,
      },
    });

    expect(onToolStart).toHaveBeenCalledWith({ name: "exec", phase: "start" });
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "1",
      kind: "tool",
      progressText: "running exec",
    });
    expect(onCommandOutput).toHaveBeenCalledWith({
      phase: "end",
      name: "exec",
      status: "ok",
      exitCode: 0,
    });
    expect(onToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "automatic",
      cfg: automaticGroupReplyConfig,
      expectedUserRequestMode: "automatic",
      expectedStableMode: "automatic",
    },
    {
      name: "message-tool",
      cfg: messageToolGroupReplyConfig,
      expectedUserRequestMode: "message_tool_only",
      expectedStableMode: "message_tool_only",
    },
  ] as const)(
    "threads $name session-stable source delivery mode to reply runs",
    async ({ cfg, expectedUserRequestMode, expectedStableMode }) => {
      setNoAbort();
      const dispatcher = createDispatcher();
      type CapturedReplyOptions = GetReplyOptions & {
        sessionPromptSourceReplyDeliveryMode?: GetReplyOptions["sourceReplyDeliveryMode"];
      };
      const seen: Array<{
        effective?: GetReplyOptions["sourceReplyDeliveryMode"];
        stable?: GetReplyOptions["sourceReplyDeliveryMode"];
      }> = [];
      const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: CapturedReplyOptions) => {
        seen.push({
          effective: opts?.sourceReplyDeliveryMode,
          stable: opts?.sessionPromptSourceReplyDeliveryMode,
        });
        return { text: "done" } satisfies ReplyPayload;
      });
      const baseCtx = {
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "group",
        From: "telegram:group:-100123",
        SessionKey: "agent:main:telegram:group:-100123",
      };

      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          ...baseCtx,
          Body: "@bot check this",
          CommandBody: "@bot check this",
        }),
        cfg,
        dispatcher,
        replyResolver,
      });
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({
          ...baseCtx,
          Body: "@bot check this",
          CommandBody: "@bot check this",
          InboundEventKind: "room_event",
        }),
        cfg,
        dispatcher,
        replyResolver,
      });

      expect(seen).toEqual([
        { effective: expectedUserRequestMode, stable: expectedStableMode },
        { effective: "message_tool_only", stable: expectedStableMode },
      ]);
    },
  );

  it("forwards channel-owned room-event progress callbacks while source delivery is suppressed", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      InboundEventKind: "room_event",
      From: "telegram:group:-100123",
      SessionKey: "agent:main:telegram:group:-100123",
    });
    const onToolStart = vi.fn();
    const onItemEvent = vi.fn();
    const onCommandOutput = vi.fn();
    let commentaryEnabled: boolean | undefined;

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      commentaryEnabled = opts?.commentaryProgressEnabled;
      await opts?.onToolStart?.({ name: "exec", phase: "start" });
      await opts?.onItemEvent?.({
        itemId: "c1",
        kind: "preamble",
        progressText: "checking the channel state",
      });
      await opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running exec" });
      await opts?.onCommandOutput?.({ phase: "end", name: "exec", status: "ok", exitCode: 0 });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolStart,
        onItemEvent,
        onCommandOutput,
      },
    });

    expect(commentaryEnabled).toBe(true);
    expect(onToolStart).toHaveBeenCalledWith({ name: "exec", phase: "start" });
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "c1",
      kind: "preamble",
      progressText: "checking the channel state",
    });
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "1",
      kind: "tool",
      progressText: "running exec",
    });
    expect(onCommandOutput).toHaveBeenCalledWith({
      phase: "end",
      name: "exec",
      status: "ok",
      exitCode: 0,
    });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("exposes live group tool-summary state to reply_dispatch hooks", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "matrix",
      Surface: "matrix",
      ChatType: "group",
      From: "matrix:!room:test",
      SessionKey: "agent:main:matrix:group:!room:test",
    });
    let initialHookState: boolean | undefined;
    let updatedHookState: boolean | undefined;
    hookMocks.runner.runReplyDispatch.mockImplementationOnce(async (event: unknown) => {
      const replyDispatchEvent = event as { shouldSendToolSummaries: boolean };
      initialHookState = replyDispatchEvent.shouldSendToolSummaries;
      sessionStoreMocks.currentEntry = {
        verboseLevel: "on",
      };
      updatedHookState = replyDispatchEvent.shouldSendToolSummaries;
      return undefined;
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver: async () => ({ text: "hi" }) satisfies ReplyPayload,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(initialHookState).toBe(false);
    expect(updatedHookState).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("forwards direct native progress callbacks while verbose is off", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
      From: "telegram:123",
      SessionKey: "agent:main:telegram:dm:123",
    });
    const onToolStart = vi.fn();
    const onItemEvent = vi.fn();
    const onCommandOutput = vi.fn();
    let commentaryEnabled: boolean | undefined;

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      commentaryEnabled = opts?.commentaryProgressEnabled;
      await opts?.onToolStart?.({ name: "exec", phase: "start" });
      await opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running exec" });
      await opts?.onCommandOutput?.({ phase: "end", name: "exec", status: "ok", exitCode: 0 });
      await opts?.onToolResult?.({ text: "🔧 exec: ok" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolStart,
        onItemEvent,
        onCommandOutput,
      },
    });

    expect(onToolStart).toHaveBeenCalledWith({ name: "exec", phase: "start" });
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "1",
      kind: "tool",
      progressText: "running exec",
    });
    expect(onCommandOutput).toHaveBeenCalledWith({
      phase: "end",
      name: "exec",
      status: "ok",
      exitCode: 0,
    });
    expect(commentaryEnabled).toBe(true);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("keeps CLI preamble classification when quiet channel progress is hidden", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = { verboseLevel: "off" };
    const dispatcher = createDispatcher();
    const onItemEvent = vi.fn();
    let itemEventHandlerPresent = false;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      itemEventHandlerPresent = Boolean(opts?.onItemEvent);
      await opts?.onItemEvent?.({ kind: "preamble", progressText: "Checking first" });
      return { text: "Final answer" };
    };

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "direct",
        SessionKey: "agent:main:telegram:dm:123",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { onItemEvent, progressPreambleEnabled: true },
    });

    expect(itemEventHandlerPresent).toBe(true);
    expect(onItemEvent).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "Final answer" });
  });

  it("suppresses direct native progress callbacks when send policy denies delivery", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sendPolicy: "deny",
      verboseLevel: "off",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
      From: "telegram:123",
      SessionKey: "agent:main:telegram:dm:123",
    });
    const onToolStart = vi.fn();
    const onItemEvent = vi.fn();
    const onCommandOutput = vi.fn();
    let commentaryEnabled: boolean | undefined;

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      commentaryEnabled = opts?.commentaryProgressEnabled;
      await opts?.onToolStart?.({ name: "exec", phase: "start" });
      await opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running exec" });
      await opts?.onCommandOutput?.({ phase: "end", name: "exec", status: "ok", exitCode: 0 });
      await opts?.onToolResult?.({ text: "exec: ok" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onToolStart,
        onItemEvent,
        onCommandOutput,
      },
    });

    expect(onToolStart).not.toHaveBeenCalled();
    expect(onItemEvent).not.toHaveBeenCalled();
    expect(onCommandOutput).not.toHaveBeenCalled();
    expect(commentaryEnabled).toBeUndefined();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("normalizes tool-result media before delivery and drops blocked file URLs", async () => {
    setNoAbort();
    replyMediaPathMocks.createReplyMediaPathNormalizer.mockReturnValue(
      async (payload: ReplyPayload) => ({
        ...payload,
        mediaUrl: undefined,
        mediaUrls: undefined,
      }),
    );
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "group",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.({
        text: "NO_REPLY",
        mediaUrls: ["file://attacker/share/probe.mp3"],
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    const normalizerOptions = replyMediaPathMocks.createReplyMediaPathNormalizer.mock
      .calls[0]?.[0] as { cfg?: unknown; messageProvider?: unknown } | undefined;
    expect(normalizerOptions?.cfg).toBe(cfg);
    expect(normalizerOptions?.messageProvider).toBe("webchat");
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("delivers tool summaries in forum topic sessions when verbose is enabled", async () => {
    setNoAbort();
    const cfg = {
      ...automaticGroupReplyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "group",
      IsForum: true,
      MessageThreadId: 99,
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(firstToolResultPayload(dispatcher)?.text).toBe("🔧 exec: ls");
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("delivers deterministic exec approval tool payloads in groups", async () => {
    setNoAbort();
    const cfg = automaticGroupReplyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "group",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.({
        text: "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
        channelData: {
          execApproval: {
            approvalId: "117ba06d-1111-2222-3333-444444444444",
            approvalSlug: "117ba06d",
            allowedDecisions: ["allow-once", "allow-always", "deny"],
          },
        },
      });
      return { text: "NO_REPLY" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    const toolPayload = firstToolResultPayload(dispatcher);
    expect(toolPayload?.text).toBe(
      "Approval required.\n\n```txt\n/approve 117ba06d allow-once\n```",
    );
    expect(toolPayload?.channelData).toStrictEqual({
      execApproval: {
        approvalId: "117ba06d-1111-2222-3333-444444444444",
        approvalSlug: "117ba06d",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "NO_REPLY" });
  });

  it("sends tool results via dispatcher in DM sessions", async () => {
    setNoAbort();
    const cfg = {
      ...emptyConfig,
      agents: { defaults: { verboseDefault: "on" } },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      // Simulate tool result emission
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });
    expect(firstToolResultPayload(dispatcher)?.text).toBe("🔧 exec: ls");
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("delivers native tool summaries and tool media", async () => {
    setNoAbort();
    const cfg = {
      ...emptyConfig,
      agents: { defaults: { verboseDefault: "on" } },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      CommandSource: "native",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      const onToolResult = requireToolResultHandler(opts?.onToolResult);
      await onToolResult({ text: "🔧 tools/sessions_send" });
      await onToolResult({
        mediaUrl: "https://example.com/tts-native.opus",
      });
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(2);
    expect(firstToolResultPayload(dispatcher)?.text).toBe("🔧 tools/sessions_send");
    const sent = firstMockArg(
      dispatcher.sendToolResult as ReturnType<typeof vi.fn>,
      "tool result",
      1,
    ) as ReplyPayload;
    expect(sent.mediaUrl).toBe("https://example.com/tts-native.opus");
    expect(sent.text).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("bypasses final TTS for status notices", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });
    const notice = {
      text: "Model Fallback: openai/gpt-5.5",
      isFallbackNotice: true,
    } satisfies ReplyPayload;

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver: async () => notice,
      replyOptions: { suppressToolProgressMessages: true },
    });

    expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(notice);
  });

  it("renders the first plan update as a status notice without generic working statuses", async () => {
    setNoAbort();
    const cfg = {
      ...emptyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onPlanUpdate?.({
        phase: "update",
        explanation: "Inspect code, patch it, run tests.",
        steps: [
          { step: "Inspect code", status: "completed" },
          { step: "Patch code", status: "in_progress" },
          { step: "Run tests", status: "pending" },
        ],
      });
      await opts?.onApprovalEvent?.({
        phase: "requested",
        status: "pending",
        command: "pnpm test",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(firstToolResultPayload(dispatcher)).toMatchObject({
      text: "✅ Inspect code\n▸ Patch code\n▢ Run tests",
      isStatusNotice: true,
    });
    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("sends only one plan status notice per reply run", async () => {
    setNoAbort();
    const cfg = {
      ...emptyConfig,
      agents: { defaults: { verboseDefault: "on" } },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onPlanUpdate?.({
        phase: "update",
        steps: [{ step: "Inspect code", status: "in_progress" }],
      });
      await opts?.onPlanUpdate?.({
        phase: "update",
        steps: [
          { step: "Inspect code", status: "completed" },
          { step: "Patch code", status: "in_progress" },
        ],
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).toHaveBeenCalledTimes(1);
    expect(firstToolResultPayload(dispatcher)).toMatchObject({
      text: "▸ Inspect code",
      isStatusNotice: true,
    });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("suppresses generic patch working statuses when verbose is enabled", async () => {
    setNoAbort();
    const cfg = {
      ...emptyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onPatchSummary?.({
        phase: "end",
        title: "apply patch",
        summary: "1 added, 2 modified",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("delivers Slack non-DM verbose progress when verbose is enabled", async () => {
    setNoAbort();
    const cfg = {
      ...emptyConfig,
      messages: automaticGroupReplyConfig.messages,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "slack",
      Surface: "slack",
      ChatType: "channel",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onPlanUpdate?.({
        phase: "update",
        explanation: "Inspect code, patch it, run tests.",
        steps: [
          { step: "Inspect code", status: "completed" },
          { step: "Patch code", status: "in_progress" },
          { step: "Run tests", status: "pending" },
        ],
      });
      await opts?.onPatchSummary?.({
        phase: "end",
        title: "apply patch",
        summary: "1 added, 2 modified",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(dispatcher.sendToolResult).toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("suppresses plan notices when session verbose is off", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    const cfg = {
      ...emptyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:main",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onPlanUpdate?.({
        phase: "update",
        explanation: "Inspect code, patch it, run tests.",
        steps: [
          { step: "Inspect code", status: "completed" },
          { step: "Patch code", status: "in_progress" },
          { step: "Run tests", status: "pending" },
        ],
      });
      await opts?.onApprovalEvent?.({
        phase: "requested",
        status: "pending",
        command: "pnpm test",
      });
      await opts?.onPatchSummary?.({
        phase: "end",
        title: "apply patch",
        summary: "1 added, 2 modified",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("refreshes verbose progress with session entry snapshots", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "off",
    };
    sessionStoreMocks.loadSessionStoreEntry.mockReturnValue({ verboseLevel: "on" });
    const cfg = {
      ...emptyConfig,
      agents: {
        defaults: {
          verboseDefault: "on",
        },
      },
    } satisfies OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:main",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      sessionStoreMocks.loadSessionStore.mockClear();
      sessionStoreMocks.resolveSessionStoreEntry.mockClear();
      sessionStoreMocks.loadSessionStoreEntry.mockClear();
      await opts?.onPlanUpdate?.({
        phase: "update",
        explanation: "Inspect code, patch it, run tests.",
        steps: [
          { step: "Inspect code", status: "completed" },
          { step: "Patch code", status: "in_progress" },
          { step: "Run tests", status: "pending" },
        ],
      });
      await opts?.onApprovalEvent?.({
        phase: "requested",
        status: "pending",
        command: "pnpm test",
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(sessionStoreMocks.loadSessionStoreEntry).toHaveBeenCalledWith({
      agentId: "main",
      storePath: "/tmp/mock-sessions.json",
      sessionKey: "agent:main:main",
      readConsistency: "latest",
      clone: false,
    });
    expect(sessionStoreMocks.loadSessionStore).not.toHaveBeenCalled();
    expect(sessionStoreMocks.resolveSessionStoreEntry).not.toHaveBeenCalled();
    expect(firstToolResultPayload(dispatcher)).toMatchObject({
      text: "✅ Inspect code\n▸ Patch code\n▢ Run tests",
      isStatusNotice: true,
    });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("suppresses text-only tool summaries when preview tool-progress suppression is enabled", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("keeps failed tools compact when preview tool-progress suppression is enabled", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const onCommandOutput = vi.fn();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      ChatType: "channel",
      IsForum: true,
      SessionKey: "agent:main:discord:channel:C1",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onCommandOutput?.({
        phase: "end",
        title: "Exec",
        name: "exec",
        status: "failed",
        exitCode: 1,
      });
      await opts?.onToolResult?.({ text: "raw failed command output", isError: true });
      return { text: "done" } satisfies ReplyPayload;
    };

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onCommandOutput,
      },
    });

    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(onCommandOutput).toHaveBeenCalledWith({
      phase: "end",
      title: "Exec",
      name: "exec",
      status: "failed",
      exitCode: 1,
    });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("keeps message-tool-only failed tool output compact in normal verbose mode", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const onCommandOutput = vi.fn();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:telegram:direct:U1",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onCommandOutput?.({
        phase: "end",
        title: "Exec",
        name: "exec",
        status: "failed",
        exitCode: 2,
      });
      await opts?.onToolResult?.({
        text: "🛠️ Bash: `ls /tmp/missing`\n```txt\nNo such file or directory\n```",
        isError: true,
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    const result = await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        onCommandOutput,
      },
    });

    expect(result.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(onCommandOutput).toHaveBeenCalledWith({
      phase: "end",
      title: "Exec",
      name: "exec",
      status: "failed",
      exitCode: 2,
    });
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("hides message-tool-only error text without a progress callback", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:telegram:direct:U1",
    });
    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onToolResult?.({
        text: "🛠️ Bash: `ls /tmp/missing`\n```txt\nNo such file or directory\n```",
        isError: true,
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("allows message-tool-only failed tool output in verbose full mode", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "full",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:telegram:direct:U1",
    });
    const failedOutput = {
      text: "🛠️ Bash: `ls /tmp/missing`\n```txt\nNo such file or directory\n```",
      isError: true,
    } satisfies ReplyPayload;

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.(failedOutput);
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(dispatcher.sendToolResult).toHaveBeenCalledWith(failedOutput);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("forwards failed command progress in regular verbose mode", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const onCommandOutput = vi.fn();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:telegram:direct:U1",
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onCommandOutput?.({
        phase: "end",
        name: "exec",
        status: "failed",
        exitCode: 1,
      });
      return { text: "done" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { onCommandOutput },
    });

    expect(onCommandOutput).toHaveBeenCalledWith({
      phase: "end",
      name: "exec",
      status: "failed",
      exitCode: 1,
    });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("preserves declined failed progress callback results", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const onCommandOutput = vi.fn(async () => false as const);
    const onItemEvent = vi.fn(async () => false as const);
    const ctx = buildTestCtx({
      Provider: "discord",
      ChatType: "direct",
      SessionKey: "agent:main:discord:direct:U1",
    });
    let commandOutputResult: boolean | void = undefined;
    let itemEventResult: boolean | void = undefined;
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      commandOutputResult = await opts?.onCommandOutput?.({
        phase: "end",
        name: "exec",
        status: "failed",
        exitCode: 1,
      });
      itemEventResult = await opts?.onItemEvent?.({
        kind: "tool",
        phase: "end",
        name: "exec",
        status: "failed",
      });
      return { text: "done" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { onCommandOutput, onItemEvent },
    });

    expect(onCommandOutput).toHaveBeenCalledTimes(1);
    expect(onItemEvent).toHaveBeenCalledTimes(1);
    expect(commandOutputResult).toBe(false);
    expect(itemEventResult).toBe(false);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("forwards failed group tool progress in regular verbose mode", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const onItemEvent = vi.fn();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:group:123@g.us",
      SessionKey: "agent:main:whatsapp:group:123@g.us",
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onItemEvent?.({
        itemId: "item-1",
        kind: "tool",
        name: "exec",
        status: "failed",
      });
      return { text: "done" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { onItemEvent },
    });

    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "item-1",
      kind: "tool",
      name: "exec",
      status: "failed",
    });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("keeps earlier failed progress hidden when verbose turns on later", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      sessionId: "s1",
      updatedAt: 0,
      sendPolicy: "allow",
      verboseLevel: "off",
    };
    const dispatcher = createDispatcher();
    const onCommandOutput = vi.fn();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:telegram:direct:U1",
    });
    const replyResolver = vi.fn(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onCommandOutput?.({
        phase: "end",
        name: "exec",
        status: "failed",
        exitCode: 1,
      });
      sessionStoreMocks.currentEntry = {
        ...sessionStoreMocks.currentEntry,
        verboseLevel: "on",
      };
      return { text: "done" } satisfies ReplyPayload;
    });

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        onCommandOutput,
        sourceReplyDeliveryMode: "message_tool_only",
      },
    });

    expect(onCommandOutput).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("delivers text-only tool summaries when verbose overrides preview suppression", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "direct",
      SessionKey: "agent:main:main",
    });

    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { suppressDefaultToolProgressMessages: true },
    });

    expect(dispatcher.sendToolResult).toHaveBeenCalledWith({ text: "🔧 exec: ls" });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });

  it("keeps channel-hidden tool progress suppressed when verbose is enabled", async () => {
    setNoAbort();
    sessionStoreMocks.currentEntry = {
      verboseLevel: "on",
    };
    const dispatcher = createDispatcher();
    const onToolResult = vi.fn(() => false);
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ) => {
      await opts?.onItemEvent?.({
        kind: "preamble",
        itemId: "preamble-1",
        progressText: "Checking the workspace",
      });
      await opts?.onToolResult?.({ text: "🔧 exec: ls" });
      await opts?.onToolResult?.({
        text: "💨Fast: auto-off(75s>=60s)",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      await opts?.onToolResult?.({ text: "Command failed", isError: true });
      await opts?.onPlanUpdate?.({
        phase: "update",
        steps: [{ step: "Inspect files", status: "in_progress" }],
      });
      return { text: "done" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        ChatType: "direct",
        SessionKey: "agent:main:main",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { suppressToolProgressMessages: true, onToolResult },
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "done" });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
