// Mcp Channel Limits script supports OpenClaw repository automation.
import { readPositiveIntEnv } from "./lib/env-limits.mjs";

export type McpChannelLimits = {
  connectTimeoutMs: number;
  gatewayEventRetainLimit: number;
  rawMessageRetainLimit: number;
};

export function readMcpChannelLimits(env: NodeJS.ProcessEnv = process.env): McpChannelLimits {
  return {
    connectTimeoutMs: readPositiveIntEnv("OPENCLAW_MCP_CHANNELS_CONNECT_TIMEOUT_MS", 60_000, env),
    gatewayEventRetainLimit: readPositiveIntEnv(
      "OPENCLAW_MCP_CHANNELS_GATEWAY_EVENT_RETAIN_LIMIT",
      2_000,
      env,
    ),
    rawMessageRetainLimit: readPositiveIntEnv(
      "OPENCLAW_MCP_CHANNELS_RAW_MESSAGE_RETAIN_LIMIT",
      2_000,
      env,
    ),
  };
}
