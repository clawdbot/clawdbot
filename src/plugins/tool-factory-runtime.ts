/** Invokes current-context plugin tool factories and reports one assembly's timings. */
import { isInvalidConfigError } from "../config/io.invalid-config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginToolRegistration } from "./registry-types.js";
import type { OpenClawPluginToolContext } from "./types.js";

type PluginToolFactoryTiming = {
  pluginId: string;
  names: string[];
  durationMs: number;
  elapsedMs: number;
  result: "array" | "error" | "null" | "single";
  resultCount: number;
  optional: boolean;
};

const log = createSubsystemLogger("plugins/tools");
const PLUGIN_TOOL_FACTORY_WARN_TOTAL_MS = 5_000;
const PLUGIN_TOOL_FACTORY_WARN_FACTORY_MS = 1_000;
const PLUGIN_TOOL_FACTORY_SUMMARY_LIMIT = 20;

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

export function createPluginToolFactoryResolver(logError: (message: string) => void) {
  const factoryTimingStartedAt = Date.now();
  const factoryTimings: PluginToolFactoryTiming[] = [];
  const formatTimingSummary = (totalMs: number): string => {
    const ranked = factoryTimings
      .toSorted(
        (left, right) =>
          right.durationMs - left.durationMs || left.pluginId.localeCompare(right.pluginId),
      )
      .slice(0, PLUGIN_TOOL_FACTORY_SUMMARY_LIMIT);
    const omitted = factoryTimings.length - ranked.length;
    const factories = ranked.map(formatPluginToolFactoryTiming).join(", ");
    return [
      "[trace:plugin-tools] factory timings",
      `totalMs=${totalMs}`,
      `factoryCount=${factoryTimings.length}`,
      `shown=${ranked.length}`,
      `omitted=${omitted}`,
      `factories=${factories}`,
    ].join(" ");
  };
  return {
    resolve(
      entry: PluginToolRegistration,
      ctx: OpenClawPluginToolContext,
      declaredNames: string[],
    ) {
      let resolved: ReturnType<PluginToolRegistration["factory"]> = null;
      let failed = false;
      const factoryStartedAt = Date.now();
      try {
        resolved = entry.factory(ctx);
      } catch (err) {
        failed = true;
        // Only the config producer can confirm its diagnostic was emitted;
        // unlogged or wrapped tagged errors still need this resolver's report.
        if (!(isInvalidConfigError(err) && err.diagnosticEmitted)) {
          logError(`plugin tool failed (${entry.pluginId}): ${String(err)}`);
        }
      }
      const factoryEndedAt = Date.now();
      factoryTimings.push({
        pluginId: entry.pluginId,
        names: declaredNames,
        durationMs: Math.max(0, factoryEndedAt - factoryStartedAt),
        elapsedMs: Math.max(0, factoryEndedAt - factoryTimingStartedAt),
        result: failed
          ? "error"
          : !resolved
            ? "null"
            : Array.isArray(resolved)
              ? "array"
              : "single",
        resultCount: failed || !resolved ? 0 : Array.isArray(resolved) ? resolved.length : 1,
        optional: entry.optional,
      });
      return { resolved, failed };
    },
    report() {
      const last = factoryTimings.at(-1);
      if (last) {
        if (
          last.elapsedMs >= PLUGIN_TOOL_FACTORY_WARN_TOTAL_MS ||
          factoryTimings.some((timing) => timing.durationMs >= PLUGIN_TOOL_FACTORY_WARN_FACTORY_MS)
        ) {
          log.warn(formatTimingSummary(last.elapsedMs));
        } else if (log.isEnabled("trace")) {
          log.trace(formatTimingSummary(last.elapsedMs));
        }
      }
    },
  };
}
