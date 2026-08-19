// Shared build identity normalization for the runtime artifact and Vite config.
// Vite loads this module before source-package aliases exist, so use the canonical source path.
import { asRecord } from "../../packages/normalization-core/src/record-coerce.js";
import { normalizeNullableString } from "../../packages/normalization-core/src/string-coerce.js";
import { truncateUtf16Safe } from "../../packages/normalization-core/src/utf16-slice.js";
import type { ControlUiBuildInfo } from "./build-info-types.ts";

type ControlUiBuildMetadata = Pick<
  ControlUiBuildInfo,
  "version" | "commit" | "builtAt" | "release"
>;

const FULL_GIT_SHA = /^[0-9a-f]{40}$/u;
const UTC_BUILD_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const BUILD_ID_MAX_LENGTH = 96;

function normalizeControlUiCommit(value: unknown): string | null {
  const commit = normalizeNullableString(value)?.toLowerCase() ?? null;
  return commit && FULL_GIT_SHA.test(commit) ? commit : null;
}

function normalizeControlUiBranch(value: unknown): string | null {
  const branch = normalizeNullableString(value);
  return branch && branch !== "HEAD" ? truncateUtf16Safe(branch, 100) : null;
}

function normalizeControlUiBuildTimestamp(value: unknown): string | null {
  const timestamp = normalizeNullableString(value);
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
  const normalized = normalizeNullableString(value)?.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized?.slice(0, BUILD_ID_MAX_LENGTH) || "dev";
}

function deriveControlUiBuildId(info: ControlUiBuildMetadata): string {
  const identity = [
    info.version,
    info.release ? "release" : null,
    info.commit?.slice(0, 12),
    info.builtAt,
  ]
    .filter((value): value is string => Boolean(value))
    .join("-");
  return normalizeControlUiBuildId(identity);
}

export function normalizeControlUiBuildInfo(value: unknown): ControlUiBuildInfo {
  const record = asRecord(value);
  const version = normalizeNullableString(record.version);
  const commit = normalizeControlUiCommit(record.commit);
  const builtAt = normalizeControlUiBuildTimestamp(record.builtAt);
  const release = record.release === true;
  const metadata = { version, commit, builtAt, release };
  return {
    ...metadata,
    commitAt: normalizeControlUiBuildTimestamp(record.commitAt),
    branch: normalizeControlUiBranch(record.branch),
    dirty: typeof record.dirty === "boolean" ? record.dirty : null,
    buildId: normalizeControlUiBuildId(record.buildId ?? deriveControlUiBuildId(metadata)),
  };
}
