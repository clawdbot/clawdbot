// Verifies provider usage can be contributed by a runtime harness without a text provider.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import { resolveProviderUsageSnapshotWithPlugin } from "./provider-runtime.js";

vi.mock("./provider-hook-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-hook-runtime.js")>();
  return { ...actual, resolveProviderRuntimePlugin: () => undefined };
});

describe("provider runtime harness usage", () => {
  afterEach(() => {
    clearAgentHarnesses();
  });

  it("routes a synthetic hook id to the matching harness", async () => {
    const fetchUsageSnapshot = vi.fn(async () => ({
      provider: "openai" as const,
      displayName: "OpenAI",
      windows: [{ label: "5h", usedPercent: 9 }],
    }));
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("not used");
      },
      fetchUsageSnapshot,
    });

    await expect(
      resolveProviderUsageSnapshotWithPlugin({
        provider: "codex",
        config: {},
        env: {},
        workspaceDir: process.cwd(),
        context: {
          config: {},
          env: {},
          provider: "openai",
          token: "test-token-placeholder",
          timeoutMs: 5_000,
          fetchFn: fetch,
        },
      }),
    ).resolves.toEqual({
      provider: "openai",
      displayName: "OpenAI",
      windows: [{ label: "5h", usedPercent: 9 }],
    });
    expect(fetchUsageSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", token: "test-token-placeholder" }),
    );
  });

  it("does not probe a harness for an ordinary provider usage miss", async () => {
    const fetchUsageSnapshot = vi.fn();
    registerAgentHarness({
      id: "openai",
      label: "OpenAI harness",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("not used");
      },
      fetchUsageSnapshot,
    });

    await expect(
      resolveProviderUsageSnapshotWithPlugin({
        provider: "openai",
        config: {},
        env: {},
        workspaceDir: process.cwd(),
        context: {
          config: {},
          env: {},
          provider: "openai",
          token: "test-token-placeholder",
          timeoutMs: 5_000,
          fetchFn: fetch,
        },
      }),
    ).resolves.toBeUndefined();
    expect(fetchUsageSnapshot).not.toHaveBeenCalled();
  });
});
