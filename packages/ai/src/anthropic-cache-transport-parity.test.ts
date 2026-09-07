import type { Context, Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import {
  anthropicModel,
  captureAnthropicRequest,
  context,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "./utils/system-prompt-cache-boundary.js";

function markers(value: unknown, path = ""): Array<{ path: string; control: unknown }> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => markers(item, `${path}[${index}]`));
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) =>
    key === "cache_control"
      ? [{ path, control: item }]
      : markers(item, path ? `${path}.${key}` : key),
  );
}

function appendToolTurn(messages: Context["messages"], turn: number): Context["messages"] {
  return [
    ...messages,
    {
      role: "assistant",
      api: anthropicModel.api,
      provider: anthropicModel.provider,
      model: anthropicModel.id,
      timestamp: turn * 2,
      stopReason: "toolUse",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      content: [
        { type: "toolCall", id: `call_${turn}`, name: "lookup", arguments: { query: "value" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: `call_${turn}`,
      toolName: "lookup",
      timestamp: turn * 2 + 1,
      content: [{ type: "text", text: `Result ${turn}` }],
      isError: false,
    },
  ];
}

const routes: Array<{
  name: string;
  apiKey?: string;
  model?: Partial<Model<"anthropic-messages">>;
  toolCache: boolean;
  longCache?: boolean;
}> = [
  { name: "direct API key", toolCache: true },
  { name: "OAuth", apiKey: "sk-ant-oat01-synthetic", toolCache: true },
  { name: "Foundry", model: { provider: "microsoft-foundry" }, toolCache: true },
  { name: "proxy", model: { baseUrl: "https://proxy.example/v1" }, toolCache: true },
  { name: "Fireworks", model: { provider: "fireworks" }, toolCache: false, longCache: false },
  {
    name: "incompatible proxy",
    model: { baseUrl: "https://proxy.example/v1", compat: { supportsCacheControlOnTools: false } },
    toolCache: false,
  },
];

describe("Anthropic cache checkpoint transport parity", () => {
  registerParityHostLifecycle();

  it.each([
    { name: "absent", systemPrompt: undefined },
    { name: "empty", systemPrompt: "" },
    { name: "only dynamic", systemPrompt: `${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic` },
    { name: "empty boundary", systemPrompt: SYSTEM_PROMPT_CACHE_BOUNDARY },
  ])(
    "keeps the OAuth identity fallback checkpoint with $name system text",
    async ({ systemPrompt }) => {
      for (const implementation of ["provider", "transport"] as const) {
        const { payload } = await captureAnthropicRequest(implementation, {
          apiKey: "sk-ant-oat01-synthetic",
          cacheRetention: "short",
          context: { ...context, systemPrompt },
        });
        expect(
          markers(payload)
            .map((marker) => marker.path)
            .toSorted(),
        ).toEqual(["messages[0].content[0]", "system[1]", "tools[0]"]);
        expect(payload.system).toEqual(
          expect.arrayContaining([
            {
              type: "text",
              text: "x-anthropic-billing-header: cc_version=2.1.75; cc_entrypoint=sdk-cli;",
            },
            {
              type: "text",
              text: "You are Claude Code, Anthropic's official CLI for Claude.",
              cache_control: { type: "ephemeral" },
            },
          ]),
        );
      }
    },
  );

  it.each([
    { name: "direct", baseUrl: "https://api.anthropic.com", long: true },
    { name: "default", baseUrl: undefined, long: true },
    { name: "proxy", baseUrl: "https://proxy.example/v1", long: false },
    {
      name: "environment proxy",
      baseUrl: undefined,
      envBaseUrl: "https://proxy.example/v1",
      long: false,
    },
  ])(
    "keeps implicit long TTL host gating identical for $name",
    async ({ baseUrl, envBaseUrl, long }) => {
      vi.stubEnv("OPENCLAW_CACHE_RETENTION", "long");
      vi.stubEnv("ANTHROPIC_BASE_URL", envBaseUrl);
      for (const implementation of ["provider", "transport"] as const) {
        const { payload } = await captureAnthropicRequest(implementation, { model: { baseUrl } });
        const actual = markers(payload);
        expect(actual).toHaveLength(3);
        for (const marker of actual) {
          expect(marker.control).toEqual({ type: "ephemeral", ...(long ? { ttl: "1h" } : {}) });
        }
      }
    },
  );

  for (const route of routes) {
    for (const withTools of [true, false]) {
      it.each(["short", "long", "none"] as const)(
        `${route.name}, tools=${withTools}, retention=%s: checkpoints stay within budget and advance`,
        async (cacheRetention) => {
          let messages: Context["messages"] = context.messages;
          const previousTools = new Map<string, unknown>();
          for (let turn = 0; turn < 3; turn++) {
            if (turn > 0) {
              messages = appendToolTurn(messages, turn);
            }
            const captured = [];
            for (const implementation of ["provider", "transport"] as const) {
              const { payload } = await captureAnthropicRequest(implementation, {
                ...route,
                cacheRetention,
                context: {
                  ...context,
                  tools: withTools
                    ? context.tools.flatMap((tool) => [tool, { ...tool, name: "read" }])
                    : [],
                  systemPrompt: `Stable instructions version ${turn === 2 ? 2 : 1}${SYSTEM_PROMPT_CACHE_BOUNDARY}Turn ${turn}`,
                  messages,
                },
              });
              const actual = markers(payload);
              const expectedPaths =
                cacheRetention === "none"
                  ? []
                  : [
                      ...(withTools && route.toolCache ? ["tools[1]"] : []),
                      `system[${route.apiKey ? 2 : 0}]`,
                      "messages[0].content[0]",
                      ...(turn > 0 ? [`messages[${turn * 2}].content[0]`] : []),
                    ];
              expect(actual.map((marker) => marker.path).toSorted()).toEqual(
                expectedPaths.toSorted(),
              );
              expect(actual.length).toBeLessThanOrEqual(4);
              for (const marker of actual) {
                expect(marker.control).toEqual({
                  type: "ephemeral",
                  ...(cacheRetention === "long" && route.longCache !== false ? { ttl: "1h" } : {}),
                });
              }
              if (turn > 0) {
                expect(payload.tools).toEqual(previousTools.get(implementation));
              }
              previousTools.set(implementation, payload.tools);
              captured.push({ markers: actual, system: payload.system });
            }
            expect(captured[1]).toEqual(captured[0]);
          }
        },
      );
    }
  }
});
