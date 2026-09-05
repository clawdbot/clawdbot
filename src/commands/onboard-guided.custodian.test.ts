import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { setupGuidedCustodianTestSuite } from "./onboard-guided.custodian.test-support.js";
import type { GuidedOnboardingDeps } from "./onboard-guided.js";

describe("runGuidedOnboarding custodian flow", () => {
  const {
    candidate,
    detection,
    existingModelCandidate,
    localOnboarding,
    makeRuntime,
    pendingLocalSetup,
    promptAuthChoiceGrouped,
    readConfigFileSnapshot,
    runGuidedOnboarding,
    setupApplyResult,
    setupDeps,
    withConfigMutationExclusive,
  } = setupGuidedCustodianTestSuite();

  it("records setup ownership at inference commit and completes before optional imports", async () => {
    const prompter = createWizardPrompter();
    const activate = vi.fn<NonNullable<GuidedOnboardingDeps["activate"]>>(async (params) => {
      expect(localOnboarding.begin).not.toHaveBeenCalled();
      params.onCommitStarted?.(localOnboarding.persisted.config ?? {});
      expect(localOnboarding.states.get("/tmp/openclaw.json")?.status).toBe("pending");
      return {
        ok: true,
        modelRef: "claude-cli/opus",
        latencyMs: 50,
        lines: ["Inference verified"],
      };
    });
    const runSetupMemoryImportStep = vi.fn<
      NonNullable<GuidedOnboardingDeps["runSetupMemoryImportStep"]>
    >(async () => {
      expect(localOnboarding.states.get("/tmp/openclaw.json")?.status).toBe("completed");
      return { status: "skipped", providers: [] };
    });
    const deps = setupDeps({ prompter, activate, runSetupMemoryImportStep });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(localOnboarding.begin).toHaveBeenCalledOnce();
    expect(localOnboarding.complete).toHaveBeenCalledOnce();
    expect(localOnboarding.complete.mock.invocationCallOrder[0]).toBeLessThan(
      runSetupMemoryImportStep.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps the pending owner's approved workspace after inference materializes a roster", async () => {
    const applySetup = vi.fn(async () => setupApplyResult());
    const deps = setupDeps({ prompter: createWizardPrompter(), applySetup });

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/approved-workspace" },
      makeRuntime(),
      deps,
    );

    expect(localOnboarding.states.get("/tmp/openclaw.json")).toMatchObject({
      status: "completed",
      workspace: "/tmp/approved-workspace",
    });
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: "/tmp/approved-workspace",
        allowWorkspaceChange: true,
        assertCommitPreconditions: expect.any(Function),
      }),
    );
  });

  it.each([
    ["enables default hooks", {}, true],
    ["preserves --skip-hooks", { skipHooks: true }, undefined],
  ] as const)("%s in the persisted setup config", async (_label, opts, expectedEnabled) => {
    const applySetup = vi.fn<NonNullable<GuidedOnboardingDeps["applySetup"]>>(async (params) => {
      const sourceConfig = localOnboarding.persisted.config ?? {};
      localOnboarding.persisted.config =
        params.finalizeConfig?.(sourceConfig, sourceConfig) ?? sourceConfig;
      return setupApplyResult();
    });
    const deps = setupDeps({ prompter: createWizardPrompter(), applySetup });

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/work", ...opts },
      makeRuntime(),
      deps,
    );

    expect(
      localOnboarding.persisted.config?.hooks?.internal?.entries?.["session-memory"]?.enabled,
    ).toBe(expectedEnabled);
  });

  it("resumes an interrupted gateway install using its approved workspace", async () => {
    const first = setupDeps({
      prompter: createWizardPrompter(),
      applySetup: vi.fn(async () => ({
        ...setupApplyResult(),
        gateway: { status: "failed" as const, error: "service install failed" },
      })),
    });

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/approved-workspace", tui: true },
      makeRuntime(),
      first,
    );

    const pending = localOnboarding.states.get("/tmp/openclaw.json");
    expect(pending).toMatchObject({ status: "pending", workspace: "/tmp/approved-workspace" });
    expect(first.runSystemAgentChat).toHaveBeenCalledOnce();

    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      issues: [],
      config: {
        agents: {
          defaults: {
            model: { primary: "acme/workspace-model" },
            workspace: "/tmp/approved-workspace",
          },
        },
        gateway: { mode: "local" as const },
        wizard: { securityAcknowledgedAt: pending?.securityAcknowledgedAt },
      },
    });
    const retry = setupDeps({
      prompter: createWizardPrompter(),
      detect: vi.fn(async () =>
        detection({
          candidates: [existingModelCandidate()],
          configuredModel: "acme/workspace-model",
          setupComplete: true,
        }),
      ),
    });

    await runGuidedOnboarding({ acceptRisk: true, tui: true }, makeRuntime(), retry);

    expect(retry.applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/tmp/approved-workspace", resume: true }),
    );
    expect(localOnboarding.states.get("/tmp/openclaw.json")).toMatchObject({
      status: "completed",
      runId: pending?.runId,
    });
    expect(retry.launchHatchTui).toHaveBeenCalledWith("/tmp/approved-workspace");
  });

  it("leaves onboarding pending when the workspace could not be prepared", async () => {
    const deps = setupDeps({
      prompter: createWizardPrompter(),
      applySetup: vi.fn(async () => ({ ...setupApplyResult(), workspaceReady: false })),
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(localOnboarding.states.get("/tmp/openclaw.json")?.status).toBe("pending");
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
  });

  it("completes setup when daemon installation is intentionally unavailable", async () => {
    const deps = setupDeps({
      prompter: createWizardPrompter(),
      applySetup: vi.fn(async () => ({
        ...setupApplyResult(),
        gateway: { status: "skipped" as const, reason: "systemd-unavailable" as const },
      })),
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(localOnboarding.states.get("/tmp/openclaw.json")?.status).toBe("completed");
  });

  it.each(["pending", "completed"] as const)(
    "replaces only the %s receipt observed before a config reset",
    async (status) => {
      const previous = pendingLocalSetup({
        runId: "pre-reset-run",
        workspace: "/tmp/old-workspace",
      });
      if (status === "completed") {
        localOnboarding.states.set(previous.configPath, {
          ...previous,
          status,
          completedAtMs: 2,
        });
      }
      const deps = setupDeps({ prompter: createWizardPrompter() });

      await runGuidedOnboarding(
        { acceptRisk: true, workspace: "/tmp/new-workspace" },
        makeRuntime(),
        deps,
      );

      expect(localOnboarding.begin).toHaveBeenCalledWith(
        expect.objectContaining({
          replace: true,
          expectedRunId: "pre-reset-run",
          workspace: "/tmp/new-workspace",
        }),
      );
      expect(localOnboarding.states.get("/tmp/openclaw.json")).toMatchObject({
        status: "completed",
        workspace: "/tmp/new-workspace",
      });
    },
  );

  it("replaces a stale receipt when explicit onboarding owns the replacement config", async () => {
    const stale = pendingLocalSetup({
      runId: "replaced-config-run",
      workspace: "/tmp/stale-workspace",
    });
    const securityAcknowledgedAt = "2026-08-03T00:00:00.000Z";
    localOnboarding.persisted.config = { wizard: { securityAcknowledgedAt } };
    const deps = setupDeps({ prompter: createWizardPrompter() });

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/replacement-workspace" },
      makeRuntime(),
      deps,
    );

    expect(localOnboarding.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        replace: true,
        expectedRunId: stale.runId,
        securityAcknowledgedAt,
        workspace: "/tmp/replacement-workspace",
      }),
    );
    expect(localOnboarding.states.get(stale.configPath)).toMatchObject({
      status: "completed",
      securityAcknowledgedAt,
    });
  });

  it.each([
    ["same", "2026-01-01T00:00:00.000Z"],
    ["different", "2026-08-03T00:00:00.000Z"],
  ])(
    "restarts an incomplete config with a completed receipt and the %s acknowledgement",
    async (_identity, securityAcknowledgedAt) => {
      const previous = pendingLocalSetup({
        runId: "completed-incomplete-run",
        workspace: "/tmp/old-workspace",
      });
      localOnboarding.states.set(previous.configPath, {
        ...previous,
        status: "completed",
        completedAtMs: 2,
      });
      localOnboarding.persisted.config = { wizard: { securityAcknowledgedAt } };
      const deps = setupDeps({ prompter: createWizardPrompter() });

      await runGuidedOnboarding(
        { acceptRisk: true, workspace: "/tmp/new-workspace" },
        makeRuntime(),
        deps,
      );

      expect(localOnboarding.begin).toHaveBeenCalledWith(
        expect.objectContaining({
          replace: true,
          expectedRunId: previous.runId,
          securityAcknowledgedAt,
          workspace: "/tmp/new-workspace",
        }),
      );
      expect(localOnboarding.states.get(previous.configPath)).toMatchObject({
        status: "completed",
        workspace: "/tmp/new-workspace",
        securityAcknowledgedAt,
      });
    },
  );

  it("never replaces a completed receipt for an authored, configured installation", async () => {
    const previous = pendingLocalSetup({
      runId: "completed-authored-run",
      workspace: "/tmp/authored-workspace",
    });
    const completed = { ...previous, status: "completed" as const, completedAtMs: 2 };
    localOnboarding.states.set(previous.configPath, completed);
    localOnboarding.persisted.config = {
      agents: {
        defaults: {
          model: { primary: "acme/workspace-model" },
          workspace: previous.workspace,
        },
      },
      wizard: { securityAcknowledgedAt: previous.securityAcknowledgedAt },
    };
    const deps = setupDeps({
      prompter: createWizardPrompter(),
      detect: vi.fn(async () =>
        detection({
          candidates: [existingModelCandidate()],
          configuredModel: "acme/workspace-model",
          setupComplete: true,
        }),
      ),
    });

    await runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps);

    expect(localOnboarding.begin).not.toHaveBeenCalled();
    expect(deps.applySetup).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(previous.configPath)).toEqual(completed);
  });

  it("binds a new receipt to the acknowledgement actually won by a concurrent writer", async () => {
    const committedAcknowledgement = "2026-08-03T00:00:00.000Z";
    const deps = setupDeps({
      prompter: createWizardPrompter(),
      persistRiskAcknowledgement: async () => {
        localOnboarding.persisted.config = {
          wizard: { securityAcknowledgedAt: committedAcknowledgement },
        };
        return committedAcknowledgement;
      },
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(localOnboarding.begin).toHaveBeenCalledWith(
      expect.objectContaining({ securityAcknowledgedAt: committedAcknowledgement }),
    );
    expect(localOnboarding.states.get("/tmp/openclaw.json")).toMatchObject({
      status: "completed",
      securityAcknowledgedAt: committedAcknowledgement,
    });
  });

  it("rejects a replaced config before recording inference setup ownership", async () => {
    const replacementConfig: OpenClawConfig = {
      wizard: { securityAcknowledgedAt: "2026-08-03T00:00:00.000Z" },
    };
    const activate = vi.fn<NonNullable<GuidedOnboardingDeps["activate"]>>(async (params) => {
      localOnboarding.persisted.config = replacementConfig;
      params.onCommitStarted?.(replacementConfig);
      return {
        ok: true,
        modelRef: "claude-cli/opus",
        latencyMs: 50,
        lines: ["Inference verified"],
      };
    });
    const deps = setupDeps({ prompter: createWizardPrompter(), activate });

    await expect(
      runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps),
    ).rejects.toThrow("configuration changed before inference could be saved");

    expect(localOnboarding.begin).not.toHaveBeenCalled();
    expect(deps.applySetup).not.toHaveBeenCalled();
  });

  it("never mistakes a concurrently created config owner for a stale reset receipt", async () => {
    const competing = pendingLocalSetup({
      runId: "concurrent-config-run",
      workspace: "/tmp/concurrent-workspace",
    });
    const firstSnapshot = {
      exists: false,
      valid: true,
      path: competing.configPath,
      issues: [],
      config: {},
    };
    readConfigFileSnapshot.mockResolvedValueOnce(firstSnapshot);
    localOnboarding.persisted.config = {
      wizard: { securityAcknowledgedAt: competing.securityAcknowledgedAt },
    };
    const deps = setupDeps({
      prompter: createWizardPrompter(),
      persistRiskAcknowledgement: async () => competing.securityAcknowledgedAt,
    });

    await expect(
      runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps),
    ).rejects.toThrow("already owns this installation");

    expect(localOnboarding.begin).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(competing.configPath)).toEqual(competing);
  });

  it("rejects an explicit workspace different from the pending approved workspace", async () => {
    const pending = pendingLocalSetup({
      runId: "approved-workspace-run",
      workspace: "/tmp/approved-workspace",
    });
    localOnboarding.persisted.config = {
      wizard: { securityAcknowledgedAt: pending.securityAcknowledgedAt },
    };
    const deps = setupDeps({ prompter: createWizardPrompter() });

    await expect(
      runGuidedOnboarding(
        { acceptRisk: true, workspace: "/tmp/different-workspace" },
        makeRuntime(),
        deps,
      ),
    ).rejects.toThrow("owns a different workspace");

    expect(localOnboarding.begin).not.toHaveBeenCalled();
    expect(deps.applySetup).not.toHaveBeenCalled();
  });

  it("rejects a resolved fleet workspace that differs from the pending approved workspace", async () => {
    const pending = pendingLocalSetup({
      runId: "approved-fleet-workspace-run",
      workspace: "/tmp/approved-workspace",
    });
    localOnboarding.persisted.config = {
      agents: {
        defaults: { workspace: "/tmp/existing-workspace" },
        entries: { main: { default: true, workspace: "/tmp/existing-workspace" } },
      },
      wizard: { securityAcknowledgedAt: pending.securityAcknowledgedAt },
    };
    const deps = setupDeps({ prompter: createWizardPrompter() });

    await expect(runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps)).rejects.toThrow(
      "owns a different workspace",
    );

    expect(deps.applySetup).not.toHaveBeenCalled();
    expect(localOnboarding.complete).not.toHaveBeenCalled();
  });

  it("rejects replacement config identity at the setup config-write boundary", async () => {
    const setupEffects = vi.fn();
    const applySetup = vi.fn<NonNullable<GuidedOnboardingDeps["applySetup"]>>(async (params) => {
      const replacementConfig: OpenClawConfig = {
        agents: { defaults: { workspace: params.workspace } },
        wizard: { securityAcknowledgedAt: "2026-08-03T00:00:00.000Z" },
      };
      params.assertCommitPreconditions?.(replacementConfig);
      setupEffects();
      return setupApplyResult();
    });
    const deps = setupDeps({ prompter: createWizardPrompter(), applySetup });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(setupEffects).not.toHaveBeenCalled();
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
  });

  it("keeps onboarding pending when its configuration is replaced during setup", async () => {
    const deps = setupDeps({
      prompter: createWizardPrompter(),
      applySetup: vi.fn(async () => {
        localOnboarding.persisted.config = {
          wizard: { securityAcknowledgedAt: "2026-08-03T00:00:00.000Z" },
        };
        return setupApplyResult();
      }),
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(localOnboarding.states.get("/tmp/openclaw.json")?.status).toBe("pending");
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
  });

  it("does not complete setup after its effective workspace changes", async () => {
    const deps = setupDeps({
      prompter: createWizardPrompter(),
      applySetup: vi.fn(async () => {
        const owner = localOnboarding.states.get("/tmp/openclaw.json");
        localOnboarding.persisted.config = {
          agents: { defaults: { workspace: "/tmp/different-workspace" } },
          wizard: { securityAcknowledgedAt: owner?.securityAcknowledgedAt },
        };
        return setupApplyResult();
      }),
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "installation identity",
      replace: (config: OpenClawConfig): OpenClawConfig => ({
        ...config,
        wizard: { ...config.wizard, securityAcknowledgedAt: "2026-08-03T00:00:00.000Z" },
      }),
    },
    {
      label: "effective workspace",
      replace: (config: OpenClawConfig): OpenClawConfig => ({
        ...config,
        agents: {
          ...config.agents,
          defaults: { ...config.agents?.defaults, workspace: "/tmp/changed-before-lock" },
        },
      }),
    },
  ])(
    "keeps onboarding pending when $label changes before the completion lock",
    async ({ replace }) => {
      withConfigMutationExclusive.mockImplementationOnce(async (effect) => {
        localOnboarding.persisted.config = replace(localOnboarding.persisted.config ?? {});
        return await effect(localOnboarding.persisted.config);
      });
      const deps = setupDeps({ prompter: createWizardPrompter() });

      await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

      expect(withConfigMutationExclusive).toHaveBeenCalledOnce();
      expect(localOnboarding.states.get("/tmp/openclaw.json")?.status).toBe("pending");
      expect(localOnboarding.complete).not.toHaveBeenCalled();
      expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
    },
  );

  it("rejects a concurrent fresh owner before the inference config can commit", async () => {
    const competing = pendingLocalSetup({
      runId: "competing-run",
      workspace: "/tmp/competing-workspace",
    });
    localOnboarding.states.delete(competing.configPath);
    const deps = setupDeps({
      prompter: createWizardPrompter(),
      persistRiskAcknowledgement: async (config) => {
        localOnboarding.persisted.config = config;
        localOnboarding.states.set("/tmp/openclaw.json", competing);
      },
    });

    await expect(
      runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps),
    ).rejects.toThrow("already owns this installation");

    expect(localOnboarding.states.get("/tmp/openclaw.json")).toEqual(competing);
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(deps.applySetup).not.toHaveBeenCalled();
  });

  it("keeps machine setup complete when optional memory import is cancelled", async () => {
    const runtime = makeRuntime();
    const deps = setupDeps({
      prompter: createWizardPrompter(),
      runSetupMemoryImportStep: async () => {
        throw new WizardCancelledError();
      },
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(localOnboarding.states.get("/tmp/openclaw.json")?.status).toBe("completed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(deps.launchHatchTui).not.toHaveBeenCalled();
  });

  it("routes guarded mode straight to manual config without any scanning", async () => {
    promptAuthChoiceGrouped.mockResolvedValueOnce("skip");
    const prompter = createWizardPrompter(undefined, {
      selectValues: ["custom", "guarded", "manual"],
    });
    const deps = {
      ...setupDeps({ prompter }),
      listManualOptions: vi.fn(async () => ({
        manualProviders: [{ id: "openai-api-key", label: "OpenAI" }],
        authOptions: [],
        workspace: "/tmp/openclaw-workspace",
        setupComplete: false,
      })),
    };

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.listManualOptions).toHaveBeenCalledOnce();
    expect(deps.persistAccessMode).toHaveBeenCalledWith("guarded");
    expect(promptAuthChoiceGrouped).toHaveBeenCalledOnce();
    expect(deps.runAppRecommendations).not.toHaveBeenCalled();
  });

  it("does not recommend apps after guarded manual setup succeeds", async () => {
    promptAuthChoiceGrouped.mockResolvedValueOnce("openai-api-key");
    const prompter = createWizardPrompter(
      { text: vi.fn(async () => "manual-key") },
      { selectValues: ["custom", "guarded", "manual"] },
    );
    const deps = {
      ...setupDeps({ prompter }),
      listManualOptions: vi.fn(async () => ({
        manualProviders: [{ id: "openai-api-key", label: "OpenAI" }],
        authOptions: [],
        workspace: "/tmp/openclaw-workspace",
        setupComplete: false,
      })),
    };

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(deps.applySetup).toHaveBeenCalledOnce();
    expect(deps.runAppRecommendations).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
  });

  it("does not recommend local apps during remote chat handoff", async () => {
    const prompter = createWizardPrompter();
    const deps = setupDeps({ prompter, handoffMode: "chat" });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(deps.runAppRecommendations).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
    expect(deps.launchHatchTui).not.toHaveBeenCalled();
  });

  it("scans in guarded mode only after the look-around consent", async () => {
    const prompter = createWizardPrompter(undefined, {
      selectValues: ["custom", "guarded", "look"],
    });
    const deps = setupDeps({ prompter });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(deps.detect).toHaveBeenCalledOnce();
    expect(deps.listManualOptions).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
  });

  it("announces the lean surface after local-model activation", async () => {
    const announcement =
      "This model is small, so I set up the lean surface — switching to a bigger model later lifts it.";
    const prompter = createWizardPrompter();
    const deps = setupDeps({
      prompter,
      activate: vi.fn(async () => ({
        ok: true as const,
        modelRef: "lmstudio/qwen-local",
        latencyMs: 1250,
        lines: ["Inference verified: lmstudio/qwen-local", announcement],
      })),
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining(announcement),
      "Inference ready",
    );
  });

  it("skips persisting an unchanged access mode", async () => {
    localOnboarding.persisted.config = {
      wizard: { accessMode: "full", securityAcknowledgedAt: "2026-01-01T00:00:00.000Z" },
    };
    const prompter = createWizardPrompter(undefined, { selectValues: ["custom", "full"] });
    const deps = setupDeps({ prompter });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(deps.persistAccessMode).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
  });

  it("keeps the working route when other options are explored and skipped", async () => {
    promptAuthChoiceGrouped.mockResolvedValueOnce("skip");
    const prompter = createWizardPrompter(undefined, { selectValues: ["custom", "full", "other"] });
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [candidate("claude-cli", "Claude Code"), candidate("codex-cli", "Codex")],
        }),
      ),
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(promptAuthChoiceGrouped).toHaveBeenCalledOnce();
    expect(promptAuthChoiceGrouped).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalGroups: [
          expect.objectContaining({
            label: "Detected on this machine",
            hint: "Claude Code, Codex",
            methodMessage: "Use which detected AI?",
          }),
        ],
      }),
    );
    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(notes).toContain("Keeping the working AI you already have.");
    expect(notes).not.toContain("Add AI later");
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
  });

  it("names the configured model in the recommended route confirmation", async () => {
    const prompter = createWizardPrompter(undefined, { selectValues: ["custom", "full", "use"] });
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () => detection({ candidates: [existingModelCandidate()] })),
      activate: vi.fn(async () => ({
        ok: true as const,
        modelRef: "acme/workspace-model",
        latencyMs: 125,
        lines: ["Default model: acme/workspace-model"],
      })),
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Use Current model (acme/workspace-model)?",
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "use",
            label: "Continue with Current model (acme/workspace-model) — recommended",
          }),
        ]),
      }),
    );
  });

  it("quips about detected coding agents", async () => {
    const prompter = createWizardPrompter();
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [candidate("claude-cli", "Claude Code"), candidate("codex-cli", "Codex")],
        }),
      ),
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("good taste"),
      expect.anything(),
    );
  });

  it("renders detected candidates without leaking interpolation placeholders", async () => {
    const prompter = createWizardPrompter();
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [candidate("claude-cli", "Claude Code"), candidate("codex-cli", "Codex")],
        }),
      ),
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(prompter.note).toHaveBeenCalledWith(
      "Claude Code — logged in\nCodex — logged in",
      "AI found",
    );
  });

  it("never re-applies setup or bounces the gateway on a configured install", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      issues: [],
      config: {
        gateway: { mode: "local" },
        wizard: { securityAcknowledgedAt: "2026-01-01T00:00:00.000Z" },
      },
    });
    const prompter = createWizardPrompter();
    const deps = setupDeps({ prompter });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(prompter.select).not.toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "quick" }),
    );
    expect(deps.applySetup).not.toHaveBeenCalled();
    // Configured reruns hatch the persisted default workspace, not the probe context.
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/openclaw-workspace");
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("already set up"),
      expect.anything(),
    );
  });

  it("treats a model-only authored config as configured (no auto-apply)", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      issues: [],
      config: {
        agents: { defaults: { workspace: "/tmp/authored" } },
        wizard: { securityAcknowledgedAt: "2026-01-01T00:00:00.000Z" },
      },
    });
    const prompter = createWizardPrompter();
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [existingModelCandidate()],
          configuredModel: "acme/workspace-model",
          setupComplete: true,
        }),
      ),
    });

    await runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps);

    expect(deps.applySetup).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/authored");
  });

  it("falls back to the OpenClaw chat when applying setup fails", async () => {
    const prompter = createWizardPrompter();
    const applySetup = vi.fn(async () => {
      throw new Error("config write raced");
    }) as unknown as GuidedOnboardingDeps["applySetup"];
    const deps = setupDeps({ prompter, applySetup });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(deps.launchHatchTui).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledWith("/tmp/work", runtime, true, "main");
    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(notes).toContain("config write raced");
  });
});
