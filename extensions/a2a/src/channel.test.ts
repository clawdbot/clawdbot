import { readFileSync } from "node:fs";
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it, vi } from "vitest";
import { a2aChannelPlugin } from "./channel.js";
import { a2aPluginConfigSchema } from "./config-schema.js";
import type { A2aCoreConfig } from "./types.js";

/** Outbound A2A bodies are serialized JSON strings; assert that before parsing. */
function parseA2aOutboundBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error(`expected a serialized A2A request body, got ${typeof body}`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

const a2aManifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  channelConfigs: {
    a2a: {
      schema: Parameters<typeof validateJsonSchemaValue>[0]["schema"];
      uiHints: Record<string, { sensitive?: boolean }>;
    };
  };
};

function assertConfigAcceptance(value: unknown, expected: boolean, label: string): void {
  const runtime = a2aPluginConfigSchema.runtime;
  if (!runtime) {
    throw new Error("expected A2A runtime config schema");
  }
  expect(runtime.safeParse(value).success, `${label}: runtime`).toBe(expected);
  for (const [schemaName, schema] of [
    ["runtime-json", a2aPluginConfigSchema.schema],
    ["cold-manifest", a2aManifest.channelConfigs.a2a.schema],
  ] as const) {
    const result = validateJsonSchemaValue({
      cacheKey: `a2a.channel.config.${schemaName}`,
      schema,
      value,
    });
    expect(result.ok, `${label}: ${schemaName}`).toBe(expected);
  }
}

describe("A2A channel configuration", () => {
  it("keeps runtime and cold-manifest validation aligned for supported settings", () => {
    assertConfigAcceptance(
      {
        enabled: true,
        advertisedUrl: "https://gateway.example.test",
        replyTimeoutMs: 120_000,
        rateLimitPerMinute: 30,
        exposeAgents: ["assistant"],
        peers: {
          "hermes.bot-1": {
            token: "test-inbound-token",
            url: "https://peer.example.test/a2a/v1",
            outboundToken: "test-outbound-token",
          },
        },
      },
      true,
      "complete channel config",
    );
    expect(a2aPluginConfigSchema.uiHints?.["peers.*.token"]?.sensitive).toBe(true);
    expect(a2aPluginConfigSchema.uiHints?.["peers.*.outboundToken"]?.sensitive).toBe(true);
    expect(a2aManifest.channelConfigs.a2a.uiHints["peers.*.token"]?.sensitive).toBe(true);
    expect(a2aManifest.channelConfigs.a2a.uiHints["peers.*.outboundToken"]?.sensitive).toBe(true);
  });

  it.each([
    ["uppercase peer name", { peers: { Hermes: { token: "test-token" } } }],
    ["invalid peer punctuation", { peers: { "bad/peer": { token: "test-token" } } }],
    ["empty peer token", { peers: { hermes: { token: "" } } }],
    ["missing peer token", { peers: { hermes: { url: "https://peer.example.test" } } }],
    ["empty outbound token", { peers: { hermes: { token: "test", outboundToken: "" } } }],
    ["non-HTTP advertised URL", { advertisedUrl: "ftp://gateway.example.test" }],
    ["non-HTTP peer URL", { peers: { hermes: { token: "test", url: "file:///tmp/peer" } } }],
    ["reply timeout below minimum", { replyTimeoutMs: 4_999 }],
    ["reply timeout above maximum", { replyTimeoutMs: 600_001 }],
    ["negative rate limit", { rateLimitPerMinute: -1 }],
    ["unsupported multiple accounts", { accounts: { work: {} } }],
    ["unknown channel field", { target: "https://untrusted.example.test" }],
  ])("rejects %s in every validation surface", (label, value) => {
    assertConfigAcceptance(value, false, label);
  });

  it("exposes only the configured default account and peer-derived sender allowlist", () => {
    const cfg: A2aCoreConfig = {
      channels: {
        a2a: {
          peers: {
            hermes: { token: "test-hermes-token" },
            crew: { token: "test-crew-token" },
          },
        },
      },
    };

    expect(a2aChannelPlugin.config.listAccountIds(cfg)).toEqual(["default"]);
    expect(a2aChannelPlugin.config.resolveAccount(cfg)).toMatchObject({
      accountId: "default",
      enabled: true,
      configured: true,
    });
    expect(a2aChannelPlugin.config.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual([
      "hermes",
      "crew",
    ]);
    expect(a2aChannelPlugin.config.listAccountIds({})).toEqual([]);
    expect(a2aChannelPlugin.config.resolveAccount({ channels: { a2a: {} } }).configured).toBe(
      false,
    );
  });
});

describe("A2A channel message adapter", () => {
  it("backs its only declared capability with an authenticated JSON-RPC send and receipt", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "response-id",
          result: { task: { id: "task-42" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    try {
      const cfg: A2aCoreConfig = {
        channels: {
          a2a: {
            peers: {
              hermes: {
                token: "test-inbound-token",
                url: "https://peer.example.test/a2a/v1",
                outboundToken: "test-outbound-token",
              },
            },
          },
        },
      };
      const adapter = a2aChannelPlugin.message;
      const sendText = adapter?.send?.text;
      if (!adapter || !sendText) {
        throw new Error("expected A2A channel message adapter with text sender");
      }
      expect(adapter.send?.media).toBeUndefined();

      await verifyChannelMessageAdapterCapabilityProofs({
        adapterName: "a2aChannelMessageAdapter",
        adapter,
        proofs: {
          text: async () => {
            const result = await sendText({
              cfg,
              accountId: "default",
              to: "hermes",
              text: "hello",
            });
            expect(fetchSpy).toHaveBeenCalledOnce();
            const [url, request] = fetchSpy.mock.calls[0] ?? [];
            expect(url).toBe("https://peer.example.test/a2a/v1");
            expect(request).toMatchObject({
              headers: { authorization: "Bearer test-outbound-token" },
              method: "POST",
              // The SSRF guard inspects redirects itself instead of delegating to fetch.
              redirect: "manual",
            });
            expect(parseA2aOutboundBody(request?.body)).toMatchObject({
              jsonrpc: "2.0",
              method: "SendMessage",
              params: {
                message: {
                  role: "ROLE_USER",
                  contextId: "ctx-oc-hermes",
                  parts: [{ text: "hello" }],
                },
                configuration: { returnImmediately: true },
              },
            });
            expect(result.messageId).toBe("task-42");
            expect(result.receipt.parts[0]).toMatchObject({
              kind: "text",
              platformMessageId: "task-42",
            });
          },
        },
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
