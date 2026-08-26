import type { TrajectoryRecord } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export function formatTrajectoryDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return "—";
  }
  if (durationMs < 1000) {
    return `${Math.round(durationMs)} ms`;
  }
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

export function formatTrajectoryClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function trajectoryDetailTabs(record: TrajectoryRecord, detail: unknown): string[] {
  if (record.kind === "system") {
    return ["System Prompt", "Tools"];
  }
  if (record.kind === "request") {
    return ["Summary", "Options", "Usage", "Timing"];
  }
  if (record.kind === "compacted") {
    return ["Summary", "Raw Output"];
  }
  if (record.kind === "tool" || record.kind === "subtool") {
    const raw = isRecord(detail) ? detail : undefined;
    const data = isRecord(raw?.data) ? raw.data : undefined;
    const hasPayload =
      data && ["arguments", "input", "options", "payload"].some((key) => Object.hasOwn(data, key));
    const hasResult = Boolean(
      raw?.message !== undefined ||
      (data &&
        ["error", "errorMessage", "output", "result"].some((key) => Object.hasOwn(data, key))),
    );
    return [
      "Summary",
      ...(hasPayload ? ["Payload"] : []),
      ...(hasResult ? ["Result"] : []),
      "Schema",
      "Timing",
    ];
  }
  return ["Summary", "Preview", "Raw", ...(record.source === "transcript" ? ["Source"] : [])];
}

export function trajectoryRecordMatches(record: TrajectoryRecord, search: string): boolean {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) {
    return true;
  }
  return [record.title, record.preview, record.type, record.toolName, record.provider, record.model]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLocaleLowerCase().includes(needle));
}
