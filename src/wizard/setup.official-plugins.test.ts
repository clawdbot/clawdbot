// Official plugin setup tests cover plugin installation during onboarding.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createNonExitingRuntime } from "../runtime.js";
import type { WizardMultiSelectParams, WizardPrompter } from "./prompts.js";

const ensureOnboardingPluginInstalled = vi.hoisted(() =>
  vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({
    cfg,
    installed: true,
    status: "installed",
  })),
);
vi.mock("../commands/onboarding-plugin-install.js", () => ({
  ensureOnboardingPluginInstalled,
}));

import { setupOfficialPluginInstalls } from "./setup.official-plugins.js";

describe("setupOfficialPluginInstalls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureOnboardingPluginInstalled.mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
      status: "installed",
    }));
  });

  it("installs selected optional official plugins through the shared onboarding installer", async () => {
    const multiselect = vi.fn(async (_params: WizardMultiSelectParams) => ["diagnostics-otel"]);
    const prompter = createWizardPrompter({
      multiselect: multiselect as unknown as WizardPrompter["multiselect"],
    });
    const runtime = createNonExitingRuntime();

    await setupOfficialPluginInstalls({
      config: {},
      prompter,
      runtime,
      workspaceDir: "/tmp/workspace",
    });

    expect(multiselect).toHaveBeenCalledTimes(1);
    const prompt = multiselect.mock.calls[0]?.[0];
    if (!prompt) {
      throw new Error("expected optional plugin multiselect prompt");
    }
    expect(prompt.message).toBe("Install optional plugins");
    expect(prompt.options[0]).toEqual({
      value: "__skip__",
      label: "Skip for now",
      hint: "Continue without installing optional plugins",
    });
    const pluginIds = prompt.options.slice(1).map((option) => option.value);
    expect(pluginIds).toEqual(
      expect.arrayContaining(["acpx", "diagnostics-otel", "diagnostics-prometheus", "tokenjuice"]),
    );
    expect(pluginIds).not.toContain("brave");
    expect(pluginIds).not.toContain("codex");
    expect(pluginIds).not.toContain("discord");
    expect(prompt.options).toEqual(
      expect.arrayContaining([
        {
          value: "acpx",
          label: "ACPX Runtime",
          hint: "OpenClaw ACP runtime backend",
        },
        {
          value: "diagnostics-otel",
          label: "Diagnostics OpenTelemetry",
          hint: "OpenClaw diagnostics OpenTelemetry exporter",
        },
        {
          value: "diagnostics-prometheus",
          label: "Diagnostics Prometheus",
          hint: "OpenClaw diagnostics Prometheus exporter",
        },
        {
          value: "tokenjuice",
          label: "Tokenjuice",
          hint: "OpenClaw tokenjuice exec output compaction plugin",
        },
      ]),
    );
    expect(ensureOnboardingPluginInstalled).toHaveBeenCalledExactlyOnceWith({
      cfg: {},
      entry: {
        pluginId: "diagnostics-otel",
        label: "Diagnostics OpenTelemetry",
        description: "OpenClaw diagnostics OpenTelemetry exporter",
        install: {
          clawhubSpec: "clawhub:@openclaw/diagnostics-otel",
          npmSpec: "@openclaw/diagnostics-otel",
          defaultChoice: "npm",
          minHostVersion: ">=2026.4.25",
        },
        trustedSourceLinkedOfficialInstall: true,
      },
      prompter,
      runtime,
      workspaceDir: "/tmp/workspace",
      promptInstall: false,
    });
  });

  it("hides already configured official plugins from the production prompt", async () => {
    const multiselect = vi.fn(async (_params: WizardMultiSelectParams) => ["__skip__"]);
    const prompter = createWizardPrompter({
      multiselect: multiselect as unknown as WizardPrompter["multiselect"],
    });

    await setupOfficialPluginInstalls({
      config: {
        plugins: {
          entries: {
            acpx: { enabled: true },
          },
          installs: {
            "diagnostics-otel": {
              source: "npm",
              spec: "@openclaw/diagnostics-otel",
              installPath: "/tmp/diagnostics-otel",
            },
          },
        },
      },
      prompter,
      runtime: createNonExitingRuntime(),
    });

    const prompt = multiselect.mock.calls[0]?.[0];
    if (!prompt) {
      throw new Error("expected optional plugin multiselect prompt");
    }
    const pluginIds = prompt.options.map((option) => option.value);
    expect(pluginIds).not.toContain("acpx");
    expect(pluginIds).not.toContain("diagnostics-otel");
    expect(pluginIds).toContain("diagnostics-prometheus");
  });

  it("does not install when the user skips optional plugins", async () => {
    const prompter = createWizardPrompter({
      multiselect: vi.fn(async () => ["__skip__"]) as WizardPrompter["multiselect"],
    });

    await setupOfficialPluginInstalls({
      config: {},
      prompter,
      runtime: createNonExitingRuntime(),
    });

    expect(ensureOnboardingPluginInstalled).not.toHaveBeenCalled();
  });
});
