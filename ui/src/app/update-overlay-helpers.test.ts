// @vitest-environment node
// Control UI tests cover localized update and recovery status copy.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayHelloOk } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
import {
  formatUpdateCountdown,
  readUpdateAvailable,
  readUpdateSchedule,
  resolvePendingUpdateHandoffTimeoutBanner,
  resolvePostRestartUpdateBanner,
  resolveUpdateStatusBanner,
  resolveUpdateVerificationBanner,
} from "./update-overlay-helpers.ts";

const translations: Record<string, string> = {
  "updates.status": "Update {status}: {reason}. {guidance}",
  "updates.failureReasons.dirty": "Commit or stash changes, then retry.",
  "updates.failureReasons.default":
    "See the gateway logs for the exact failure and retry once the cause is fixed.",
  "updates.verificationFailed":
    "Update installed but running version did not change — restart may have been blocked.",
  "updates.verificationFailedWithVersions":
    "Update installed but running version did not change — restart may have been blocked. Expected v{expectedVersion}, running v{actualVersion}.",
  "updates.postRestart.restartUnhealthy":
    "The replacement process never became healthy and the previous process stayed up.",
  "updates.postRestart.default": "Check the gateway logs for the replacement failure.",
  "updates.handoffTimeout":
    "Update handoff started, but completion was not reported after reconnect. Run `openclaw update status` for the final result.",
};

function installTranslations() {
  return vi.spyOn(i18n, "t").mockImplementation((key, params) => {
    const template = translations[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => params?.[name] ?? `{${name}}`);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("update schedule hydration", () => {
  it("preserves additive git availability and the hello schedule DTO", () => {
    const updateSchedule = {
      channel: "dev",
      autoEnabled: true,
      install: { kind: "git" },
      target: {
        kind: "git",
        upstreamRef: "origin/main",
        upstreamSha: "b".repeat(40),
        commitsBehind: 3,
      },
      campaign: {
        id: "campaign-1",
        state: "waiting-for-idle",
        announcedAtMs: 1_000,
        forceAtMs: 901_000,
        updatedAtMs: 2_000,
      },
    } as const;
    const hello = {
      snapshot: {
        updateAvailable: {
          currentVersion: "2026.8.1",
          latestVersion: "2026.8.1",
          channel: "dev",
          currentSha: "a".repeat(40),
          upstreamRef: "origin/main",
          upstreamSha: "b".repeat(40),
          commitsBehind: 3,
        },
        updateSchedule,
      },
    } as GatewayHelloOk;

    expect(readUpdateAvailable(hello)).toMatchObject({
      currentSha: "a".repeat(40),
      upstreamRef: "origin/main",
      upstreamSha: "b".repeat(40),
      commitsBehind: 3,
    });
    expect(readUpdateSchedule(hello)).toEqual(updateSchedule);
  });

  it("formats countdown deadlines with a stable minutes-and-seconds shape", () => {
    expect(formatUpdateCountdown(55_000, 1_000)).toBe("0:54");
    expect(formatUpdateCountdown(762_000, 1_000)).toBe("12:41");
    expect(formatUpdateCountdown(500, 1_000)).toBe("0:00");
  });
});

describe("update status localization", () => {
  it("localizes known update failure guidance", () => {
    const translate = installTranslations();

    expect(resolveUpdateStatusBanner({ status: "skipped", reason: "dirty" })).toEqual({
      tone: "warn",
      text: "Update skipped: dirty. Commit or stash changes, then retry.",
    });
    expect(translate).toHaveBeenCalledWith("updates.failureReasons.dirty", undefined);
    expect(translate).toHaveBeenCalledWith("updates.status", {
      status: "skipped",
      reason: "dirty",
      guidance: "Commit or stash changes, then retry.",
    });
  });

  it("preserves unknown status details inside localized fallback guidance", () => {
    const translate = installTranslations();

    expect(resolveUpdateStatusBanner({ status: "error", reason: "disk-read-only" })).toEqual({
      tone: "danger",
      text: "Update error: disk-read-only. See the gateway logs for the exact failure and retry once the cause is fixed.",
    });
    expect(translate).toHaveBeenCalledWith("updates.failureReasons.default", undefined);
  });

  it("localizes restart verification with and without version diagnostics", () => {
    installTranslations();

    expect(
      resolveUpdateVerificationBanner({ expectedVersion: "2.0.0", actualVersion: null }),
    ).toEqual({
      tone: "danger",
      text: "Update installed but running version did not change — restart may have been blocked.",
    });
    expect(
      resolveUpdateVerificationBanner({
        expectedVersion: "2.0.0",
        actualVersion: "1.9.0",
      }),
    ).toEqual({
      tone: "danger",
      text: "Update installed but running version did not change — restart may have been blocked. Expected v2.0.0, running v1.9.0.",
    });
  });

  it("localizes post-restart and handoff timeout guidance", () => {
    installTranslations();

    expect(resolvePostRestartUpdateBanner("restart-unhealthy")).toEqual({
      tone: "danger",
      text: "Update error: restart-unhealthy. The replacement process never became healthy and the previous process stayed up.",
    });
    expect(resolvePostRestartUpdateBanner("supervisor-exited")).toEqual({
      tone: "danger",
      text: "Update error: supervisor-exited. Check the gateway logs for the replacement failure.",
    });
    expect(resolvePendingUpdateHandoffTimeoutBanner()).toEqual({
      tone: "danger",
      text: "Update handoff started, but completion was not reported after reconnect. Run `openclaw update status` for the final result.",
    });
  });
});
