/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { i18n } from "../../i18n/index.ts";
import {
  createIosNativeDeviceSettingsSnapshot,
  createNativeDeviceSettingsSnapshot,
} from "../../test-helpers/native-device-settings.ts";
import { createUpdateRunFixture } from "../../test-helpers/update-run.ts";
import { renderUpdates } from "./updates.ts";

type UpdatesViewProps = Parameters<typeof renderUpdates>[0];

let container: HTMLDivElement;

function createProps(overrides: Partial<UpdatesViewProps> = {}): UpdatesViewProps {
  return {
    configObject: { update: { channel: "stable", auto: { enabled: false } } },
    gatewayVersion: "2026.8.1",
    controlUiCommit: "0123456789abcdef0123456789abcdef01234567",
    controlUiCommitAt: "1970-01-01T00:00:00.000Z",
    controlUiBuiltAt: "1970-01-01T00:00:00.000Z",
    schedule: {
      channel: "stable",
      autoEnabled: false,
      install: { kind: "package" },
      target: { kind: "package", version: "2026.8.2" },
    },
    heldUpdateCampaignId: null,
    updateAvailable: {
      currentVersion: "2026.8.1",
      latestVersion: "2026.8.2",
      channel: "stable",
    },
    statusBanner: null,
    run: null,
    connected: true,
    configBusy: false,
    canAdmin: true,
    canUpdate: true,
    canCheckStatus: true,
    canHoldUpdate: true,
    canReport: true,
    updateBusy: false,
    reportableUpdateFailureId: null,
    updateFailureReportBusy: false,
    updateFailureReportNotice: null,
    nowMs: 1_000,
    onChannelChange: vi.fn(),
    onUpdateChecksChange: vi.fn(),
    onAutomaticUpdatesChange: vi.fn(),
    onUpdateNow: vi.fn(),
    onHoldUpdate: vi.fn(async () => true),
    onCheckStatus: vi.fn(async () => undefined),
    onReportFailure: vi.fn(async () => undefined),
    ...overrides,
  };
}

function row(title: string): HTMLElement {
  const match = [...container.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
  );
  if (!match) {
    throw new Error(`Missing settings row: ${title}`);
  }
  return match;
}

function automaticUpdatesControl(): {
  row: HTMLElement;
  toggle: HTMLElement & { checked: boolean };
} {
  const automaticRow = row("Automatic updates");
  const toggle = automaticRow.querySelector<HTMLElement & { checked: boolean }>("wa-switch");
  if (!toggle) {
    throw new Error("Missing automatic updates control");
  }
  return { row: automaticRow, toggle };
}

beforeEach(async () => {
  await i18n.setLocale("en");
  container = document.createElement("div");
});

describe("renderUpdates", () => {
  it.each(["ios", "waiting"])(
    "keeps Gateway updates without an advertised device updater: %s",
    (host) => {
      const nativeDeviceSettings = {
        snapshot: host === "ios" ? createIosNativeDeviceSettingsSnapshot() : null,
        subscribe: () => () => undefined,
        set: vi.fn(),
        requestPermission: vi.fn(),
        openSystemSettings: vi.fn(),
        openPanel: vi.fn(),
        checkForUpdates: vi.fn(),
        installChromeExtension: vi.fn(),
        refresh: vi.fn(),
        dispose: vi.fn(),
      } satisfies NativeDeviceSettingsCapability;
      const props = createProps({ nativeDeviceSettings });
      render(renderUpdates(props), container);
      expect(container.textContent).not.toContain("This Mac");
      expect(container.textContent).not.toContain("This iPhone");
      expect(container.textContent).not.toContain("This device");
      expect(container.textContent).not.toContain("App version");
      expect(container.textContent).not.toContain("Check for updates automatically");
      expect(row("Gateway version").textContent).toContain("2026.8.1");
      row("Update now").querySelector<HTMLButtonElement>("button")?.click();
      expect(props.onUpdateNow).toHaveBeenCalledOnce();
      expect(nativeDeviceSettings.checkForUpdates).not.toHaveBeenCalled();
    },
  );

  it("keeps Mac updater controls native and available independently of Gateway admin access", () => {
    const nativeDeviceSettings = {
      snapshot: createNativeDeviceSettingsSnapshot(),
      subscribe: () => () => undefined,
      set: vi.fn(),
      requestPermission: vi.fn(),
      openSystemSettings: vi.fn(),
      openPanel: vi.fn(),
      checkForUpdates: vi.fn(),
      installChromeExtension: vi.fn(),
      refresh: vi.fn(),
      dispose: vi.fn(),
    } satisfies NativeDeviceSettingsCapability;
    const props = createProps({ nativeDeviceSettings, canAdmin: false, configBusy: true });
    render(renderUpdates(props), container);
    expect(container.textContent).toContain("This Mac");
    expect(row("App version").textContent).toContain("2026.9.3 (build 42)");
    const automatic = row("Check for updates automatically").querySelector<
      HTMLElement & { checked: boolean }
    >("wa-switch")!;
    expect(automatic.hasAttribute("disabled")).toBe(false);
    automatic.checked = false;
    automatic.dispatchEvent(new Event("change"));
    expect(nativeDeviceSettings.set).toHaveBeenCalledWith("updates.automatic", false);
    row("Check for Updates…").querySelector("button")?.click();
    expect(nativeDeviceSettings.checkForUpdates).toHaveBeenCalledOnce();
    nativeDeviceSettings.snapshot!.updates.available = false;
    nativeDeviceSettings.snapshot!.updates.unavailableReason = "Updater is not bundled";
    render(renderUpdates(props), container);
    expect(row("App updates unavailable").textContent).toContain("Updater is not bundled");
    expect(container.textContent).not.toContain("Check for updates automatically");
    render(renderUpdates(createProps()), container);
    expect(container.textContent).not.toContain("This Mac");
  });

  it("renders build facts, policy controls, status, and the shared update action", () => {
    const onChannelChange = vi.fn();
    const onAutomaticUpdatesChange = vi.fn();
    const onUpdateNow = vi.fn();
    render(
      renderUpdates(createProps({ onChannelChange, onAutomaticUpdatesChange, onUpdateNow })),
      container,
    );

    expect(row("Gateway version").textContent).toContain("2026.8.1");
    expect(row("Control UI commit").textContent).toContain("0123456789ab");
    expect(row("Built").querySelector("time")?.getAttribute("datetime")).toBe(
      "1970-01-01T00:00:00.000Z",
    );
    expect(row("Last commit").querySelector("time")?.getAttribute("datetime")).toBe(
      "1970-01-01T00:00:00.000Z",
    );
    expect(row("Install type").textContent).toContain("Package");
    expect(
      [...container.querySelectorAll("wa-radio")].map((option) => option.textContent?.trim()),
    ).toEqual(["Stable", "Beta", "Dev"]);
    expect(row("Status").textContent).toContain("Update available v2026.8.2");

    const channel = row("Release channel").querySelector<HTMLElement & { value: string }>(
      "wa-radio-group",
    );
    if (!channel) {
      throw new Error("Missing release channel control");
    }
    channel.value = "beta";
    channel.dispatchEvent(new Event("change"));
    expect(onChannelChange).toHaveBeenCalledWith("beta", expect.any(HTMLElement));

    const automatic = row("Automatic updates").querySelector<HTMLElement & { checked: boolean }>(
      "wa-switch",
    );
    if (!automatic) {
      throw new Error("Missing automatic updates control");
    }
    automatic.checked = true;
    automatic.dispatchEvent(new Event("change"));
    expect(onAutomaticUpdatesChange).toHaveBeenCalledWith(true);

    row("Update now").querySelector<HTMLButtonElement>("button")?.click();
    expect(onUpdateNow).toHaveBeenCalledOnce();
  });

  it("shows extended stable only for the exact authored value and disables auto-apply", () => {
    render(
      renderUpdates(
        createProps({
          configObject: {
            update: { channel: "extended-stable", auto: { enabled: true } },
          },
          schedule: { channel: "extended-stable", autoEnabled: true },
          updateAvailable: null,
        }),
      ),
      container,
    );

    expect(
      [...container.querySelectorAll("wa-radio")].map((option) => option.textContent?.trim()),
    ).toEqual(["Stable", "Beta", "Dev", "Extended stable"]);
    const automaticRow = row("Automatic updates");
    expect(automaticRow.textContent).toContain("never installs them automatically");
    expect(automaticRow.querySelector("wa-switch")?.hasAttribute("disabled")).toBe(true);
  });

  it("lets an admin resume disabled checks while preserving the automatic-update preference", () => {
    const onUpdateChecksChange = vi.fn();
    render(
      renderUpdates(
        createProps({
          configObject: {
            update: { channel: "stable", checkOnStart: false, auto: { enabled: true } },
          },
          schedule: { channel: "stable", autoEnabled: false },
          onUpdateChecksChange,
        }),
      ),
      container,
    );

    const checks = row("Check for updates").querySelector<HTMLElement & { checked: boolean }>(
      "wa-switch",
    );
    if (!checks) {
      throw new Error("Missing update checks control");
    }
    expect(checks.checked).toBe(false);
    expect(checks.hasAttribute("disabled")).toBe(false);
    const automatic = automaticUpdatesControl().toggle;
    expect(automatic.checked).toBe(true);
    expect(automatic.hasAttribute("disabled")).toBe(true);
    expect(row("Automatic updates").textContent).toContain("Check for updates");
    checks.checked = true;
    checks.dispatchEvent(new Event("change"));
    expect(onUpdateChecksChange).toHaveBeenCalledWith(true);
  });

  it.each([
    {
      name: "disables dev package installs",
      channel: "dev",
      installKind: "package",
      disabled: true,
      description:
        "Automatic dev updates require a source (git) install. This install is a package install — use stable or beta for automatic updates.",
    },
    {
      name: "allows dev git installs",
      channel: "dev",
      installKind: "git",
      disabled: false,
      description: undefined,
    },
    {
      name: "allows dev installs with unknown metadata",
      channel: "dev",
      installKind: "unknown",
      disabled: false,
      description: undefined,
    },
    {
      name: "allows stable package installs",
      channel: "stable",
      installKind: "package",
      disabled: false,
      description: undefined,
    },
    {
      name: "allows beta package installs",
      channel: "beta",
      installKind: "package",
      disabled: false,
      description: undefined,
    },
  ] as const)("$name", ({ channel, installKind, disabled, description }) => {
    render(
      renderUpdates(
        createProps({
          configObject: { update: { channel, auto: { enabled: false } } },
          schedule: {
            channel,
            autoEnabled: false,
            install: { kind: installKind },
          },
        }),
      ),
      container,
    );

    const automatic = automaticUpdatesControl();
    expect(automatic.toggle.hasAttribute("disabled")).toBe(disabled);
    if (description) {
      expect(automatic.row.textContent).toContain(description);
    }
  });

  it("renders the authoritative waiting countdown as a quiet timer", () => {
    const onHoldUpdate = vi.fn(async () => true);
    render(
      renderUpdates(
        createProps({
          schedule: {
            channel: "dev",
            autoEnabled: true,
            install: { kind: "git" },
            target: {
              kind: "git",
              upstreamRef: "origin/main",
              upstreamSha: "a".repeat(40),
              commitsBehind: 3,
            },
            campaign: {
              id: "campaign-1",
              state: "waiting-for-idle",
              announcedAtMs: 1_000,
              forceAtMs: 762_000,
              updatedAtMs: 1_000,
            },
          },
          updateAvailable: null,
          onHoldUpdate,
        }),
      ),
      container,
    );

    const timer = row("Status").querySelector("[role='timer']");
    expect(timer?.getAttribute("aria-live")).toBe("off");
    expect(timer?.textContent).toContain("Waiting for active work · forced update in 12:41");
    const hold = row("Status").querySelector<HTMLButtonElement>("button");
    expect(hold?.textContent?.trim()).toBe("Hold 1 h");
    hold?.click();
    expect(onHoldUpdate).toHaveBeenCalledOnce();
  });

  it("shows held campaign timing and hides the one-shot hold action", () => {
    render(
      renderUpdates(
        createProps({
          schedule: {
            channel: "dev",
            autoEnabled: true,
            install: { kind: "git" },
            target: {
              kind: "git",
              upstreamRef: "origin/main",
              upstreamSha: "a".repeat(40),
              commitsBehind: 3,
            },
            campaign: {
              id: "campaign-1",
              state: "waiting-for-idle",
              announcedAtMs: 1_000,
              holdUntilMs: 61_000,
              forceAtMs: 961_000,
              updatedAtMs: 1_000,
            },
          },
          updateAvailable: null,
        }),
      ),
      container,
    );

    expect(row("Status").textContent).toContain("Update held · resumes in 1:00");
    expect(row("Status").querySelector("button")).toBeNull();

    render(
      renderUpdates(
        createProps({
          heldUpdateCampaignId: "campaign-1",
          schedule: {
            channel: "dev",
            autoEnabled: true,
            campaign: {
              id: "campaign-1",
              state: "waiting-for-idle",
              announcedAtMs: 1_000,
              holdUntilMs: 500,
              forceAtMs: 961_000,
              updatedAtMs: 1_000,
            },
          },
          updateAvailable: null,
        }),
      ),
      container,
    );
    expect(row("Status").querySelector("button")).toBeNull();
  });

  it("renders bounded dev commit details only when supplied", () => {
    render(
      renderUpdates(
        createProps({
          schedule: {
            channel: "dev",
            autoEnabled: false,
            install: { kind: "git", git: { status: "behind", commitsBehind: 2 } },
            target: {
              kind: "git",
              upstreamRef: "origin/main",
              upstreamSha: "b".repeat(40),
              commitsBehind: 2,
            },
          },
          updateAvailable: {
            currentVersion: "2026.8.1",
            latestVersion: "2026.8.1",
            channel: "dev",
            currentSha: "a".repeat(40),
            upstreamRef: "origin/main",
            upstreamSha: "b".repeat(40),
            commitsBehind: 2,
            commits: [
              { sha: "b123456", subject: "Add held update campaigns" },
              { sha: "a987654", subject: "Show dev commit details" },
            ],
          },
        }),
      ),
      container,
    );

    expect(row("Commits").querySelectorAll("[role='listitem']")).toHaveLength(2);
    expect(row("Commits").textContent).toContain("b123456");
    expect(row("Commits").textContent).toContain("Show dev commit details");
    expect(row("Status").textContent).toContain("Update available 2 commits behind");
    expect(row("Status").textContent).not.toContain("Up to date");
    expect(row("Status").querySelector(".settings-status__dot")).toBeNull();

    render(renderUpdates(createProps()), container);
    expect(container.querySelector(".updates-commit-list")).toBeNull();
  });

  it("shows truthful Git build, install, and commit ages", () => {
    const installedAtMs = Date.parse("2026-08-08T12:00:00Z");
    const commitAtMs = Date.parse("2026-08-08T10:00:00Z");
    render(
      renderUpdates(
        createProps({
          configObject: { update: { channel: "dev" } },
          nowMs: Date.parse("2026-08-08T14:00:00Z"),
          schedule: {
            channel: "dev",
            autoEnabled: false,
            install: {
              kind: "git",
              git: {
                status: "current",
                currentSha: "a".repeat(40),
                commitAtMs,
                installedAtMs,
              },
            },
          },
          updateAvailable: null,
        }),
      ),
      container,
    );

    expect(row("Installed").querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-08T12:00:00.000Z",
    );
    expect(row("Installed").textContent).toContain("2h ago");
    expect(row("Last commit").querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-08T10:00:00.000Z",
    );
    expect(row("Last commit").textContent).toContain("4h ago");

    render(
      renderUpdates(
        createProps({
          configObject: { update: { channel: "dev" } },
          schedule: {
            channel: "dev",
            autoEnabled: false,
            install: { kind: "git", git: { status: "current" } },
          },
          updateAvailable: null,
        }),
      ),
      container,
    );
    expect(row("Installed").textContent).toContain(
      "Unknown · recorded after the next successful update",
    );
  });

  it.each([
    {
      name: "current",
      git: { status: "current" } as const,
      label: "Up to date",
    },
    {
      name: "ahead",
      git: { status: "ahead", commitsAhead: 2 } as const,
      label: "2 commits ahead of tracked upstream",
    },
    {
      name: "diverged",
      git: { status: "diverged", commitsAhead: 1, commitsBehind: 3 } as const,
      label: "Diverged · 1 ahead, 3 behind",
    },
    {
      name: "fetch unavailable",
      git: { status: "unavailable", reason: "fetch-failed" } as const,
      label: "Could not fetch the tracked upstream",
    },
  ])("renders explicit $name git status without a dot", ({ git, label }) => {
    render(
      renderUpdates(
        createProps({
          configObject: { update: { channel: "dev" } },
          schedule: {
            channel: "dev",
            autoEnabled: false,
            install: { kind: "git", git },
          },
          updateAvailable: null,
        }),
      ),
      container,
    );

    expect(row("Status").textContent).toContain(label);
    expect(row("Status").querySelector(".settings-status__dot")).toBeNull();
  });

  it("surfaces the latest update failure ahead of passive availability", () => {
    render(
      renderUpdates(
        createProps({
          statusBanner: {
            tone: "danger",
            text: "Update error: build-failed. Fix the build error and retry.",
          },
        }),
      ),
      container,
    );

    expect(row("Status").textContent).toContain(
      "Update error: build-failed. Fix the build error and retry.",
    );
    expect(row("Status").querySelector(".settings-status--danger")).not.toBeNull();
  });

  it.each(["succeeded", "failed", "skipped"] as const)(
    "renders the durable %s report and only offers recovery for unsuccessful runs",
    async (status) => {
      const onUpdateNow = vi.fn();
      const onCheckStatus = vi.fn(async () => undefined);
      render(
        renderUpdates(
          createProps({
            run: createUpdateRunFixture({
              phase: "finished",
              status,
              finishedAtMs: 10,
              reason: status === "failed" ? "build-failed" : null,
              after: { version: "2026.9.2" },
              steps: [
                {
                  step: "build",
                  status: status === "failed" ? "failed" : "completed",
                  detail: "Build output",
                },
              ],
            }),
            onUpdateNow,
            onCheckStatus,
          }),
        ),
        container,
      );
      document.body.append(container);
      try {
        const view = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
          "openclaw-update-run-view",
        )!;
        await view.updateComplete;
        expect(view.querySelector(".update-run-view__report")?.textContent).toContain(
          status === "succeeded" ? "OpenClaw updated to 2026.9.2" : `OpenClaw update ${status}`,
        );
        if (status !== "succeeded") {
          const recovery = row("Recovery");
          recovery.querySelector<HTMLButtonElement>("button")?.click();
          recovery.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
          expect(onCheckStatus).toHaveBeenCalledOnce();
          expect(onUpdateNow).toHaveBeenCalledOnce();
          expect(row("CLI fallback").querySelector("code")?.textContent).toBe("openclaw triage");
        } else {
          expect(container.textContent).not.toContain("Retry update");
        }
      } finally {
        container.remove();
      }
    },
  );

  it("keeps retry and report as separate actions for one final failure", () => {
    const onReportFailure = vi.fn(async () => undefined);
    const run = createUpdateRunFixture({
      status: "failed",
      phase: "finished",
      reason: "build-failed",
    });
    render(
      renderUpdates(
        createProps({
          run,
          reportableUpdateFailureId: run.runId,
          onReportFailure,
        }),
      ),
      container,
    );

    const actions = [...row("Recovery").querySelectorAll<HTMLButtonElement>("button")];
    expect(actions.map((button) => button.textContent?.trim())).toEqual([
      "Check status",
      "Retry update",
      "Report update failure",
    ]);
    actions[2]?.click();
    expect(onReportFailure).toHaveBeenCalledExactlyOnceWith(run.runId);
  });

  it("renders a prefilled issue without exposing a server-local path", () => {
    const run = createUpdateRunFixture({
      status: "failed",
      phase: "finished",
      reason: "build-failed",
    });
    render(
      renderUpdates(
        createProps({
          run,
          reportableUpdateFailureId: run.runId,
          updateFailureReportNotice: {
            attemptId: run.runId,
            result: {
              status: "fallback",
              fallbackUrl: "https://github.com/openclaw/openclaw/issues/new?title=update",
              message: "gh is not authenticated",
            },
          },
        }),
      ),
      container,
    );

    const report = row("Failure report");
    expect(report.textContent).toContain("GitHub CLI submission was unavailable");
    expect(report.textContent).not.toContain("/private/report.md");
    expect(report.querySelector("a")?.getAttribute("href")).toContain("issues/new");
  });

  it("renders an ambiguous submission as pending without a replay link", () => {
    const run = createUpdateRunFixture({
      status: "failed",
      phase: "finished",
      reason: "build-failed",
    });
    render(
      renderUpdates(
        createProps({
          run,
          reportableUpdateFailureId: run.runId,
          updateFailureReportNotice: {
            attemptId: run.runId,
            result: {
              status: "pending",
              message: "GitHub issue submission may have completed.",
            },
          },
        }),
      ),
      container,
    );

    const report = row("Failure report");
    expect(report.textContent).toContain("may have completed");
    expect(report.querySelector("a")).toBeNull();
  });

  it("renders a definitely unstarted report as retryable rather than ambiguous", () => {
    const run = createUpdateRunFixture({
      status: "failed",
      phase: "finished",
      reason: "build-failed",
    });
    render(
      renderUpdates(
        createProps({
          run,
          reportableUpdateFailureId: run.runId,
          updateFailureReportNotice: {
            attemptId: run.runId,
            result: {
              status: "retryable",
              message: "No issue submission was started; retry this action later.",
            },
          },
        }),
      ),
      container,
    );

    const report = row("Failure report");
    expect(report.textContent).toContain("No GitHub issue submission was started");
    expect(report.textContent).toContain("retry this action later");
    expect(report.textContent).not.toContain("may have completed");
    expect(report.querySelector("a")).toBeNull();
  });

  it("keeps read-only facts visible while locking controls for non-admins", () => {
    render(
      renderUpdates(createProps({ canAdmin: false, canUpdate: false, configBusy: true })),
      container,
    );

    expect(container.querySelector("[role='note']")?.textContent).toContain(
      "Administrator access is required",
    );
    expect(row("Release channel").querySelector("wa-radio-group")?.hasAttribute("disabled")).toBe(
      true,
    );
    expect(row("Automatic updates").querySelector("wa-switch")?.hasAttribute("disabled")).toBe(
      true,
    );
    expect(row("Check for updates").querySelector("wa-switch")?.hasAttribute("disabled")).toBe(
      true,
    );
    expect(row("Update now").querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(row("Status").querySelector("button")).toBeNull();
    expect(row("Gateway version").textContent).toContain("2026.8.1");
  });
});
