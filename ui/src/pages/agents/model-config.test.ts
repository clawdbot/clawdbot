// @vitest-environment node
// Control UI tests cover canonical per-agent model config writes.
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
import { createRuntimeConfigCapability } from "../../lib/config/index.ts";
import { stageAgentModelFallbacks, stageAgentPrimaryModel } from "./model-config.ts";

function createRuntimeConfig(sourceConfig: Record<string, unknown>) {
  const client = {
    request: vi.fn(async (method: string) =>
      method === "config.get"
        ? {
            sourceConfig,
            hash: "hash-1",
            valid: true,
            issues: [],
          }
        : { hash: "hash-2" },
    ),
  } as unknown as GatewayBrowserClient;
  const snapshot = {
    client,
    phase: "connected" as ApplicationGatewayPhase,
    sessionKey: "main",
  };
  return createRuntimeConfigCapability({
    snapshot,
    subscribe: () => () => undefined,
  });
}

describe("agent model config", () => {
  it("writes primary and fallback changes through keyed agent entries", async () => {
    const runtimeConfig = createRuntimeConfig({
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        entries: { main: { default: true } },
      },
    });
    await runtimeConfig.ensureLoaded();

    stageAgentPrimaryModel(runtimeConfig, "main", "anthropic/claude-sonnet-4-6");
    stageAgentModelFallbacks(runtimeConfig, "main", ["openai/gpt-5.4"]);

    expect(runtimeConfig.state.configForm).toEqual({
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        entries: {
          main: {
            default: true,
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["openai/gpt-5.4"],
            },
          },
        },
      },
    });
    expect(runtimeConfig.state.configForm?.agents).not.toHaveProperty("list");
    runtimeConfig.dispose();
  });
});
