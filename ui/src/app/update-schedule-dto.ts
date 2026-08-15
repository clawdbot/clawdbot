// Normalizes the Gateway's update-availability and update-schedule payloads into
// the shapes the Control UI renders. These readers are the trust boundary for
// wire data, so they stay separate from the lifecycle controllers that consume them.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayHelloOk } from "../api/gateway.ts";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";

export function readUpdateAvailable(hello: GatewayHelloOk | null): UpdateAvailable | null {
  const snapshot = hello?.snapshot;
  if (!isRecord(snapshot)) {
    return null;
  }
  const update = (snapshot as { updateAvailable?: unknown }).updateAvailable;
  return readUpdateAvailableValue(update);
}

export function readUpdateAvailableValue(update: unknown): UpdateAvailable | null {
  if (!isRecord(update)) {
    return null;
  }
  const rawCommits = update.commits;
  const commits =
    Array.isArray(rawCommits) &&
    rawCommits.length <= 5 &&
    rawCommits.every(
      (commit): commit is { sha: string; subject: string } =>
        isRecord(commit) &&
        typeof commit.sha === "string" &&
        commit.sha.length > 0 &&
        typeof commit.subject === "string" &&
        commit.subject.length <= 120,
    )
      ? rawCommits.map((commit) => ({ sha: commit.sha, subject: commit.subject }))
      : undefined;
  return typeof update.currentVersion === "string" &&
    typeof update.latestVersion === "string" &&
    typeof update.channel === "string"
    ? {
        currentVersion: update.currentVersion,
        latestVersion: update.latestVersion,
        channel: update.channel,
        ...(typeof update.currentSha === "string" ? { currentSha: update.currentSha } : {}),
        ...(typeof update.upstreamRef === "string" ? { upstreamRef: update.upstreamRef } : {}),
        ...(typeof update.upstreamSha === "string" ? { upstreamSha: update.upstreamSha } : {}),
        ...(Number.isInteger(update.commitsBehind) && Number(update.commitsBehind) >= 0
          ? { commitsBehind: Number(update.commitsBehind) }
          : {}),
        ...(commits ? { commits } : {}),
      }
    : null;
}

function readScheduleTarget(value: unknown): UpdateScheduleState["target"] | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === "package" && typeof value.version === "string") {
    return { kind: "package", version: value.version };
  }
  if (
    value.kind === "git" &&
    typeof value.upstreamRef === "string" &&
    typeof value.upstreamSha === "string" &&
    Number.isInteger(value.commitsBehind) &&
    Number(value.commitsBehind) >= 0
  ) {
    return {
      kind: "git",
      upstreamRef: value.upstreamRef,
      upstreamSha: value.upstreamSha,
      commitsBehind: Number(value.commitsBehind),
    };
  }
  return null;
}

function readGitInstallMetadata(value: Record<string, unknown>): {
  currentSha?: string;
  commitAtMs?: number;
  installedAtMs?: number;
} | null {
  if (
    (value.currentSha !== undefined &&
      (typeof value.currentSha !== "string" || value.currentSha.length === 0)) ||
    (value.commitAtMs !== undefined &&
      (!Number.isInteger(value.commitAtMs) || Number(value.commitAtMs) < 0)) ||
    (value.installedAtMs !== undefined &&
      (!Number.isInteger(value.installedAtMs) || Number(value.installedAtMs) < 0))
  ) {
    return null;
  }
  return {
    ...(typeof value.currentSha === "string" ? { currentSha: value.currentSha } : {}),
    ...(value.commitAtMs === undefined ? {} : { commitAtMs: Number(value.commitAtMs) }),
    ...(value.installedAtMs === undefined ? {} : { installedAtMs: Number(value.installedAtMs) }),
  };
}

function readGitUpdateStatus(
  value: unknown,
): NonNullable<NonNullable<UpdateScheduleState["install"]>["git"]> | null {
  if (!isRecord(value)) {
    return null;
  }
  const metadata = readGitInstallMetadata(value);
  if (!metadata) {
    return null;
  }
  if (value.status === "current") {
    return { ...metadata, status: "current" };
  }
  if (
    value.status === "behind" &&
    Number.isInteger(value.commitsBehind) &&
    Number(value.commitsBehind) > 0
  ) {
    return { ...metadata, status: "behind", commitsBehind: Number(value.commitsBehind) };
  }
  if (
    value.status === "ahead" &&
    Number.isInteger(value.commitsAhead) &&
    Number(value.commitsAhead) > 0
  ) {
    return { ...metadata, status: "ahead", commitsAhead: Number(value.commitsAhead) };
  }
  if (
    value.status === "diverged" &&
    Number.isInteger(value.commitsAhead) &&
    Number(value.commitsAhead) > 0 &&
    Number.isInteger(value.commitsBehind) &&
    Number(value.commitsBehind) > 0
  ) {
    return {
      ...metadata,
      status: "diverged",
      commitsAhead: Number(value.commitsAhead),
      commitsBehind: Number(value.commitsBehind),
    };
  }
  if (
    value.status === "unavailable" &&
    (value.reason === "fetch-failed" ||
      value.reason === "no-upstream" ||
      value.reason === "no-upstream-sha" ||
      value.reason === "comparison-failed" ||
      value.reason === "git-unavailable")
  ) {
    return { ...metadata, status: "unavailable", reason: value.reason };
  }
  return null;
}

function readScheduleCampaign(value: unknown): UpdateScheduleState["campaign"] | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    (value.state !== "waiting-for-idle" &&
      value.state !== "countdown" &&
      value.state !== "applying") ||
    !Number.isInteger(value.announcedAtMs) ||
    Number(value.announcedAtMs) < 0 ||
    !Number.isInteger(value.forceAtMs) ||
    Number(value.forceAtMs) < 0 ||
    !Number.isInteger(value.updatedAtMs) ||
    Number(value.updatedAtMs) < 0 ||
    (value.applyAtMs !== undefined &&
      (!Number.isInteger(value.applyAtMs) || Number(value.applyAtMs) < 0)) ||
    (value.holdUntilMs !== undefined &&
      (!Number.isInteger(value.holdUntilMs) || Number(value.holdUntilMs) < 0))
  ) {
    return null;
  }
  return {
    id: value.id,
    state: value.state,
    announcedAtMs: Number(value.announcedAtMs),
    ...(value.applyAtMs === undefined ? {} : { applyAtMs: Number(value.applyAtMs) }),
    ...(value.holdUntilMs === undefined ? {} : { holdUntilMs: Number(value.holdUntilMs) }),
    forceAtMs: Number(value.forceAtMs),
    updatedAtMs: Number(value.updatedAtMs),
  };
}

export function readUpdateScheduleValue(value: unknown): UpdateScheduleState | null {
  if (
    !isRecord(value) ||
    typeof value.channel !== "string" ||
    typeof value.autoEnabled !== "boolean"
  ) {
    return null;
  }
  const rawInstall = isRecord(value.install) ? value.install : null;
  const rawInstallKind = rawInstall?.kind;
  const installKind =
    rawInstallKind === "package" || rawInstallKind === "git" || rawInstallKind === "unknown"
      ? rawInstallKind
      : undefined;
  if (value.install !== undefined && installKind === undefined) {
    return null;
  }
  const gitStatus = rawInstall?.git === undefined ? undefined : readGitUpdateStatus(rawInstall.git);
  if (rawInstall?.git !== undefined && !gitStatus) {
    return null;
  }
  const target = value.target === undefined ? undefined : readScheduleTarget(value.target);
  const campaign = value.campaign === undefined ? undefined : readScheduleCampaign(value.campaign);
  if ((value.target !== undefined && !target) || (value.campaign !== undefined && !campaign)) {
    return null;
  }
  return {
    channel: value.channel,
    autoEnabled: value.autoEnabled,
    ...(installKind
      ? { install: { kind: installKind, ...(gitStatus ? { git: gitStatus } : {}) } }
      : {}),
    ...(target ? { target } : {}),
    ...(campaign ? { campaign } : {}),
  };
}

export function readUpdateSchedule(hello: GatewayHelloOk | null): UpdateScheduleState | null {
  const snapshot = hello?.snapshot;
  if (!isRecord(snapshot)) {
    return null;
  }
  return readUpdateScheduleValue(snapshot.updateSchedule);
}
