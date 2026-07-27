import type { AnyAgentTool } from "../agents/tools/common.js";

export type PluginToolFactoryResult = AnyAgentTool | AnyAgentTool[] | null | undefined;

export type PluginToolFactoryTiming = {
  pluginId: string;
  names: string[];
  durationMs: number;
  elapsedMs: number;
  result: "array" | "error" | "null" | "single";
  resultCount: number;
  optional: boolean;
};

const PLUGIN_TOOL_FACTORY_WARN_TOTAL_MS = 5_000;
const PLUGIN_TOOL_FACTORY_WARN_FACTORY_MS = 1_000;
const PLUGIN_TOOL_FACTORY_SUMMARY_LIMIT = 20;

export function toElapsedMs(value: number): number {
  return Math.max(0, Math.round(value));
}

export function createPluginToolFactoryTiming(params: {
  pluginId: string;
  names: string[];
  durationMs: number;
  elapsedMs: number;
  resolved: PluginToolFactoryResult;
  failed: boolean;
  optional: boolean;
}): PluginToolFactoryTiming {
  const result = params.failed
    ? { result: "error" as const, resultCount: 0 }
    : !params.resolved
      ? { result: "null" as const, resultCount: 0 }
      : Array.isArray(params.resolved)
        ? { result: "array" as const, resultCount: params.resolved.length }
        : { result: "single" as const, resultCount: 1 };
  return {
    pluginId: params.pluginId,
    names: params.names,
    durationMs: params.durationMs,
    elapsedMs: params.elapsedMs,
    result: result.result,
    resultCount: result.resultCount,
    optional: params.optional,
  };
}

function formatPluginToolFactoryTiming(timing: PluginToolFactoryTiming): string {
  const names = timing.names.length > 0 ? timing.names.join("|") : "-";
  return [
    `${timing.pluginId}:${timing.durationMs}ms@${timing.elapsedMs}ms`,
    `names=[${names}]`,
    `result=${timing.result}`,
    `count=${timing.resultCount}`,
    `optional=${String(timing.optional)}`,
  ].join(" ");
}

export function formatPluginToolFactoryTimingSummary(params: {
  totalMs: number;
  timings: PluginToolFactoryTiming[];
}): string {
  const ranked = params.timings
    .toSorted(
      (left, right) =>
        right.durationMs - left.durationMs || left.pluginId.localeCompare(right.pluginId),
    )
    .slice(0, PLUGIN_TOOL_FACTORY_SUMMARY_LIMIT);
  const omitted = Math.max(0, params.timings.length - ranked.length);
  const factories =
    ranked.length > 0
      ? ranked.map((timing) => formatPluginToolFactoryTiming(timing)).join(", ")
      : "none";
  return [
    "[trace:plugin-tools] factory timings",
    `totalMs=${params.totalMs}`,
    `factoryCount=${params.timings.length}`,
    `shown=${ranked.length}`,
    `omitted=${omitted}`,
    `factories=${factories}`,
  ].join(" ");
}

export function shouldWarnPluginToolFactoryTimings(params: {
  totalMs: number;
  timings: PluginToolFactoryTiming[];
}): boolean {
  return (
    params.totalMs >= PLUGIN_TOOL_FACTORY_WARN_TOTAL_MS ||
    params.timings.some((timing) => timing.durationMs >= PLUGIN_TOOL_FACTORY_WARN_FACTORY_MS)
  );
}
