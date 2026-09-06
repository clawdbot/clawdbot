// Verifies provider usage can be contributed by a runtime harness without a text provider.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import {
  makeIsolatedEnv,
  makeTempDir,
  resetPluginAutoEnableTestState,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderUsageSnapshotWithPlugin } from "./provider-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

vi.mock("./provider-hook-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider-hook-runtime.js")>();
  return { ...actual, resolveProviderRuntimePlugin: () => undefined };
});

function makeCodexManifestEnv(): NodeJS.ProcessEnv {
  const bundledPluginsDir = path.join(makeTempDir(), "extensions");
  const pluginDir = path.join(bundledPluginsDir, "codex");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/codex-test",
      openclaw: { extensions: ["./index.cjs"] },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "codex",
      activation: { onAgentHarnesses: ["codex"] },
      configSchema: { type: "object" },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `module.exports = {
      id: "codex",
      register(api) {
        api.registerAgentHarness({
          id: "codex",
          label: "Codex",
          supports: () => ({ supported: true }),
          runAttempt: async () => ({ ok: false, error: "unused" }),
          fetchUsageSnapshot: async () => ({
            provider: "openai",
            displayName: "OpenAI",
            windows: [{ label: "5h", usedPercent: 9 }],
          }),
        });
      },
    };\n`,
  );
  return makeIsolatedEnv({ OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir });
}

describe("provider runtime harness usage", () => {
  afterEach(() => {
    clearAgentHarnesses();
    resetPluginAutoEnableTestState();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("cold-loads the selected default-disabled harness for usage", async () => {
    const workspaceDir = makeTempDir();
    const env = makeCodexManifestEnv();

    await expect(
      resolveProviderUsageSnapshotWithPlugin({
        provider: "codex",
        config: {},
        env,
        workspaceDir,
        context: {
          config: {},
          env,
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
  });

  it("does not reuse an unrelated Gateway registry for cold harness usage", async () => {
    const workspaceDir = makeTempDir();
    const env = makeCodexManifestEnv();

    await expect(
      withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
        resolveProviderUsageSnapshotWithPlugin({
          provider: "codex",
          config: {},
          env,
          workspaceDir,
          context: {
            config: {},
            env,
            provider: "openai",
            token: "test-token-placeholder",
            timeoutMs: 5_000,
            fetchFn: fetch,
          },
        }),
      ),
    ).resolves.toMatchObject({ provider: "openai" });
  });

  it.each([
    {
      name: "globally disabled plugins",
      config: { plugins: { enabled: false } } satisfies OpenClawConfig,
      expectedReason: "plugins disabled",
    },
    {
      name: "a restrictive allowlist",
      config: { plugins: { allow: ["openai", "memory-core"] } } satisfies OpenClawConfig,
      expectedReason: "not in allowlist",
    },
  ])("preserves $name in cold usage diagnostics", async ({ config, expectedReason }) => {
    const workspaceDir = makeTempDir();
    const env = makeCodexManifestEnv();
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR ?? "");
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? "");
    vi.stubEnv(
      "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
      env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR ?? "",
    );

    const error = await resolveProviderUsageSnapshotWithPlugin({
      provider: "codex",
      config,
      env,
      workspaceDir,
      context: {
        config,
        env,
        provider: "openai",
        token: "test-token-placeholder",
        timeoutMs: 5_000,
        fetchFn: fetch,
      },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(expectedReason);
    expect((error as Error).message).toContain("reason=owner-plugin-not-activatable");
    expect((error as Error).message).not.toContain("absent from this prepared plugin generation");
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
