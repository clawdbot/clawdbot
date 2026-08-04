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

  it("does not autosave a staged model through a replacement Gateway", async () => {
    vi.useFakeTimers();
    let stored = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        entries: { main: { default: true } },
      },
    };
    let hash = "hash-1";
    const writes: Array<{ connection: "first" | "replacement"; raw: string; baseHash: string }> =
      [];
    const createClient = (connection: "first" | "replacement") =>
      ({
        request: vi.fn(async (method: string, params?: unknown) => {
          if (method === "config.get") {
            return {
              sourceConfig: stored,
              raw: JSON.stringify(stored),
              hash,
              valid: true,
              issues: [],
            };
          }
          if (method === "config.set") {
            const { raw, baseHash } = params as { raw: string; baseHash: string };
            writes.push({ connection, raw, baseHash });
            stored = JSON.parse(raw) as typeof stored;
            hash = "hash-2";
            return { hash };
          }
          return {};
        }),
      }) as unknown as GatewayBrowserClient;
    const firstClient = createClient("first");
    const replacementClient = createClient("replacement");
    let snapshot = {
      client: firstClient,
      phase: "connected" as ApplicationGatewayPhase,
      sessionKey: "main",
    };
    const listeners = new Set<(next: typeof snapshot) => void>();
    const runtimeConfig = createRuntimeConfigCapability({
      get snapshot() {
        return snapshot;
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const publish = (client: GatewayBrowserClient, phase: ApplicationGatewayPhase) => {
      snapshot = { client, phase, sessionKey: "main" };
      for (const listener of listeners) {
        listener(snapshot);
      }
    };

    await runtimeConfig.ensureLoaded();
    stageAgentPrimaryModel(runtimeConfig, "main", "anthropic/claude-sonnet-4-6");
    publish(firstClient, "reconnecting");
    publish(replacementClient, "connected");
    await vi.advanceTimersByTimeAsync(1_600);

    expect(writes).toHaveLength(0);
    expect(runtimeConfig.state.configFormDirty).toBe(true);

    await expect(runtimeConfig.save()).resolves.toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.connection).toBe("replacement");
    expect(writes[0]?.baseHash).toBe("hash-1");
    expect(JSON.parse(writes[0]?.raw ?? "{}")).toMatchObject({
      agents: {
        entries: {
          main: {
            model: "anthropic/claude-sonnet-4-6",
          },
        },
      },
    });
    runtimeConfig.dispose();
    vi.useRealTimers();
  });
});
