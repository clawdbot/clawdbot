import { describe, expect, it, vi } from "vitest";
import {
  anthropicEvents,
  captureAnthropicRequest,
  context,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";

describe("Anthropic server context management parity", () => {
  registerParityHostLifecycle();

  it.each([
    { name: "direct API key", enabled: true },
    { name: "default endpoint", model: { baseUrl: undefined }, enabled: true },
    { name: "OAuth", apiKey: "sk-ant-oat01-synthetic", enabled: false },
    { name: "proxy", model: { baseUrl: "https://proxy.example/v1" }, enabled: false },
    { name: "Bedrock", model: { provider: "amazon-bedrock" }, enabled: false },
    { name: "Vertex", model: { provider: "google-vertex" }, enabled: false },
    { name: "Foundry", model: { provider: "microsoft-foundry" }, enabled: false },
  ])("gates tool clearing for $name in both request paths", async ({ enabled, ...options }) => {
    for (const implementation of ["provider", "transport"] as const) {
      const { payload, headers } = await captureAnthropicRequest(implementation, {
        ...options,
        cacheTtlPruning: {},
      });
      expect(payload.context_management).toEqual(
        enabled
          ? {
              edits: [
                {
                  type: "clear_tool_uses_20250919",
                  trigger: { type: "input_tokens", value: 60_000 },
                  keep: { type: "tool_uses", value: 3 },
                  clear_at_least: { type: "input_tokens", value: 12_500 },
                  exclude_tools: [],
                  clear_tool_inputs: false,
                },
              ],
            }
          : undefined,
      );
      expect(
        headers.get("anthropic-beta")?.includes("context-management-2025-06-27") ?? false,
      ).toBe(enabled);
    }
  });

  it("keeps clearing enabled after simple dispatch selects the Anthropic transport alias", async () => {
    const { payload, headers } = await captureAnthropicRequest("transport", {
      transportApi: "openclaw-anthropic-messages-transport",
      cacheTtlPruning: {},
    });
    expect(payload.context_management).toEqual({
      edits: [expect.objectContaining({ type: "clear_tool_uses_20250919" })],
    });
    expect(headers.get("anthropic-beta")).toContain("context-management-2025-06-27");
  });

  it("clamps small-window thresholds and enables clearing without thinking", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      const { payload, headers } = await captureAnthropicRequest(implementation, {
        model: { contextWindow: 100_000 },
        reasoning: "off",
        cacheTtlPruning: {},
      });
      expect(payload.context_management).toEqual({
        edits: [
          expect.objectContaining({
            trigger: { type: "input_tokens", value: 50_000 },
            clear_at_least: { type: "input_tokens", value: 12_500 },
          }),
        ],
      });
      expect(headers.get("anthropic-beta")).toContain("context-management-2025-06-27");
      expect(headers.get("anthropic-beta") ?? "").not.toContain("thinking-binding-controls");
    }
  });

  it("derives thresholds, tool exclusions, and clearing-before-compaction order", async () => {
    const tools = context.tools.flatMap((tool) =>
      ["lookup", "read", "write", "exec", "search", "special+tool"].map((name) =>
        Object.assign({}, tool, { name }),
      ),
    );
    for (const implementation of ["provider", "transport"] as const) {
      const { payload, headers } = await captureAnthropicRequest(implementation, {
        model: { contextWindow: 1_000_000 },
        context: { ...context, tools },
        cacheTtlPruning: {
          tools: {
            allow: ["READ", "look*", "write", "special+*"],
            deny: ["write", "ex*", "retired_tool"],
          },
        },
        anthropicServerCompaction: true,
        anthropicCompactThreshold: 650_000,
        headers: { "Anthropic-Beta": "synthetic-beta" },
      });
      expect(payload.context_management).toEqual({
        edits: [
          {
            type: "clear_tool_uses_20250919",
            trigger: { type: "input_tokens", value: 300_000 },
            keep: { type: "tool_uses", value: 3 },
            clear_at_least: { type: "input_tokens", value: 50_000 },
            exclude_tools: ["exec", "retired_tool", "search", "write"],
            clear_tool_inputs: false,
          },
          { type: "compact_20260112", trigger: { type: "input_tokens", value: 650_000 } },
        ],
      });
      expect(headers.get("anthropic-beta")).toContain("synthetic-beta");
      expect(headers.get("anthropic-beta")).toContain("context-management-2025-06-27");
    }
  });

  it("keeps explicit context management and omits clearing without cache-TTL pruning", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      for (const options of [{}, { cacheTtlPruning: {}, contextManagement: { edits: [] } }]) {
        const { payload, headers } = await captureAnthropicRequest(implementation, options);
        expect(payload.context_management).toEqual(options.contextManagement);
        expect(headers.get("anthropic-beta") ?? "").not.toContain("context-management-2025-06-27");
      }
    }
  });

  it("respects the effective environment endpoint", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example/v1");
    for (const implementation of ["provider", "transport"] as const) {
      const { payload, headers } = await captureAnthropicRequest(implementation, {
        model: { baseUrl: undefined },
        cacheTtlPruning: {},
      });
      expect(payload.context_management).toBeUndefined();
      expect(headers.get("anthropic-beta") ?? "").not.toContain("context-management-2025-06-27");
    }
  });

  it("logs bounded aggregate clearing counts from the final message delta", async () => {
    const events = anthropicEvents.map((event) =>
      event.type === "message_delta"
        ? Object.assign({}, event, {
            context_management: {
              applied_edits: [
                {
                  type: "clear_tool_uses_20250919",
                  cleared_tool_uses: 8,
                  cleared_input_tokens: 50_000,
                },
                {
                  type: "clear_tool_uses_20250919",
                  cleared_tool_uses: 2,
                  cleared_input_tokens: 5_000,
                },
                { type: "future", content: "must not log" },
              ],
            },
          })
        : event,
    );
    for (const implementation of ["provider", "transport"] as const) {
      const { info } = await captureAnthropicRequest(implementation, { events });
      expect(info).toEqual([
        "server-side context edit: cleared 10 tool results (55000 input tokens)",
      ]);
      const empty = await captureAnthropicRequest(implementation);
      expect(empty.info).toEqual([]);
    }
  });
});
