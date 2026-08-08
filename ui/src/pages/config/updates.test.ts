/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderUpdates } from "./updates.ts";

type UpdatesViewProps = Parameters<typeof renderUpdates>[0];

let container: HTMLDivElement;

function createProps(overrides: Partial<UpdatesViewProps> = {}): UpdatesViewProps {
  return {
    configObject: { update: { channel: "stable", auto: { enabled: false } } },
    gatewayVersion: "2026.8.1",
    controlUiCommit: "0123456789abcdef0123456789abcdef01234567",
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
    configBusy: false,
    canAdmin: true,
    canUpdate: true,
    canHoldUpdate: true,
    updateBusy: false,
    nowMs: 1_000,
    onChannelChange: vi.fn(),
    onAutomaticUpdatesChange: vi.fn(),
    onUpdateNow: vi.fn(),
    onHoldUpdate: vi.fn(async () => true),
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

beforeEach(async () => {
  await i18n.setLocale("en");
  container = document.createElement("div");
});

describe("renderUpdates", () => {
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
            install: { kind: "git" },
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

    render(renderUpdates(createProps()), container);
    expect(container.querySelector(".updates-commit-list")).toBeNull();
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
    expect(row("Update now").querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(row("Status").querySelector("button")).toBeNull();
    expect(row("Gateway version").textContent).toContain("2026.8.1");
  });
});
