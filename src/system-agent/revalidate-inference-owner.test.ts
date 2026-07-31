import { describe, expect, it, vi } from "vitest";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import { revalidateSetupInferenceOwner } from "./revalidate-inference-owner.js";
import type { SystemAgentVerifiedInferenceBinding } from "./verified-inference.js";

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
  it("reloads a staged plugin harness before validating its runtime artifact", async () => {
    const order: string[] = [];
    const binding = {} as SystemAgentVerifiedInferenceBinding;
    const ensureSelectedAgentHarnessPlugin = vi.fn(async () => {
      order.push("ensure");
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
          ensureSelectedAgentHarnessPlugin,
          createSystemAgentVerifiedInferenceBinding,
        },
      }),
    ).resolves.toBe(binding);

    expect(order).toEqual(["ensure", "validate"]);
    expect(ensureSelectedAgentHarnessPlugin).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      config: route.runConfig,
      agentId: "main",
      agentHarnessId: "codex",
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });

  it("does not reload the built-in OpenClaw harness", async () => {
    const ensureSelectedAgentHarnessPlugin = vi.fn(async () => {});
    const binding = {} as SystemAgentVerifiedInferenceBinding;

    await expect(
      revalidateSetupInferenceOwner({
        route: embeddedRoute("auto"),
        auth: { agentHarnessId: "openclaw", authFingerprint: "auth" },
        deps: {
          ensureSelectedAgentHarnessPlugin,
          createSystemAgentVerifiedInferenceBinding: vi.fn(async () => binding),
        },
      }),
    ).resolves.toBe(binding);

    expect(ensureSelectedAgentHarnessPlugin).not.toHaveBeenCalled();
  });
});
