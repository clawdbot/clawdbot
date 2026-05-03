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

    await setupOfficialPluginInstalls({
      config: {},
      prompter,
      runtime: createNonExitingRuntime(),
      workspaceDir: "/tmp/workspace",
    });

    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Install optional plugins",
      }),
    );
    expect(ensureOnboardingPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          pluginId: "diagnostics-otel",
          trustedSourceLinkedOfficialInstall: true,
          install: expect.objectContaining({
            clawhubSpec: "clawhub:@openclaw/diagnostics-otel",
            npmSpec: "@openclaw/diagnostics-otel",
            defaultChoice: "npm",
          }),
        }),
        promptInstall: false,
        workspaceDir: "/tmp/workspace",
      }),
    );
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
