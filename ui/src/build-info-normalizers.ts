// Shared build identity normalization for the runtime artifact and Vite config.
import type { ControlUiBuildInfo } from "./build-info-types.ts";

type ControlUiBuildMetadata = Pick<ControlUiBuildInfo, "version" | "commit" | "builtAt">;

const FULL_GIT_SHA = /^[0-9a-f]{40}$/u;
const UTC_BUILD_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const BUILD_ID_MAX_LENGTH = 96;

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeControlUiCommit(value: unknown): string | null {
  const commit = normalizeOptionalString(value)?.toLowerCase() ?? null;
  return commit && FULL_GIT_SHA.test(commit) ? commit : null;
}

function normalizeControlUiBranch(value: unknown): string | null {
  const branch = normalizeOptionalString(value);
  return branch && branch !== "HEAD" ? branch.slice(0, 100) : null;
}

function normalizeControlUiBuildTimestamp(value: unknown): string | null {
  const timestamp = normalizeOptionalString(value);
  if (!timestamp || !UTC_BUILD_TIMESTAMP.test(timestamp)) {
    return null;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const canonicalInput = timestamp.replace(/(?:\.(\d{1,3}))?Z$/u, (_match, fraction) => {
    return `.${String(fraction ?? "").padEnd(3, "0")}Z`;
  });
  return date.toISOString() === canonicalInput ? date.toISOString() : null;
}

function normalizeControlUiBuildId(value: unknown): string {
  const normalized = normalizeOptionalString(value)?.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized?.slice(0, BUILD_ID_MAX_LENGTH) || "dev";
}

function deriveControlUiBuildId(info: ControlUiBuildMetadata): string {
  const identity = [info.version, info.commit?.slice(0, 12), info.builtAt]
    .filter((value): value is string => Boolean(value))
    .join("-");
  return normalizeControlUiBuildId(identity);
}

export function normalizeControlUiBuildInfo(value: unknown): ControlUiBuildInfo {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const optionalString = (candidate: unknown) =>
    typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
  const version = optionalString(record.version);
  const commit = normalizeControlUiCommit(record.commit);
  const builtAt = normalizeControlUiBuildTimestamp(record.builtAt);
  const metadata = { version, commit, builtAt };
  return {
    ...metadata,
    branch: normalizeControlUiBranch(record.branch),
    dirty: typeof record.dirty === "boolean" ? record.dirty : null,
    buildId: normalizeControlUiBuildId(record.buildId ?? deriveControlUiBuildId(metadata)),
  };
}
