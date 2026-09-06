/** Tests plugin-owned CLI backend resolution and runtime bindings. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type {
  CliBackendConfig,
  CliBackendPlugin,
  CliBackendRuntimeArtifactPolicy,
} from "../plugins/cli-backend.types.js";
import {
  isCliRuntimeModelBackendForProvider,
  listCliRuntimeModelBackendBindings,
  listCliRuntimeProviderIds,
  resolveCliBackendConfig,
  resolveCliBackendLiveTest,
  resolveCliRuntimeCanonicalProvider,
  resolveCliRuntimeModelBackendBinding,
} from "./cli-backends.js";
import { testing as cliBackendsTesting } from "./cli-backends.test-support.js";

type RuntimeBackendEntry = ReturnType<
  (typeof import("../plugins/cli-backends.runtime.js"))["resolveRuntimeCliBackends"]
>[number];
type SetupBackendEntry = NonNullable<
  ReturnType<(typeof import("../plugins/setup-registry.js"))["resolvePluginSetupCliBackend"]>
>;
type CliBackendOverrides = Partial<
  Omit<CliBackendPlugin, "ownsNativeCompaction" | "manualCompaction">
> &
  (
    | {
        ownsNativeCompaction: true;
        manualCompaction?: NonNullable<CliBackendPlugin["manualCompaction"]>;
      }
    | {
        ownsNativeCompaction?: false;
        manualCompaction?: never;
      }
  );

const runtimeArtifact: CliBackendRuntimeArtifactPolicy = {
  kind: "bundled-package-tree",
  packageName: "@fixture/acme-cli",
  entrypoint: "command",
};
function createBackend(overrides: CliBackendOverrides = {}): CliBackendPlugin {
  const base = {
    id: "acme-cli",
    modelProvider: "acme",
    config: {
      command: "acme",
      args: ["chat", "--json"],
      output: "json",
      input: "stdin",
      modelArg: "--model",
      sessionArgs: ["--session", "{sessionId}"],
      sessionMode: "existing",
    },
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    runtimeArtifact,
    liveTest: {
      defaultModelRef: "acme/acme-large",
      defaultImageProbe: true,
      defaultMcpProbe: false,
      docker: {
        npmPackage: "@fixture/acme-cli",
        binaryName: "acme",
      },
    },
  } satisfies CliBackendPlugin;
  return overrides.ownsNativeCompaction === true
    ? { ...base, ...overrides, ownsNativeCompaction: true }
    : { ...base, ...overrides, ownsNativeCompaction: false };
}

function createBooleanOwnershipBackend(ownsNativeCompaction: boolean): CliBackendPlugin {
  return {
    id: "boolean-ownership-cli",
    modelProvider: "acme",
    config: { command: "acme" },
    bundleMcp: false,
    ownsNativeCompaction,
  };
}

function runtimeEntry(
  overrides: CliBackendOverrides = {},
  pluginId = "acme-plugin",
): RuntimeBackendEntry {
  return { ...createBackend(overrides), pluginId } as RuntimeBackendEntry;
}

function setupEntry(
  overrides: CliBackendOverrides = {},
  pluginId = "acme-plugin",
): SetupBackendEntry {
  return {
    pluginId,
    source: "test",
    backend: createBackend(overrides),
  } as SetupBackendEntry;
}

function requireBackend(provider = "acme-cli", cfg?: OpenClawConfig) {
  const resolved = resolveCliBackendConfig(provider, cfg);
  if (!resolved) {
    throw new Error(`Expected CLI backend ${provider}`);
  }
  return resolved;
}

beforeEach(() => {
  const entries = [runtimeEntry()];
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => entries,
    resolvePluginSetupCliBackend: () => undefined,
    resolvePluginSetupRegistry: () => ({ cliBackends: [] }) as never,
  });
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
});

describe("resolveCliBackendConfig", () => {
  it("accepts boolean native-compaction ownership without a manual contract", () => {
    expect(createBooleanOwnershipBackend(true).ownsNativeCompaction).toBe(true);
  });

  it("returns the plugin-owned command adapter and registration metadata", () => {
    const resolved = requireBackend();

    expect(resolved).toMatchObject({
      id: "acme-cli",
      modelProvider: "acme",
      pluginId: "acme-plugin",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      runtimeArtifact,
      config: {
        command: "acme",
        args: ["chat", "--json"],
        output: "json",
        input: "stdin",
        modelArg: "--model",
        sessionArgs: ["--session", "{sessionId}"],
        sessionMode: "existing",
      },
    });
  });

  it("preserves the plugin-owned JSONL parser through runtime resolution", () => {
    const parseJsonlEvent = vi.fn();
    const parseJsonlLifecycleEvent = vi.fn();
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        runtimeEntry({ parseJsonlEvent, parseJsonlLifecycleEvent }),
      ],
      resolvePluginSetupCliBackend: () => undefined,
    });

    expect(requireBackend().parseJsonlEvent).toBe(parseJsonlEvent);
    expect(requireBackend().parseJsonlLifecycleEvent).toBe(parseJsonlLifecycleEvent);
  });

  it("normalizes the registered adapter with agent and runtime config context", () => {
    const normalizeConfig = vi.fn((config: CliBackendConfig): CliBackendConfig => ({
      ...config,
      args: [...(config.args ?? []), "--normalized"],
    }));
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [runtimeEntry({ normalizeConfig })],
      resolvePluginSetupCliBackend: () => undefined,
    });
    const cfg: OpenClawConfig = { tools: { exec: { mode: "ask" } } };

    const resolved = resolveCliBackendConfig("acme-cli", cfg, { agentId: "reviewer" });

    expect(resolved?.config.args).toEqual(["chat", "--json", "--normalized"]);
    expect(normalizeConfig).toHaveBeenCalledWith(expect.objectContaining({ command: "acme" }), {
      backendId: "acme-cli",
      agentId: "reviewer",
      config: cfg,
    });
  });

  it("does not let a mutating normalizer rewrite the registered adapter", () => {
    const backend = runtimeEntry({
      normalizeConfig(config, context) {
        config.command = `${config.command}-${context?.agentId ?? "default"}`;
        return config;
      },
    });
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [backend],
      resolvePluginSetupCliBackend: () => undefined,
    });

    expect(resolveCliBackendConfig("acme-cli", {}, { agentId: "reviewer" })?.config.command).toBe(
      "acme-reviewer",
    );
    expect(resolveCliBackendConfig("acme-cli", {}, { agentId: "builder" })?.config.command).toBe(
      "acme-builder",
    );
    expect(backend.config.command).toBe("acme");
  });

  it("falls back to setup registration before runtime activation", () => {
    const parseJsonlEvent = vi.fn();
    const resolveModelId = vi.fn(
      ({ modelId, contextWindow }: { modelId: string; contextWindow?: string }) =>
        contextWindow === "1m" ? `${modelId}[1m]` : modelId,
    );
    const entry = setupEntry({
      config: { command: "setup-acme", args: ["run"] },
      parseJsonlEvent,
      resolveModelId,
    });
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: ({ backend }) => (backend === "acme-cli" ? entry : undefined),
    });

    const resolved = requireBackend();

    expect(resolved.pluginId).toBeUndefined();
    expect(resolved.config).toEqual({ command: "setup-acme", args: ["run"] });
    expect(resolved.runtimeArtifact).toEqual(runtimeArtifact);
    expect(resolved.parseJsonlEvent).toBe(parseJsonlEvent);
    expect(resolved.resolveModelId?.({ modelId: "acme-large", contextWindow: "1m" })).toBe(
      "acme-large[1m]",
    );
  });

  it("returns null when no plugin owns the backend", () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: () => undefined,
    });

    expect(resolveCliBackendConfig("missing-cli")).toBeNull();
  });

  it("preserves backend-owned execution hooks", () => {
    const prepareExecution = vi.fn(async () => ({ env: { ACME_HOME: "/tmp/acme" } }));
    const manualCompaction = {
      buildPrompt: vi.fn(() => "/shrink"),
      input: "arg" as const,
      validateOutput: vi.fn(() => ({ ok: true as const })),
    };
    const resolveExecutionArgs = vi.fn(({ baseArgs }: { baseArgs: readonly string[] }) => [
      ...baseArgs,
      "--effort",
      "high",
    ]);
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        runtimeEntry({
          prepareExecution,
          resolveExecutionArgs: resolveExecutionArgs as never,
          ownsNativeCompaction: true,
          manualCompaction,
          nativeToolMode: "selectable",
          toolAvailabilityEnforcement: "execution-args",
          sideQuestionToolMode: "disabled",
        }),
      ],
      resolvePluginSetupCliBackend: () => undefined,
    });

    const resolved = requireBackend();

    expect(resolved.prepareExecution).toBe(prepareExecution);
    expect(resolved.resolveExecutionArgs).toBe(resolveExecutionArgs);
    expect(resolved.ownsNativeCompaction).toBe(true);
    expect(resolved.manualCompaction).toBe(manualCompaction);
    expect(resolved.nativeToolMode).toBe("selectable");
    expect(resolved.toolAvailabilityEnforcement).toBe("execution-args");
    expect(resolved.sideQuestionToolMode).toBe("disabled");
  });

  it("requires explicit enforcement for a selectable hook", () => {
    const resolveExecutionArgs = vi.fn(({ baseArgs }: { baseArgs: readonly string[] }) => baseArgs);
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [
        runtimeEntry({
          nativeToolMode: "selectable",
          resolveExecutionArgs: resolveExecutionArgs as never,
        }),
      ],
      resolvePluginSetupCliBackend: () => undefined,
    });

    expect(requireBackend().toolAvailabilityEnforcement).toBeUndefined();
  });
});

describe("CLI backend metadata and bindings", () => {
  it("returns plugin-owned live smoke metadata", () => {
    expect(resolveCliBackendLiveTest("acme-cli")).toEqual({
      defaultModelRef: "acme/acme-large",
      defaultImageProbe: true,
      defaultMcpProbe: false,
      dockerNpmPackage: "@fixture/acme-cli",
      dockerBinaryName: "acme",
    });
  });

  it("lists canonical provider to CLI runtime bindings", () => {
    expect(listCliRuntimeModelBackendBindings()).toEqual([
      { provider: "acme", runtime: "acme-cli", pluginId: "acme-plugin" },
    ]);
    expect(listCliRuntimeProviderIds()).toEqual(["acme-cli"]);
    expect(resolveCliRuntimeCanonicalProvider({ runtime: "ACME-CLI" })).toBe("acme");
    expect(resolveCliRuntimeModelBackendBinding({ provider: "acme", runtime: "acme-cli" })).toEqual(
      { provider: "acme", runtime: "acme-cli", pluginId: "acme-plugin" },
    );
    expect(isCliRuntimeModelBackendForProvider({ provider: "acme", runtime: "acme-cli" })).toBe(
      true,
    );
  });

  it("includes setup bindings only when requested", () => {
    cliBackendsTesting.setDepsForTest({
      resolveRuntimeCliBackends: () => [],
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "acme-cli" ? setupEntry() : undefined,
      resolvePluginSetupRegistry: () => ({ cliBackends: [setupEntry()] }) as never,
    });

    expect(listCliRuntimeModelBackendBindings()).toEqual([]);
    expect(listCliRuntimeModelBackendBindings({ includeSetupRegistry: true })).toEqual([
      { provider: "acme", runtime: "acme-cli", pluginId: "acme-plugin" },
    ]);
  });
});
