import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createNonExitingRuntime } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";

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

import {
  __testing,
  resolveOfficialPluginOnboardingInstallEntries,
  setupOfficialPluginInstalls,
} from "./setup.official-plugins.js";

describe("resolveOfficialPluginOnboardingInstallEntries", () => {
  it("lists optional generic official plugins without channel, provider, or search-owned entries", () => {
    const entries = resolveOfficialPluginOnboardingInstallEntries({ config: {} });
    const pluginIds = entries.map((entry) => entry.pluginId);

    expect(pluginIds).toContain("diagnostics-otel");
    expect(pluginIds).toContain("diagnostics-prometheus");
    expect(pluginIds).toContain("acpx");
    expect(pluginIds).not.toContain("brave");
    expect(pluginIds).not.toContain("codex");
    expect(pluginIds).not.toContain("discord");
  });

  it("hides already configured official plugins", () => {
    const entries = resolveOfficialPluginOnboardingInstallEntries({
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
    });
    const pluginIds = entries.map((entry) => entry.pluginId);

    expect(pluginIds).not.toContain("acpx");
    expect(pluginIds).not.toContain("diagnostics-otel");
    expect(pluginIds).toContain("diagnostics-prometheus");
  });
});

describe("formatInstallHint", () => {
  it("describes dual-source npm-default installs as npm first", () => {
    expect(
      __testing.formatInstallHint({
        clawhubSpec: "clawhub:@openclaw/diagnostics-otel",
        npmSpec: "@openclaw/diagnostics-otel",
        defaultChoice: "npm",
      }),
    ).toBe("npm, with ClawHub fallback");
  });

  it("keeps dual-source clawhub-default installs ClawHub first", () => {
    expect(
      __testing.formatInstallHint({
        clawhubSpec: "clawhub:@openclaw/diagnostics-otel",
        npmSpec: "@openclaw/diagnostics-otel",
        defaultChoice: "clawhub",
      }),
    ).toBe("ClawHub, with npm fallback");
  });
});

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
    const multiselect = vi.fn(async () => ["diagnostics-otel"]);
    const prompter = createWizardPrompter({
      multiselect: multiselect as WizardPrompter["multiselect"],
    });
    const runtime = createNonExitingRuntime();

    await setupOfficialPluginInstalls({
      config: {},
      prompter,
      runtime,
      workspaceDir: "/tmp/workspace",
    });

    expect(multiselect).toHaveBeenCalledExactlyOnceWith({
      message: "Install optional plugins",
      options: [
        {
          value: "__skip__",
          label: "Skip for now",
          hint: "Continue without installing optional plugins",
        },
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
          value: "diffs",
          label: "Diffs",
          hint: "OpenClaw diff viewer plugin",
        },
        {
          value: "google-meet",
          label: "Google Meet",
          hint: "OpenClaw Google Meet participant plugin",
        },
        {
          value: "lobster",
          label: "Lobster",
          hint: "Lobster workflow tool plugin (typed pipelines + resumable approvals)",
        },
        {
          value: "memory-lancedb",
          label: "Memory LanceDB",
          hint: "OpenClaw LanceDB-backed long-term memory plugin with auto-recall/capture",
        },
        {
          value: "voice-call",
          label: "Voice Call",
          hint: "OpenClaw voice-call plugin",
        },
      ],
    });
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
