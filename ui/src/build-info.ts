// Compile-time identity for the Control UI artifact.

export type ControlUiBuildInfo = Readonly<{
  version: string | null;
  commit: string | null;
  builtAt: string | null;
  buildId: string;
}>;

type ControlUiBuildMetadata = Pick<ControlUiBuildInfo, "version" | "commit" | "builtAt">;

const FULL_GIT_SHA = /^[0-9a-f]{40}$/u;
const UTC_BUILD_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const BUILD_ID_MAX_LENGTH = 96;

declare global {
  // Vite replaces this property with one object so the UI and service worker
  // share the exact artifact identity without separate compile-time constants.
  var OPENCLAW_CONTROL_UI_BUILD_INFO: ControlUiBuildInfo | undefined;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeControlUiCommit(value: unknown): string | null {
  const commit = normalizeOptionalString(value)?.toLowerCase() ?? null;
  return commit && FULL_GIT_SHA.test(commit) ? commit : null;
}

export function normalizeControlUiBuildTimestamp(value: unknown): string | null {
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

export function normalizeControlUiBuildId(value: unknown): string {
  const normalized = normalizeOptionalString(value)?.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized?.slice(0, BUILD_ID_MAX_LENGTH) || "dev";
}

export function deriveControlUiBuildId(info: ControlUiBuildMetadata): string {
  const identity = [info.version, info.commit?.slice(0, 12), info.builtAt]
    .filter((value): value is string => Boolean(value))
    .join("-");
  return normalizeControlUiBuildId(identity);
}

export function normalizeControlUiBuildInfo(value: unknown): ControlUiBuildInfo {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const version = normalizeOptionalString(record.version);
  const commit = normalizeControlUiCommit(record.commit);
  const builtAt = normalizeControlUiBuildTimestamp(record.builtAt);
  const metadata = { version, commit, builtAt };
  return {
    ...metadata,
    buildId: normalizeControlUiBuildId(record.buildId ?? deriveControlUiBuildId(metadata)),
  };
}

const injectedBuildInfo = globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO;

export const CONTROL_UI_BUILD_INFO = normalizeControlUiBuildInfo(injectedBuildInfo);
