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

const { runProviderPluginAuthMethodUnpersisted } = await import("./provider-auth-choice.js");

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
