import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { GuidedOnboardingDeps } from "./onboard-guided.js";

vi.mock("./onboard-interactive-runner.js", () => ({
  hasInteractiveOnboardingTty: () => true,
  runInteractiveOnboarding: async (run: () => Promise<void>) => await run(),
}));
vi.mock("./auth-choice-prompt.js", () => ({ promptAuthChoiceGrouped: async () => "skip" }));
vi.mock("../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
}));
vi.mock("../plugins/provider-setup-availability.js", () => ({
  detectAvailableSetupProviderIds: async () => new Set(),
}));

let root: string | undefined;
afterEach(async () => {
  const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");
  const { closeOpenClawAgentDatabasesForTest } = await import("../state/openclaw-agent-db.js");
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

it.each(["fresh", "interrupted", "replaced"] as const)(
  "keeps skipped baseline setup owner-fenced and resumable: %s",
  async (scenario) => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-onboard-skip-"));
    const workspace = path.join(root, "workspace");
    const configPath = path.join(root, "openclaw.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    const { runGuidedOnboarding } = await import("./onboard-guided.js");
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const { applySystemAgentSetup } = await import("../system-agent/setup-apply.js");
    const { beginLocalOnboarding, readLocalOnboardingState } =
      await import("../state/local-onboarding-state.js");
    const prompter = createWizardPrompter({}, { selectValues: ["full", "full"] });
    const activate = vi.fn();
    const launchHatchTui = vi.fn();
    let interrupted = false;
    const deps: GuidedOnboardingDeps = {
      createPrompter: () => prompter,
      activate,
      launchHatchTui,
      detect: async () => ({
        candidates: [],
        unavailableCandidates: [],
        manualProviders: [],
        authOptions: [],
        recommendedInstalls: [],
        workspace,
        setupComplete: false,
      }),
      applySetup: async (params, hooks) =>
        await applySystemAgentSetup(
          {
            ...params,
            assertCommitPreconditions: (config) => {
              if (
                scenario !== "fresh" &&
                !interrupted &&
                config.agents?.entries?.starter &&
                config.gateway?.mode === undefined
              ) {
                interrupted = true;
                if (scenario === "replaced") {
                  const owner = readLocalOnboardingState(configPath)!;
                  beginLocalOnboarding({
                    ...owner,
                    replace: true,
                    expectedRunId: owner.runId,
                    runId: "replacement",
                  });
                } else {
                  throw new Error("Synthetic interruption after first-agent creation");
                }
              }
              params.assertCommitPreconditions?.(config);
            },
          },
          hooks,
        ),
    };
    const run = () =>
      runGuidedOnboarding(
        { acceptRisk: true, workspace, agentName: "starter", tui: true, skipHooks: true },
        { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never },
        deps,
      );
    if (scenario !== "fresh") {
      await expect(run()).rejects.toThrow(
        scenario === "interrupted" ? "Synthetic interruption" : "Another onboarding run",
      );
      const interruptedConfig = await readConfigFileSnapshot();
      expect(interruptedConfig.config.agents?.entries?.starter).toBeDefined();
      expect(interruptedConfig.config.gateway?.mode).toBeUndefined();
      expect(readLocalOnboardingState(configPath)?.status).toBe("pending");
      if (scenario === "replaced") {
        expect(readLocalOnboardingState(configPath)?.runId).toBe("replacement");
        return;
      }
    }
    await run();
    const snapshot = await readConfigFileSnapshot();
    expect(snapshot.valid).toBe(true);
    expect(snapshot.config.gateway?.mode).toBe("local");
    expect(snapshot.config.agents?.entries?.starter?.workspace).toBe(workspace);
    expect(Object.keys(snapshot.config.agents?.entries ?? {})).toEqual(["starter"]);
    expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).not.toBe("");
    expect(readLocalOnboardingState(configPath)?.status).toBe("completed");
    expect(activate).not.toHaveBeenCalled();
    expect(launchHatchTui).not.toHaveBeenCalled();
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("openclaw onboard"),
      "Next steps",
    );
  },
);
