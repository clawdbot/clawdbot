// Covers provider auth choice selection for plugin-owned providers.
import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createNonExitingRuntime } from "../runtime.js";
import type { ProviderPlugin } from "./types.js";

const ensureCodexRuntimePluginForModelSelection = vi.hoisted(() => vi.fn());
vi.mock("../commands/codex-runtime-plugin-install.js", () => ({
  CODEX_RUNTIME_PLUGIN_ID: "codex",
  ensureCodexRuntimePluginForModelSelection,
}));

const ensureCopilotRuntimePluginForModelSelection = vi.hoisted(() => vi.fn());
vi.mock("../commands/copilot-runtime-plugin-install.js", () => ({
  ensureCopilotRuntimePluginForModelSelection,
}));

const offerPostInstallMigrations = vi.hoisted(() => vi.fn());
vi.mock("../wizard/setup.post-install-migration.js", () => ({
  offerPostInstallMigrations,
}));

const { runProviderPluginAuthMethod, runProviderPluginAuthMethodUnpersisted } =
  await import("./provider-auth-choice.js");

describe("runProviderPluginAuthMethodUnpersisted", () => {
  it("delegates remote browser destinations to structured wizard clients", async () => {
    const openUrl = vi.fn(async () => undefined);
    const method: ProviderPlugin["auth"][number] = {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        await ctx.openUrl("https://provider.example/oauth?state=state-1");
        return { profiles: [] };
      },
    };

    await runProviderPluginAuthMethodUnpersisted({
      config: {},
      runtime: createNonExitingRuntime(),
      isRemote: true,
      prompter: { ...createWizardPrompter(), openUrl },
      method,
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    });

    expect(openUrl).toHaveBeenCalledWith("https://provider.example/oauth?state=state-1");
  });
});

describe("runProviderPluginAuthMethod agent ownership", () => {
  it("accepts a fully-scoped call on an explicit multi-agent roster", async () => {
    // The configure wizard supplies agentDir/workspaceDir but no agentId, so the
    // owner is never needed. Resolving it eagerly used to throw
    // AgentSelectionRequiredError here and abort provider setup.
    const method: ProviderPlugin["auth"][number] = {
      id: "api-key",
      label: "API key",
      kind: "api_key",
      run: async () => ({ profiles: [] }),
    };

    const applied = await runProviderPluginAuthMethod({
      config: {
        agents: {
          ownership: "explicit",
          entries: { main: { agentDir: "/tmp/main" }, ops: { agentDir: "/tmp/ops" } },
        },
      },
      runtime: createNonExitingRuntime(),
      prompter: createWizardPrompter(),
      method,
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    });

    expect(applied.config).toBeDefined();
  });
});
