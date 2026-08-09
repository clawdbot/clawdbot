import { describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import { revalidateSetupInferenceOwner } from "./revalidate-inference-owner.js";
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
  it("validates a staged owner inside its registry handle", async () => {
    const order: string[] = [];
    const binding = {} as SystemAgentVerifiedInferenceBinding;
    const pluginRegistry = createEmptyPluginRegistry();
    mocks.loadAgentRuntimePluginRegistryHandle.mockImplementationOnce(() => {
      order.push("load");
      return pluginRegistry;
    });
    const createSystemAgentVerifiedInferenceBinding = vi.fn(async () => {
      order.push("validate");
      return binding;
    });
    const route = embeddedRoute("auto");

    await expect(
      revalidateSetupInferenceOwner({
        route,
        auth: {
          agentHarnessId: "codex",
          runtimeOwnerKind: "plugin-harness",
        },
        deps: {
          createSystemAgentVerifiedInferenceBinding,
        },
      }),
    ).resolves.toBe(binding);

    expect(order).toEqual(["load", "validate"]);
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledWith({
      config: route.runConfig,
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
