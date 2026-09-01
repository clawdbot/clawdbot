import { describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { refreshPluginRegistryAfterConfigMutation } from "../plugins/registry-refresh.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import {
  loadSetupInferencePluginGeneration,
  revalidateSetupInferenceOwner,
} from "./revalidate-inference-owner.js";
import type { SystemAgentVerifiedInferenceBinding } from "./verified-inference.js";

const mocks = vi.hoisted(() => ({ loadAgentRuntimePluginRegistryHandle: vi.fn() }));
vi.mock("../agents/runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: mocks.loadAgentRuntimePluginRegistryHandle,
}));

function embeddedRoute(agentHarnessRuntimeOverride: string): SystemAgentConfiguredRoute {
  return {
    runner: "embedded",
    provider: "openai",
    model: "gpt-5.6-sol",
    modelLabel: "openai/gpt-5.6-sol",
    agentId: "main",
    agentDir: "/tmp/openclaw-agent",
    agentHarnessRuntimeOverride,
    runConfig: {
      agents: {
        defaults: {
          workspace: "/tmp/openclaw-workspace",
        },
      },
    },
  };
}

describe("revalidateSetupInferenceOwner", () => {
  it("loads newly installed package facts after the install lease cached their absence", async () => {
    await withOpenClawTestState(
      { label: "setup-plugin-generation", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const config = {
          plugins: {
            allow: ["fixture-runtime"],
            load: { paths: [state.statePath("plugin")] },
            entries: { "fixture-runtime": { enabled: true } },
          },
        };
        await withPluginCache(createPluginCache(), async () => {
          const input = { config, workspaceDir: state.workspaceDir, allowCurrent: false };
          const before = resolvePluginMetadataSnapshot(input);
          expect(before.byPluginId.has("fixture-runtime")).toBe(false);
          await state.writeJson("plugin/package.json", {
            name: "@fixture/runtime",
            version: "1.0.0",
            openclaw: { extensions: ["./index.js"] },
          });
          await state.writeJson("plugin/openclaw.plugin.json", {
            id: "fixture-runtime",
            agentHarnesses: ["fixture-runtime"],
            configSchema: { type: "object" },
          });
          await state.writeText("plugin/index.js", 'throw new Error("metadata must not execute");');
          await refreshPluginRegistryAfterConfigMutation({
            config,
            workspaceDir: state.workspaceDir,
            reason: "source-changed",
          });
          mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValueOnce(
            createEmptyPluginRegistry(),
          );
          const generation = loadSetupInferencePluginGeneration({
            config,
            workspaceDir: state.workspaceDir,
            selection: { provider: "fixture", modelId: "model", runtime: "fixture-runtime" },
          });
          expect(generation.metadataSnapshot.byPluginId.has("fixture-runtime")).toBe(true);
          expect(resolvePluginMetadataSnapshot(input)).toBe(before);
        });
      },
    );
  });

  it("validates a staged owner inside its registry handle", async () => {
    const order: string[] = [];
    const binding = {} as SystemAgentVerifiedInferenceBinding;
    const pluginRegistry = createEmptyPluginRegistry();
    const route = embeddedRoute("auto");
    const metadataSnapshot = createPluginMetadataSnapshot({
      config: route.runConfig,
      manifestRegistry: makeRegistry([]),
      workspaceDir: "/tmp/openclaw-workspace",
    });
    const previousMetadata = getCurrentPluginMetadataSnapshot();
    const resolveMetadataSnapshot = vi.fn(() => {
      order.push("metadata");
      return metadataSnapshot;
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementationOnce(() => {
      order.push("load");
      expect(getCurrentPluginMetadataSnapshot()).toBe(metadataSnapshot);
      return pluginRegistry;
    });
    const createSystemAgentVerifiedInferenceBinding = vi.fn(async () => {
      order.push("validate");
      expect(getCurrentPluginMetadataSnapshot()).toBe(metadataSnapshot);
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(pluginRegistry);
      return binding;
    });

    await expect(
      revalidateSetupInferenceOwner({
        route,
        auth: {
          agentHarnessId: "codex",
          runtimeOwnerKind: "plugin-harness",
        },
        deps: {
          createSystemAgentVerifiedInferenceBinding,
          resolvePluginMetadataSnapshot: resolveMetadataSnapshot,
        },
      }),
    ).resolves.toBe(binding);

    expect(order).toEqual(["metadata", "load", "validate"]);
    expect(getCurrentPluginMetadataSnapshot()).toBe(previousMetadata);
    expect(resolveMetadataSnapshot).toHaveBeenCalledWith({
      config: route.runConfig,
      env: process.env,
      workspaceDir: "/tmp/openclaw-workspace",
      allowCurrent: false,
    });
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledWith({
      config: route.runConfig,
      metadataSnapshot,
      workspaceDir: "/tmp/openclaw-workspace",
      selections: [
        { provider: "openai", modelId: "gpt-5.6-sol", runtime: "codex", agentId: "main" },
      ],
    });
  });

  it("does not reload the built-in OpenClaw harness", async () => {
    const binding = {} as SystemAgentVerifiedInferenceBinding;
    mocks.loadAgentRuntimePluginRegistryHandle.mockClear();

    await expect(
      revalidateSetupInferenceOwner({
        route: embeddedRoute("auto"),
        auth: { agentHarnessId: "openclaw", authFingerprint: "auth" },
        deps: {
          createSystemAgentVerifiedInferenceBinding: vi.fn(async () => binding),
        },
      }),
    ).resolves.toBe(binding);

    expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
  });
});
