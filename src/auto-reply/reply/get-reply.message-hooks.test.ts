import { beforeEach, describe, expect, it, vi } from "vitest";
import { logVerbose } from "../../globals.js";
import type { MsgContext } from "../templating.js";
import { withFastReplyConfig } from "./get-reply-fast-path.js";
import {
  buildGetReplyGroupCtx,
  createGetReplySessionState,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import { registerGetReplyCommonMocks } from "./get-reply.test-mocks.js";

const mocks = vi.hoisted(() => ({
  applyMediaUnderstanding: vi.fn(async (..._args: unknown[]) => undefined),
  applyLinkUnderstanding: vi.fn(async (..._args: unknown[]) => undefined),
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async (..._args: unknown[]) => undefined),
  resolveReplyDirectives: vi.fn(),
  initSessionState: vi.fn(),
}));

registerGetReplyCommonMocks();

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: mocks.createInternalHookEvent,
  triggerInternalHook: mocks.triggerInternalHook,
}));
vi.mock("../../link-understanding/apply.js", () => ({
  applyLinkUnderstanding: mocks.applyLinkUnderstanding,
}));
vi.mock("../../link-understanding/apply.runtime.js", () => ({
  applyLinkUnderstanding: mocks.applyLinkUnderstanding,
}));
vi.mock("../../media-understanding/apply.js", () => ({
  applyMediaUnderstanding: mocks.applyMediaUnderstanding,
}));
vi.mock("../../media-understanding/apply.runtime.js", () => ({
  applyMediaUnderstanding: mocks.applyMediaUnderstanding,
}));
vi.mock("./commands-core.js", () => ({
  emitResetCommandHooks: vi.fn(async () => undefined),
}));
registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
}

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return buildGetReplyGroupCtx({
    Body: "<media:audio>",
    BodyForAgent: "<media:audio>",
    RawBody: "<media:audio>",
    CommandBody: "<media:audio>",
    GroupChannel: "ops",
    MediaPath: "/tmp/voice.ogg",
    MediaUrl: "https://example.test/voice.ogg",
    MediaType: "audio/ogg",
    ...overrides,
  });
}

describe("getReplyFromConfig message hooks", () => {
  beforeEach(async () => {
    await loadGetReplyRuntimeForTest();
    delete process.env.OPENCLAW_TEST_FAST;
    mocks.applyMediaUnderstanding.mockReset();
    mocks.applyLinkUnderstanding.mockReset();
    mocks.createInternalHookEvent.mockReset();
    mocks.triggerInternalHook.mockReset();
    mocks.resolveReplyDirectives.mockReset();
    mocks.initSessionState.mockReset();
    vi.mocked(logVerbose).mockReset();

    mocks.applyMediaUnderstanding.mockImplementation(async (...args: unknown[]) => {
      const { ctx } = args[0] as { ctx: MsgContext };
      ctx.Transcript = "voice transcript";
      ctx.Body = "[Audio]\nTranscript:\nvoice transcript";
      ctx.BodyForAgent = "[Audio]\nTranscript:\nvoice transcript";
    });
    mocks.applyLinkUnderstanding.mockResolvedValue(undefined);
    mocks.createInternalHookEvent.mockImplementation(
      (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
        type,
        action,
        sessionKey,
        context,
        timestamp: new Date(),
        messages: [],
      }),
    );
    mocks.triggerInternalHook.mockResolvedValue(undefined);
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionKey: "agent:main:telegram:-100123",
        sessionScope: "per-chat",
        isGroup: true,
      }),
    );
  });

  it("emits transcribed + preprocessed hooks with enriched context", async () => {
    const ctx = buildCtx();

    await getReplyFromConfig(ctx, undefined, withFastReplyConfig({}));

    expect(mocks.createInternalHookEvent).toHaveBeenCalledTimes(2);
    expect(mocks.createInternalHookEvent).toHaveBeenNthCalledWith(
      1,
      "message",
      "transcribed",
      "agent:main:telegram:-100123",
      expect.objectContaining({
        transcript: "voice transcript",
        channelId: "telegram",
        conversationId: "telegram:-100123",
      }),
    );
    expect(mocks.createInternalHookEvent).toHaveBeenNthCalledWith(
      2,
      "message",
      "preprocessed",
      "agent:main:telegram:-100123",
      expect.objectContaining({
        transcript: "voice transcript",
        isGroup: true,
        groupId: "telegram:-100123",
      }),
    );
    expect(mocks.triggerInternalHook).toHaveBeenCalledTimes(2);
  });

  it("emits only preprocessed when no transcript is produced", async () => {
    mocks.applyMediaUnderstanding.mockImplementationOnce(async (...args: unknown[]) => {
      const { ctx } = args[0] as { ctx: MsgContext };
      ctx.Transcript = undefined;
      ctx.Body = "<media:audio>";
      ctx.BodyForAgent = "<media:audio>";
    });

    await getReplyFromConfig(buildCtx(), undefined, withFastReplyConfig({}));

    expect(mocks.createInternalHookEvent).toHaveBeenCalledTimes(1);
    expect(mocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "preprocessed",
      "agent:main:telegram:-100123",
      expect.any(Object),
    );
  });

  it("skips message hooks in fast test mode", async () => {
    process.env.OPENCLAW_TEST_FAST = "1";

    await getReplyFromConfig(buildCtx(), undefined, withFastReplyConfig({}));

    expect(mocks.applyMediaUnderstanding).not.toHaveBeenCalled();
    expect(mocks.applyLinkUnderstanding).not.toHaveBeenCalled();
    expect(mocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(mocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("skips message hooks when SessionKey is unavailable", async () => {
    await getReplyFromConfig(
      buildCtx({ SessionKey: undefined }),
      undefined,
      withFastReplyConfig({}),
    );

    expect(mocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(mocks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("skips media and link understanding on plain text without attachments or urls", async () => {
    await getReplyFromConfig(
      buildCtx({
        Body: "hello there",
        BodyForAgent: "hello there",
        RawBody: "hello there",
        CommandBody: "hello there",
        BodyForCommands: "hello there",
        MediaPath: undefined,
        MediaUrl: undefined,
        MediaPaths: undefined,
        MediaUrls: undefined,
        MediaTypes: undefined,
        Sticker: undefined,
        StickerMediaIncluded: undefined,
      }),
      undefined,
      withFastReplyConfig({}),
    );

    expect(mocks.applyMediaUnderstanding).not.toHaveBeenCalled();
    expect(mocks.applyLinkUnderstanding).not.toHaveBeenCalled();
  });

  it("continues dispatching when media understanding fails before reply routing", async () => {
    mocks.applyMediaUnderstanding.mockRejectedValueOnce(
      new Error("Cannot find module '/tmp/openclaw/dist/media-understanding/apply.runtime-old.js'"),
    );

    const reply = await getReplyFromConfig(buildCtx(), undefined, withFastReplyConfig({}));

    expect(reply).toEqual({ text: "ok" });
    expect(mocks.applyMediaUnderstanding).toHaveBeenCalledTimes(1);
    expect(mocks.initSessionState).toHaveBeenCalledTimes(1);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledTimes(1);
    expect(mocks.createInternalHookEvent).toHaveBeenCalledTimes(1);
    expect(mocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "preprocessed",
      "agent:main:telegram:-100123",
      expect.any(Object),
    );
    expect(logVerbose).toHaveBeenCalledWith(
      expect.stringContaining("media understanding failed, proceeding with raw content"),
    );
  });

  it("continues dispatching URL messages when link understanding fails before reply routing", async () => {
    mocks.applyLinkUnderstanding.mockRejectedValueOnce(
      new Error("Cannot find module '/tmp/openclaw/dist/link-understanding/apply.runtime-old.js'"),
    );

    const reply = await getReplyFromConfig(
      buildCtx({
        Body: "read https://example.test/page",
        BodyForAgent: "read https://example.test/page",
        RawBody: "read https://example.test/page",
        CommandBody: "read https://example.test/page",
        BodyForCommands: "read https://example.test/page",
        MediaPath: undefined,
        MediaUrl: undefined,
        MediaPaths: undefined,
        MediaUrls: undefined,
        MediaTypes: undefined,
        MediaType: undefined,
        Sticker: undefined,
        StickerMediaIncluded: undefined,
      }),
      undefined,
      withFastReplyConfig({}),
    );

    expect(reply).toEqual({ text: "ok" });
    expect(mocks.applyMediaUnderstanding).not.toHaveBeenCalled();
    expect(mocks.applyLinkUnderstanding).toHaveBeenCalledTimes(1);
    expect(mocks.initSessionState).toHaveBeenCalledTimes(1);
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledTimes(1);
    expect(logVerbose).toHaveBeenCalledWith(
      expect.stringContaining("link understanding failed, proceeding with raw content"),
    );
  });
});
