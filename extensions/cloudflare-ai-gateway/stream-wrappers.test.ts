import type { StreamFn } from "@mariozechner/pi-agent-core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  createCloudflareAiGatewayAnthropicThinkingPrefillWrapper,
  wrapCloudflareAiGatewayProviderStream,
} from "./stream-wrappers.js";

const { warnMock } = vi.hoisted(() => ({
  warnMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
  }),
}));

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/runtime-env");
  vi.resetModules();
});

function createPayloadBaseStream(payload: Record<string, unknown>): StreamFn {
  return ((model, _context, options) => {
    options?.onPayload?.(payload as never, model as never);
    return {} as ReturnType<StreamFn>;
  }) as StreamFn;
}

function runWrapper(payload: Record<string, unknown>): Record<string, unknown> {
  const wrapper = createCloudflareAiGatewayAnthropicThinkingPrefillWrapper(
    createPayloadBaseStream(payload),
  );
  void wrapper(
    { provider: "cloudflare-ai-gateway", api: "anthropic-messages" } as never,
    {} as never,
    {},
  );
  return payload;
}

describe("createCloudflareAiGatewayAnthropicThinkingPrefillWrapper", () => {
  beforeEach(() => {
    warnMock.mockClear();
  });

  it("removes trailing assistant prefill when thinking is enabled", () => {
    const payload = runWrapper({
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    });

    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
    expect(warnMock).toHaveBeenCalledWith(
      "removed 1 trailing assistant prefill message because Anthropic extended thinking requires conversations to end with a user turn",
    );
  });

  it("removes multiple trailing assistant prefill messages until the conversation ends with user", () => {
    const payload = runWrapper({
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
        { role: "assistant", content: '"status"' },
      ],
    });

    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
    expect(warnMock).toHaveBeenCalledWith(
      "removed 2 trailing assistant prefill messages because Anthropic extended thinking requires conversations to end with a user turn",
    );
  });

  it("keeps assistant prefill when thinking is disabled", () => {
    const payload = runWrapper({
      thinking: { type: "disabled" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    });

    expect(payload.messages).toHaveLength(2);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("keeps trailing assistant tool use turns when thinking is enabled", () => {
    const payload = runWrapper({
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "Read a file." },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Read" }],
        },
      ],
    });

    expect(payload.messages).toHaveLength(2);
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe("wrapCloudflareAiGatewayProviderStream", () => {
  beforeEach(() => {
    warnMock.mockClear();
  });

  it("patches Anthropic Messages models", () => {
    const payload = {
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    };
    const wrapped = wrapCloudflareAiGatewayProviderStream({
      model: { api: "anthropic-messages" },
      streamFn: createPayloadBaseStream(payload),
    } as never);

    void wrapped?.(
      { provider: "cloudflare-ai-gateway", api: "anthropic-messages" } as never,
      {} as never,
      {},
    );

    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
  });

  it("leaves non-Anthropic model APIs on the original stream path", () => {
    let onPayloadWasInstalled = false;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      onPayloadWasInstalled = typeof options?.onPayload === "function";
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = wrapCloudflareAiGatewayProviderStream({
      model: { api: "openai-completions" },
      streamFn: baseStreamFn,
    } as never);
    void wrapped?.({ api: "openai-completions" } as never, {} as never, {});

    expect(wrapped).toBe(baseStreamFn);
    expect(onPayloadWasInstalled).toBe(false);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it("treats missing model API as the plugin's default Anthropic Messages route", () => {
    expect(__testing.shouldPatchAnthropicMessagesPayload({} as never)).toBe(true);
  });
});
