// Tests message preprocessing hooks before reply dispatch.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { clearInternalHooks, registerInternalHook } from "../../hooks/internal-hooks.js";
import type { FinalizedMsgContext } from "../templating.js";
import { emitPreAgentMessageHooks } from "./message-preprocess-hooks.js";

function makeCtx(overrides: Partial<FinalizedMsgContext> = {}): FinalizedMsgContext {
  return {
    SessionKey: "agent:main:telegram:chat-1",
    From: "telegram:user:1",
    To: "telegram:chat-1",
    Body: "<media:audio>",
    BodyForAgent: "[Audio] Transcript: hello",
    BodyForCommands: "<media:audio>",
    Transcript: "hello",
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:chat-1",
    Timestamp: 1710000000,
    MessageSid: "msg-1",
    GroupChannel: "ops",
    ...overrides,
  } as FinalizedMsgContext;
}

describe("emitPreAgentMessageHooks", () => {
  beforeEach(() => {
    clearInternalHooks();
  });

  it("emits transcribed and preprocessed events when transcript exists", async () => {
    const actions: string[] = [];
    registerInternalHook("message", (event) => {
      actions.push(event.action);
    });

    emitPreAgentMessageHooks({
      ctx: makeCtx(),
      cfg: {} as OpenClawConfig,
      isFastTestEnv: false,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(actions).toEqual(["transcribed", "preprocessed"]);
  });

  it("emits only preprocessed when transcript is missing", async () => {
    const actions: string[] = [];
    registerInternalHook("message", (event) => {
      actions.push(event.action);
    });

    emitPreAgentMessageHooks({
      ctx: makeCtx({ Transcript: undefined }),
      cfg: {} as OpenClawConfig,
      isFastTestEnv: false,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(actions).toEqual(["preprocessed"]);
  });

  it("skips hook emission in fast-test mode", async () => {
    const handler = vi.fn();
    registerInternalHook("message", handler);

    emitPreAgentMessageHooks({
      ctx: makeCtx(),
      cfg: {} as OpenClawConfig,
      isFastTestEnv: true,
    });
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
  });

  it("skips hook emission without session key", async () => {
    const handler = vi.fn();
    registerInternalHook("message", handler);

    emitPreAgentMessageHooks({
      ctx: makeCtx({ SessionKey: " " }),
      cfg: {} as OpenClawConfig,
      isFastTestEnv: false,
    });
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
  });
});
