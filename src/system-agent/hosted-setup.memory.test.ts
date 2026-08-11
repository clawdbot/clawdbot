import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  fakeOverviewLoader,
  sharedVerifiedInferenceConfig,
  mocks,
  useTempStateDir,
  configSnapshot,
  createAmbientVerifiedBinding,
  SystemAgentChatEngine,
  type MemoryImportStepParams,
  type OpenClawConfig,
} from "./chat-engine.test-support.js";

describe("SystemAgentChatEngine memory", () => {
  it("refuses memory import before provider discovery when the default workspace is missing", async () => {
    const root = useTempStateDir();
    const workspace = path.join(root, "missing-workspace");
    const baseConfig: OpenClawConfig = {
      ...sharedVerifiedInferenceConfig,
      agents: {
        ...sharedVerifiedInferenceConfig.agents,
        defaults: { workspace },
      },
    };
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      hash: "memory-base-hash",
      config: baseConfig,
      sourceConfig: baseConfig,
    });
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("memory import");

    expect(reply.text).toContain("default agent workspace does not exist");
    expect(reply.text).toContain("Finish onboarding first with `openclaw onboard`");
    expect(mocks.runSetupMemoryImportStep).not.toHaveBeenCalled();
    expect(mocks.writeWizardConfigFile).not.toHaveBeenCalled();
  });

  it("rechecks inference authority immediately before a hosted memory copy", async () => {
    const workspace = useTempStateDir();
    const baseConfig: OpenClawConfig = {
      ...sharedVerifiedInferenceConfig,
      agents: {
        ...sharedVerifiedInferenceConfig.agents,
        defaults: { workspace },
      },
    };
    const changedConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
    };
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    let currentConfig = structuredClone(baseConfig);
    const copyEffect = vi.fn();
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      hash: "memory-base-hash",
      config: baseConfig,
      sourceConfig: baseConfig,
    });
    mocks.runSetupMemoryImportStep.mockImplementation(async (params: MemoryImportStepParams) => {
      const confirmed = await params.prompter.confirm({
        message: "Import detected memory?",
        initialValue: true,
      });
      if (!confirmed) {
        return { status: "skipped", providers: [] };
      }
      // Route changes mid-wizard, after the turn gate: only the copy-boundary
      // recheck can catch it.
      currentConfig = changedConfig;
      await params.beforeApply?.();
      copyEffect();
      return {
        status: "completed",
        providers: [{ providerId: "codex", label: "Codex", migrated: 1, skipped: 0 }],
      };
    });
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      verifiedInference,
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: {
        loadOverview: fakeOverviewLoader(),
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
      },
    });

    const confirm = await engine.handle("import memory");
    expect(confirm.text).toContain("Import detected memory?");

    const stopped = await engine.handle("yes");

    expect(stopped.text).toContain("Memory import setup stopped");
    expect(copyEffect).not.toHaveBeenCalled();
  });

  it("stops a hosted memory copy when config drifts after planning", async () => {
    const workspace = useTempStateDir();
    const baseConfig: OpenClawConfig = {
      ...sharedVerifiedInferenceConfig,
      agents: {
        ...sharedVerifiedInferenceConfig.agents,
        defaults: { workspace },
      },
    };
    let currentHash = "memory-base-hash";
    const copyEffect = vi.fn();
    const appendAuditEntry = vi.fn(async () => "state/openclaw.sqlite");
    mocks.readSetupConfigFileSnapshot.mockImplementation(async () => ({
      exists: true,
      valid: true,
      hash: currentHash,
      config: baseConfig,
      sourceConfig: baseConfig,
    }));
    mocks.runSetupMemoryImportStep.mockImplementation(async (params: MemoryImportStepParams) => {
      const confirmed = await params.prompter.confirm({
        message: "Import detected memory?",
        initialValue: true,
      });
      if (!confirmed) {
        return { status: "skipped", providers: [] };
      }
      params.onProviderOutcome?.({
        providerId: "claude",
        label: "Claude",
        failure: "copy failed after partial progress",
        copiesIndeterminate: true,
      });
      currentHash = "changed-during-wizard";
      await params.beforeApply?.();
      copyEffect();
      return {
        status: "completed",
        providers: [{ providerId: "codex", label: "Codex", migrated: 1, skipped: 0 }],
      };
    });
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      appendAuditEntry,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const confirm = await engine.handle("import memory");
    expect(confirm.text).toContain("Import detected memory?");

    const stopped = await engine.handle("yes");

    expect(stopped.text).toContain("Memory import setup stopped");
    expect(stopped.text).toContain(
      "configuration changed during memory import; nothing further was copied",
    );
    expect(copyEffect).not.toHaveBeenCalled();
    expect(appendAuditEntry).toHaveBeenCalledWith({
      operation: "memory.import",
      summary: "Memory import failed partway via chat: Claude (copy count indeterminate)",
      details: {
        confirmedItems: 0,
        copiesIndeterminate: true,
        providers: [{ providerId: "claude", copiesIndeterminate: true }],
      },
    });
  });

  it("reports nothing to import without writing config or audit", async () => {
    const appendAuditEntry = vi.fn(async () => "state/openclaw.sqlite");
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      appendAuditEntry,
      runMemoryImportWizard: async () => ({ status: "nothing-to-import", providers: [] }),
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("import memories");

    expect(reply.text).toContain("Nothing to import");
    expect(reply.text).not.toContain("Done");
    expect(appendAuditEntry).not.toHaveBeenCalled();
    expect(mocks.writeWizardConfigFile).not.toHaveBeenCalled();
  });

  it("reports all-provider failure without a false success", async () => {
    const appendAuditEntry = vi.fn(async () => "state/openclaw.sqlite");
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      appendAuditEntry,
      runMemoryImportWizard: async () => ({
        status: "completed",
        providers: [
          {
            providerId: "codex",
            label: "Codex",
            migrated: 0,
            skipped: 0,
            failure: "copy failed",
          },
          {
            providerId: "claude",
            label: "Claude",
            migrated: 0,
            skipped: 0,
            failure: "copy failed",
          },
        ],
      }),
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("memory import");

    expect(reply.text).toContain("Memory import did not complete");
    expect(reply.text).toContain("Failed providers: Codex, Claude");
    expect(reply.text).not.toContain("Done");
    expect(appendAuditEntry).not.toHaveBeenCalled();
  });

  it("audits an apply failure with indeterminate partial-copy progress", async () => {
    const appendAuditEntry = vi.fn(async () => "state/openclaw.sqlite");
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      appendAuditEntry,
      runMemoryImportWizard: async () => ({
        status: "completed",
        providers: [
          {
            providerId: "codex",
            label: "Codex",
            failure: "copy failed after writing one file",
            copiesIndeterminate: true,
          },
        ],
      }),
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("memory import");

    expect(reply.text).toContain("Memory import failed partway");
    expect(reply.text).toContain("Some files may have been copied before the failure");
    expect(reply.text).not.toContain("No files were copied");
    expect(appendAuditEntry).toHaveBeenCalledWith({
      operation: "memory.import",
      summary: "Memory import failed partway via chat: Codex (copy count indeterminate)",
      details: {
        confirmedItems: 0,
        copiesIndeterminate: true,
        providers: [{ providerId: "codex", copiesIndeterminate: true }],
      },
    });
  });

  it("keeps a successful memory-import result when audit persistence fails", async () => {
    const appendAuditEntry = vi.fn(async () => {
      throw new Error("audit store is read-only");
    });
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      appendAuditEntry,
      runMemoryImportWizard: async () => ({
        status: "completed",
        providers: [{ providerId: "codex", label: "Codex", migrated: 1, skipped: 0 }],
      }),
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("import memory");

    expect(reply.text).toContain("Imported 1 item from Codex.");
    expect(reply.text).not.toContain("audit store is read-only");
  });
});
