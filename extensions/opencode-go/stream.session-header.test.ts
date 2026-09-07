import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createOpencodeGoSessionHeaderWrapper } from "./stream.js";

type ProviderStreamFn = NonNullable<ProviderWrapStreamFnContext["streamFn"]>;

function model(
  api: "openai-completions" | "anthropic-messages",
  baseUrl: string,
  headers?: Record<string, string>,
) {
  return { provider: "opencode-go", id: "fixture", api, baseUrl, headers } as never;
}

describe("OpenCode Go session header wrapper", () => {
  it.each([
    ["openai-completions", "https://opencode.ai/zen/go/v1"],
    ["anthropic-messages", "https://opencode.ai/zen/go"],
  ] as const)("attaches stable conversation identity to %s requests", async (api, baseUrl) => {
    const streamFn = vi.fn<ProviderStreamFn>(() => ({}) as never);
    const wrapped = createOpencodeGoSessionHeaderWrapper(streamFn);

    await wrapped?.(model(api, baseUrl), { messages: [] } as never, {
      sessionId: "conversation-123",
    });

    expect(streamFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ headers: { "x-opencode-session": "conversation-123" } }),
    );
  });

  it("preserves explicit request identity case-insensitively", async () => {
    const streamFn = vi.fn<ProviderStreamFn>(() => ({}) as never);
    const wrapped = createOpencodeGoSessionHeaderWrapper(streamFn);

    await wrapped?.(model("openai-completions", "https://opencode.ai/zen/go/v1"), {} as never, {
      sessionId: "conversation-123",
      headers: { "X-OpenCode-Session": "operator-route" },
    });

    expect(streamFn.mock.calls[0]?.[2]?.headers).toEqual({
      "X-OpenCode-Session": "operator-route",
    });
  });

  it("preserves explicit model identity case-insensitively", async () => {
    const streamFn = vi.fn<ProviderStreamFn>(() => ({}) as never);
    const wrapped = createOpencodeGoSessionHeaderWrapper(streamFn);

    await wrapped?.(
      model("anthropic-messages", "https://opencode.ai/zen/go", {
        "X-OpenCode-Session": "model-route",
      }),
      {} as never,
      { sessionId: "conversation-123" },
    );

    expect(streamFn.mock.calls[0]?.[2]?.headers).toBeUndefined();
  });

  it("does not attach identity to custom proxy routes", async () => {
    const streamFn = vi.fn<ProviderStreamFn>(() => ({}) as never);
    const wrapped = createOpencodeGoSessionHeaderWrapper(streamFn);

    await wrapped?.(model("openai-completions", "https://proxy.example.com/v1"), {} as never, {
      sessionId: "conversation-123",
    });

    expect(streamFn.mock.calls[0]?.[2]?.headers).toBeUndefined();
  });
});
