import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { setupGuidedCustodianTestSuite } from "./onboard-guided.custodian.test-support.js";

describe("runGuidedOnboarding quick start", () => {
  const {
    candidate,
    detection,
    localOnboarding,
    makeRuntime,
    promptAuthChoiceGrouped,
    restoreTerminalState,
    runGuidedOnboardingImpl,
    setupApplyResult,
    setupDeps,
  } = setupGuidedCustodianTestSuite();

  it.each([
    { label: "fresh install", acceptRisk: false, acknowledgedAt: undefined, failFirst: false },
    {
      label: "explicit risk acceptance",
      acceptRisk: true,
      acknowledgedAt: undefined,
      failFirst: false,
    },
    {
      label: "a later working candidate",
      acceptRisk: true,
      acknowledgedAt: undefined,
      failFirst: true,
    },
    {
      label: "acknowledged incomplete config",
      acceptRisk: false,
      acknowledgedAt: "2026-08-01T00:00:00.000Z",
      failFirst: false,
    },
  ])(
    "quick start uses one prompt for $label and launches after stdin is restored",
    async ({ acceptRisk, acknowledgedAt, failFirst }) => {
      if (acknowledgedAt) {
        localOnboarding.persisted.config = { wizard: { securityAcknowledgedAt: acknowledgedAt } };
      }
      const prompter = createWizardPrompter(undefined, { selectValues: ["quick"] });
      const deps = setupDeps({
        prompter,
        detect: vi.fn(async () =>
          detection({
            candidates: [candidate("claude-cli", "Claude Code"), candidate("codex-cli", "Codex")],
          }),
        ),
        applySetup: vi.fn(async () => ({
          ...setupApplyResult(),
          gateway: { status: "skipped" as const, reason: "explicit" as const },
        })),
      });
      if (failFirst) {
        vi.mocked(deps.activate).mockResolvedValueOnce({
          ok: false,
          status: "auth",
          error: "expired login",
        });
      }
      const runtime = makeRuntime();

      await runGuidedOnboardingImpl({ acceptRisk }, runtime, deps);

      expect(prompter.select).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          initialValue: "quick",
          options: [
            expect.objectContaining({ value: "quick" }),
            expect.objectContaining({ value: "custom" }),
          ],
        }),
      );
      expect(prompter.confirm).not.toHaveBeenCalled();
      expect(prompter.text).not.toHaveBeenCalled();
      expect(localOnboarding.persisted.config?.telemetry).toBeUndefined();
      expect(localOnboarding.persisted.config?.wizard?.securityAcknowledgedAt).toEqual(
        acknowledgedAt ?? expect.any(String),
      );
      expect(deps.persistAccessMode).toHaveBeenCalledWith("full");
      expect(deps.applySetup).toHaveBeenCalledWith(
        expect.objectContaining({ installDaemon: false, firstAgent: { name: "main" } }),
      );
      expect(deps.runSetupMemoryImportStep).not.toHaveBeenCalled();
      expect(deps.runAppRecommendations).not.toHaveBeenCalled();
      expect(deps.runBrowserHandoff).not.toHaveBeenCalled();
      expect(deps.launchHatchTui).not.toHaveBeenCalled();
      expect(deps.runForegroundGateway).toHaveBeenCalledExactlyOnceWith({ runtime });
      expect(prompter.note).toHaveBeenCalledWith(
        expect.stringContaining(`Using ${failFirst ? "Codex" : "Claude Code"}.`),
        "AI access",
      );
      if (failFirst) {
        expect(prompter.note).toHaveBeenCalledWith(
          "1 detected option(s) did not respond; continuing with the verified route.",
          "AI access",
        );
        expect(JSON.stringify(vi.mocked(prompter.note).mock.calls)).not.toContain("expired login");
      }
      expect(restoreTerminalState.mock.invocationCallOrder[0]).toBeLessThan(
        deps.runForegroundGateway.mock.invocationCallOrder[0]!,
      );
      const securityNotes = vi
        .mocked(prompter.note)
        .mock.calls.filter(([message]) =>
          message.includes("https://docs.openclaw.ai/gateway/security"),
        );
      expect(securityNotes).toEqual(
        acknowledgedAt
          ? []
          : [
              [
                "OpenClaw runs an AI agent with real access to this machine. Security guide: https://docs.openclaw.ai/gateway/security",
                "Security disclaimer",
              ],
            ],
      );
      expect(prompter.note).not.toHaveBeenCalledWith(
        expect.stringContaining("Recommended safer setup"),
        expect.anything(),
      );
    },
  );

  it("preserves guarded discovery consent in an incomplete config", async () => {
    localOnboarding.persisted.config = {
      wizard: { securityAcknowledgedAt: "2026-08-01T00:00:00.000Z", accessMode: "guarded" },
    };
    // Declined discovery still reaches the manual picker (Custom Provider is
    // always offered); skipping there keeps this test about consent only.
    promptAuthChoiceGrouped.mockResolvedValueOnce("skip");
    const prompter = createWizardPrompter();
    vi.mocked(prompter.select).mockImplementation(async ({ options, initialValue }) => {
      // Accept saved defaults, but decline discovery if its consent prompt appears.
      const choice =
        options.find(({ value }) => value === "manual") ??
        options.find(({ value }) => value === initialValue);
      return choice!.value;
    });
    const deps = setupDeps({ prompter });

    await runGuidedOnboardingImpl({ agentName: "main" }, makeRuntime(), deps);

    expect(prompter.select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "How would you like to start?" }),
    );
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How should I set things up?",
        initialValue: "guarded",
      }),
    );
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "May I look around to find your AI access?" }),
    );
    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.listManualOptions).toHaveBeenCalledOnce();
    expect(deps.persistAccessMode).not.toHaveBeenCalledWith("full");
    expect(localOnboarding.persisted.config?.wizard?.accessMode).toBe("guarded");
  });

  it("custom setup keeps telemetry, first-agent, access, and route prompts in order", async () => {
    const prompter = createWizardPrompter(
      { text: vi.fn(async () => "helper"), confirm: vi.fn(async () => true) },
      { selectValues: ["custom", "full", "use"] },
    );
    const deps = setupDeps({ prompter });

    await runGuidedOnboardingImpl({}, makeRuntime(), deps);

    expect(vi.mocked(prompter.select).mock.calls.map(([params]) => params.message)).toEqual([
      "How would you like to start?",
      "Help make OpenClaw better?",
      "How should I set things up?",
      "Use Claude Code?",
    ]);
    const selects = vi.mocked(prompter.select).mock.invocationCallOrder;
    const firstAgentPrompt = vi.mocked(prompter.text).mock.invocationCallOrder[0]!;
    expect(selects[1]).toBeLessThan(firstAgentPrompt);
    expect(firstAgentPrompt).toBeLessThan(selects[2]!);
    expect(prompter.confirm).toHaveBeenCalledOnce();
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Recommended safer setup"),
      "Security disclaimer",
    );
    expect(localOnboarding.persisted.config?.telemetry).toEqual({
      enabled: false,
      consentedAt: expect.any(String),
    });
    expect(deps.applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ firstAgent: { name: "helper" } }),
    );
    expect(deps.applySetup).not.toHaveBeenCalledWith(
      expect.objectContaining({ installDaemon: false }),
    );
    expect(deps.runSetupMemoryImportStep).toHaveBeenCalledOnce();
    expect(deps.runAppRecommendations).toHaveBeenCalledOnce();
    expect(deps.runForegroundGateway).not.toHaveBeenCalled();
  });

  it("runs in the foreground when systemd is unavailable", async () => {
    const prompter = createWizardPrompter(undefined, { selectValues: ["quick"] });
    const deps = setupDeps({
      prompter,
      applySetup: vi.fn(async () => ({
        ...setupApplyResult(),
        gateway: { status: "skipped" as const, reason: "systemd-unavailable" as const },
      })),
    });
    const runtime = makeRuntime();

    await expect(runGuidedOnboardingImpl({}, runtime, deps)).resolves.toBeUndefined();

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).not.toHaveBeenCalled();
    expect(deps.runForegroundGateway).toHaveBeenCalledExactlyOnceWith({ runtime });
    expect(prompter.outro).toHaveBeenCalledOnce();
  });

  it("preserves external Gateway ownership and uses the existing browser handoff", async () => {
    const prompter = createWizardPrompter(undefined, { selectValues: ["quick"] });
    const runBrowserHandoff = vi.fn(async () => ({ handedOff: true as const }));
    const deps = setupDeps({
      prompter,
      runBrowserHandoff,
      applySetup: vi.fn(async () => ({
        ...setupApplyResult(),
        gateway: { status: "skipped" as const, reason: "external" as const },
      })),
    });

    await runGuidedOnboardingImpl({}, makeRuntime(), deps);

    expect(deps.runForegroundGateway).not.toHaveBeenCalled();
    expect(runBrowserHandoff).toHaveBeenCalledOnce();
    expect(prompter.outro).toHaveBeenCalledWith("Your browser is ready — I'll be in Settings.");
  });

  it("cancelling the lane choice does not acknowledge security or scan the machine", async () => {
    const prompter = createWizardPrompter({
      select: vi.fn(async () => {
        throw new WizardCancelledError();
      }),
    });
    const deps = setupDeps({ prompter });
    const runtime = makeRuntime();

    await runGuidedOnboardingImpl({}, runtime, deps);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(deps.persistRiskAcknowledgement).not.toHaveBeenCalled();
    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.runForegroundGateway).not.toHaveBeenCalled();
  });

  it.each(["empty detection", "failed candidates"])(
    "quick start returns to manual setup after %s",
    async (failure) => {
      promptAuthChoiceGrouped.mockResolvedValueOnce("openai-api-key");
      const prompter = createWizardPrompter(
        { text: vi.fn(async () => "synthetic-key") },
        { selectValues: ["quick"] },
      );
      const deps = setupDeps({
        prompter,
        detect: vi.fn(async () =>
          detection({
            candidates:
              failure === "empty detection" ? [] : [candidate("claude-cli", "Claude Code")],
            manualProviders: [{ id: "openai-api-key", label: "OpenAI" }],
          }),
        ),
      });
      if (failure === "failed candidates") {
        vi.mocked(deps.activate).mockResolvedValueOnce({
          ok: false,
          status: "auth",
          error: "expired login",
        });
      }

      await runGuidedOnboardingImpl({}, makeRuntime(), deps);

      expect(promptAuthChoiceGrouped).toHaveBeenCalledOnce();
      expect(deps.applySetup).toHaveBeenCalledOnce();
      expect(deps.applySetup).not.toHaveBeenCalledWith(
        expect.objectContaining({ installDaemon: false }),
      );
      expect(deps.runSetupMemoryImportStep).toHaveBeenCalledOnce();
      expect(deps.runAppRecommendations).toHaveBeenCalledOnce();
      expect(deps.runForegroundGateway).not.toHaveBeenCalled();
      expect(deps.runBrowserHandoff).toHaveBeenCalledOnce();
      expect(prompter.note).toHaveBeenCalledWith(
        expect.stringContaining("Quick start found no usable AI access"),
        "AI access",
      );
    },
  );
});
