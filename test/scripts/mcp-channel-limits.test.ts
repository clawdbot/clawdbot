// Mcp Channel Limits tests cover mcp channel limits script behavior.
import { describe, expect, it } from "vitest";
import { readMcpChannelLimits } from "../../scripts/e2e/mcp-channel-limits.ts";

describe("MCP channel E2E limits", () => {
  it("uses documented defaults when env overrides are absent", () => {
    expect(readMcpChannelLimits({})).toEqual({
      connectTimeoutMs: 60_000,
      gatewayEventRetainLimit: 2_000,
      rawMessageRetainLimit: 2_000,
    });
  });

  it("accepts strict positive integer overrides", () => {
    expect(
      readMcpChannelLimits({
        OPENCLAW_MCP_CHANNELS_CONNECT_TIMEOUT_MS: "120000",
        OPENCLAW_MCP_CHANNELS_GATEWAY_EVENT_RETAIN_LIMIT: "500",
        OPENCLAW_MCP_CHANNELS_RAW_MESSAGE_RETAIN_LIMIT: "25",
      }),
    ).toEqual({
      connectTimeoutMs: 120_000,
      gatewayEventRetainLimit: 500,
      rawMessageRetainLimit: 25,
    });
  });

  it("rejects loose numeric env values instead of parsing prefixes", () => {
    expect(() =>
      readMcpChannelLimits({
        OPENCLAW_MCP_CHANNELS_CONNECT_TIMEOUT_MS: "1e3",
      }),
    ).toThrow("invalid OPENCLAW_MCP_CHANNELS_CONNECT_TIMEOUT_MS: 1e3");
    expect(() =>
      readMcpChannelLimits({
        OPENCLAW_MCP_CHANNELS_RAW_MESSAGE_RETAIN_LIMIT: "1000ms",
      }),
    ).toThrow("invalid OPENCLAW_MCP_CHANNELS_RAW_MESSAGE_RETAIN_LIMIT: 1000ms");
  });
});
