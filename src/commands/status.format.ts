import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getSystemdCgroupHygieneSummary } from "../daemon/service-runtime.js";
import { formatDurationPrecise } from "../infra/format-time/format-duration.ts";
import { formatRuntimeStatusWithDetails } from "../infra/runtime-status.ts";
import type { SessionStatus } from "./status.types.js";
export { shortenText } from "./text-format.js";

export const formatKTokens = (value: number) =>
  `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;

export const formatDuration = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) {
    return "unknown";
  }
  return formatDurationPrecise(ms, { decimals: 1 });
};

export const formatTokensCompact = (
  sess: Pick<
    SessionStatus,
    "inputTokens" | "totalTokens" | "contextTokens" | "percentUsed" | "cacheRead" | "cacheWrite"
  >,
) => {
  const used = sess.totalTokens;
  const ctx = sess.contextTokens;

  let result = "";
  if (used == null) {
    result = ctx ? `unknown/${formatKTokens(ctx)} (?%)` : "unknown used";
  } else if (!ctx) {
    result = `${formatKTokens(used)} used`;
  } else {
    const pctLabel = sess.percentUsed != null ? `${sess.percentUsed}%` : "?%";
    result = `${formatKTokens(used)}/${formatKTokens(ctx)} (${pctLabel})`;
  }

  const cacheStats = resolvePromptCacheStats(sess);
  if (cacheStats && cacheStats.cacheRead > 0) {
    result += ` · 🗄️ ${cacheStats.hitRate}% cached`;
  }

  return result;
};

export const formatPromptCacheCompact = (
  sess: Pick<SessionStatus, "inputTokens" | "totalTokens" | "cacheRead" | "cacheWrite">,
) => {
  const cacheStats = resolvePromptCacheStats(sess);
  if (!cacheStats) {
    return "";
  }
  const parts = [`${cacheStats.hitRate}% hit`];
  if (cacheStats.cacheRead > 0) {
    parts.push(`read ${formatKTokens(cacheStats.cacheRead)}`);
  }
  if (cacheStats.cacheWrite > 0) {
    parts.push(`write ${formatKTokens(cacheStats.cacheWrite)}`);
  }
  return parts.join(" · ");
};

function resolvePromptCacheStats(
  sess: Pick<SessionStatus, "inputTokens" | "totalTokens" | "cacheRead" | "cacheWrite">,
) {
  const cacheRead =
    typeof sess.cacheRead === "number" && Number.isFinite(sess.cacheRead) && sess.cacheRead >= 0
      ? sess.cacheRead
      : 0;
  const cacheWrite =
    typeof sess.cacheWrite === "number" && Number.isFinite(sess.cacheWrite) && sess.cacheWrite >= 0
      ? sess.cacheWrite
      : 0;
  if (cacheRead <= 0 && cacheWrite <= 0) {
    return null;
  }
  const inputTokens =
    typeof sess.inputTokens === "number" &&
    Number.isFinite(sess.inputTokens) &&
    sess.inputTokens >= 0
      ? sess.inputTokens
      : undefined;
  const promptTokensFromParts =
    inputTokens != null ? inputTokens + cacheRead + cacheWrite : undefined;
  const used = sess.totalTokens;
  // Legacy entries can carry an undersized totalTokens value. Keep the cache
  // denominator aligned with the prompt-side token fields when available, and
  // never let the fallback denominator drop below the known cached prompt
  // tokens.
  const total =
    promptTokensFromParts ??
    (typeof used === "number" && Number.isFinite(used) && used > 0
      ? Math.max(used, cacheRead + cacheWrite)
      : cacheRead + cacheWrite);
  return {
    cacheRead,
    cacheWrite,
    hitRate: total > 0 ? Math.round((cacheRead / total) * 100) : 0,
  };
}

export const formatDaemonRuntimeShort = (runtime?: {
  status?: string;
  pid?: number;
  state?: string;
  systemd?: { killMode?: string; tasksCurrent?: number; memoryCurrent?: number };
  detail?: string;
  missingUnit?: boolean;
}) => {
  if (!runtime) {
    return null;
  }
  const details: string[] = [];
  const detail = runtime.detail?.replace(/\s+/g, " ").trim() || "";
  const noisyLaunchctlDetail =
    runtime.missingUnit === true &&
    normalizeLowercaseStringOrEmpty(detail).includes("could not find service");
  if (detail && !noisyLaunchctlDetail) {
    details.push(detail);
  }
  const cgroupSummary = getSystemdCgroupHygieneSummary(runtime.systemd);
  if (cgroupSummary) {
    details.push(cgroupSummary);
  }
  return formatRuntimeStatusWithDetails({
    status: runtime.status,
    pid: runtime.pid,
    state: runtime.state,
    details,
  });
};
