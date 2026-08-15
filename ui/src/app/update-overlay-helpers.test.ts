// @vitest-environment node
// Control UI tests cover localized update and recovery status copy.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../api/gateway.ts";
import { i18n } from "../i18n/index.ts";
import type {
  ApplicationStatusBanner,
  PendingUpdateReconciliation,
} from "./update-overlay-helpers.ts";
import {
  createUpdateVerificationController,
  formatUpdateCampaignLabel,
  resolveUpdateStatusBanner,
} from "./update-overlay-helpers.ts";
import { readUpdateAvailable, readUpdateSchedule } from "./update-schedule-dto.ts";

const translations: Record<string, string> = {
  "updates.status": "Update {status}: {reason}. {guidance}",
  "updates.failureReasons.dirty": "Commit or stash changes, then retry.",
  "updates.failureReasons.depsInstallFailed":
    "Dependency install failed. Fix the install error and retry.",
  "updates.failureReasons.default":
    "See the gateway logs for the exact failure and retry once the cause is fixed.",
  "updates.verificationFailed":
    "Update installed but running version did not change — restart may have been blocked.",
  "updates.verificationFailedWithVersions":
    "Update installed but running version did not change — restart may have been blocked. Expected v{expectedVersion}, running v{actualVersion}.",
  "updates.verificationFailedWithIdentity":
    "Update finished, but the running install does not match the expected revision. Expected {expected}, running {actual}.",
  "updates.outcomeUnknown": "The update outcome is unknown.",
  "common.unknown": "Unknown",
  "updates.failureReasons.restartUnhealthy":
    "The replacement process never became healthy. The previous process stayed up so you can recover.",
  "updates.failedAtStep": "The update failed at {step}: {cause}.",
  "updates.handoffTimeout":
    "Update handoff started, but completion was not reported after reconnect. Run `openclaw update status` for the final result.",
  "updates.campaign.countdown": "Updating in {time}",
  "updates.campaign.held": "Update held · resumes in {time}",
  "updates.campaign.waitingForIdle": "Waiting for active work · forced update in {time}",
};

function installTranslations() {
  return vi.spyOn(i18n, "t").mockImplementation((key, params) => {
    const template = translations[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => params?.[name] ?? `{${name}}`);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function verifyUpdate(params: {
  pending: PendingUpdateReconciliation;
  response: unknown;
  hello?: GatewayHelloOk | null;
  advanceToMs?: number;
  onVerifiedInstall?: (identity: { version: string | null; sha: string | null }) => void;
}): Promise<ApplicationStatusBanner | null | undefined> {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let banner: ApplicationStatusBanner | null | undefined;
  const client = {
    request: vi.fn(async () => {
      if (params.advanceToMs !== undefined) {
        vi.setSystemTime(params.advanceToMs);
      }
      return params.response;
    }),
  } as unknown as GatewayBrowserClient;
  const controller = createUpdateVerificationController({
    getPending: () => params.pending,
    clearPending: vi.fn(),
    isCurrent: () => true,
    getHello: () => params.hello ?? null,
    publish: vi.fn(),
    publishBanner: (value) => {
      banner = value;
    },
    ...(params.onVerifiedInstall ? { onVerifiedInstall: params.onVerifiedInstall } : {}),
  });

  await controller.verify(client, 1);
  return banner;
}

describe("update schedule hydration", () => {
  it("preserves an active hold deadline after reconnect", () => {
    const holdUntilMs = 3_601_000;
    const hello = {
      snapshot: {
        updateSchedule: {
          channel: "stable",
          autoEnabled: true,
          target: { kind: "package", version: "2.0.0" },
          campaign: {
            id: "campaign-held",
            state: "waiting-for-idle",
            announcedAtMs: 1_000,
            holdUntilMs,
            forceAtMs: 4_501_000,
            updatedAtMs: 2_000,
          },
        },
      },
    } as GatewayHelloOk;

    expect(readUpdateSchedule(hello)?.campaign?.holdUntilMs).toBe(holdUntilMs);
  });

  it("preserves additive git availability and the hello schedule DTO", () => {
    const updateSchedule = {
      channel: "dev",
      autoEnabled: true,
      install: {
        kind: "git",
        git: {
          status: "behind",
          currentSha: "a".repeat(40),
          commitAtMs: 1_000,
          installedAtMs: 2_000,
          commitsBehind: 3,
        },
      },
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
        holdUntilMs: 3_601_000,
        forceAtMs: 4_501_000,
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
          commits: [
            { sha: "b0b0b0b", subject: "Improve update scheduling" },
            { sha: "a0a0a0a", subject: "Tighten update checks" },
          ],
        },
        updateSchedule,
      },
    } as GatewayHelloOk;

    expect(readUpdateAvailable(hello)).toMatchObject({
      currentSha: "a".repeat(40),
      upstreamRef: "origin/main",
      upstreamSha: "b".repeat(40),
      commitsBehind: 3,
      commits: [
        { sha: "b0b0b0b", subject: "Improve update scheduling" },
        { sha: "a0a0a0a", subject: "Tighten update checks" },
      ],
    });
    expect(readUpdateSchedule(hello)).toEqual(updateSchedule);
  });

  it("formats countdown deadlines with a stable minutes-and-seconds shape", () => {
    installTranslations();
    const schedule = {
      channel: "stable",
      autoEnabled: true,
      campaign: {
        id: "campaign-1",
        state: "waiting-for-idle",
        announcedAtMs: 0,
        forceAtMs: 55_000,
        updatedAtMs: 0,
      },
    } as const;

    expect(formatUpdateCampaignLabel(schedule, 1_000)).toBe(
      "Waiting for active work · forced update in 0:54",
    );
    expect(
      formatUpdateCampaignLabel(
        {
          ...schedule,
          campaign: { ...schedule.campaign, state: "countdown", applyAtMs: 762_000 },
        },
        1_000,
      ),
    ).toBe("Updating in 12:41");
    expect(formatUpdateCampaignLabel(schedule, 56_000)).toBe(
      "Waiting for active work · forced update in 0:00",
    );
    expect(
      formatUpdateCampaignLabel(
        {
          ...schedule,
          campaign: { ...schedule.campaign, holdUntilMs: 762_000 },
        },
        1_000,
      ),
    ).toBe("Update held · resumes in 12:41");
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

  it("names the recorded cause instead of the reason slug when a step failed", async () => {
    installTranslations();

    await expect(
      verifyUpdate({
        pending: { kind: "handoff", expectedVersion: "2.0.0", expectedSha: null },
        response: {
          sentinel: {
            kind: "update",
            status: "error",
            stats: {
              reason: "deps-install-failed",
              steps: [
                { name: "fetch", log: { exitCode: 0, stderrTail: "done" } },
                {
                  name: "install",
                  log: {
                    exitCode: 1,
                    stderrTail: "Progress: resolved 1\nENOSPC: no space left on device, write",
                  },
                },
              ],
            },
          },
        },
      }),
    ).resolves.toEqual({
      tone: "danger",
      text: "The update failed at install: ENOSPC: no space left on device, write. Dependency install failed. Fix the install error and retry.",
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

  it("localizes restart verification with and without version diagnostics", async () => {
    installTranslations();

    await expect(
      verifyUpdate({
        pending: { kind: "restart", expectedVersion: "2.0.0", expectedSha: null },
        response: {
          sentinel: {
            kind: "update",
            status: "ok",
            stats: { after: { version: "1.9.0" } },
          },
        },
      }),
    ).resolves.toEqual({
      tone: "danger",
      text: "Update finished, but the running install does not match the expected revision. Expected v2.0.0, running v1.9.0.",
    });
    await expect(
      verifyUpdate({
        pending: { kind: "restart", expectedVersion: "2.0.0", expectedSha: null },
        response: null,
        advanceToMs: 10_000,
      }),
    ).resolves.toEqual({
      tone: "danger",
      text: "Update finished, but the running install does not match the expected revision. Expected v2.0.0, running Unknown.",
    });
  });

  it("verifies the restarted Git revision before reporting success", async () => {
    installTranslations();
    const onVerifiedInstall = vi.fn();

    await expect(
      verifyUpdate({
        pending: {
          kind: "restart",
          expectedVersion: "2.0.0",
          expectedSha: "abcdef0123456789",
        },
        response: {
          sentinel: {
            kind: "update",
            status: "ok",
            stats: { after: { version: "2.0.0", sha: "abcdef0" } },
          },
        },
        onVerifiedInstall,
      }),
    ).resolves.toBeNull();
    expect(onVerifiedInstall).toHaveBeenCalledWith({ version: "2.0.0", sha: "abcdef0" });

    await expect(
      verifyUpdate({
        pending: {
          kind: "restart",
          expectedVersion: "2.0.0",
          expectedSha: "abcdef0123456789",
        },
        response: {
          sentinel: {
            kind: "update",
            status: "ok",
            stats: { after: { version: "2.0.0", sha: "1234567" } },
          },
        },
      }),
    ).resolves.toEqual({
      tone: "danger",
      text: "Update finished, but the running install does not match the expected revision. Expected abcdef012345, running 1234567.",
    });
  });

  it("localizes post-restart and handoff timeout guidance", async () => {
    installTranslations();

    await expect(
      verifyUpdate({
        pending: { kind: "restart", expectedVersion: "2.0.0", expectedSha: null },
        response: {
          sentinel: {
            kind: "update",
            status: "error",
            stats: { reason: "restart-unhealthy" },
          },
        },
      }),
    ).resolves.toEqual({
      tone: "danger",
      text: "Update error: restart-unhealthy. The replacement process never became healthy. The previous process stayed up so you can recover.",
    });
    await expect(
      verifyUpdate({
        pending: { kind: "restart", expectedVersion: "2.0.0", expectedSha: null },
        response: {
          sentinel: {
            kind: "update",
            status: "error",
            stats: { reason: "supervisor-exited" },
          },
        },
      }),
    ).resolves.toEqual({
      tone: "danger",
      text: "Update error: supervisor-exited. See the gateway logs for the exact failure and retry once the cause is fixed.",
    });
    await expect(
      verifyUpdate({
        pending: { kind: "handoff", expectedVersion: null, expectedSha: null },
        response: {
          sentinel: {
            kind: "update",
            status: "skipped",
            stats: { reason: "managed-service-handoff-started" },
          },
        },
        advanceToMs: 35 * 60_000,
      }),
    ).resolves.toEqual({
      tone: "danger",
      text: "Update handoff started, but completion was not reported after reconnect. Run `openclaw update status` for the final result.",
    });
  });
});
