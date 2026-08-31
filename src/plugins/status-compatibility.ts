/** Lightweight formatting contract for plugin compatibility notices. */
import type { PluginCompatCode } from "./compat/registry.js";

export type PluginCompatibilityNotice = {
  pluginId: string;
  code: "hook-only" | "removed-session-transcript-file-api";
  compatCode: PluginCompatCode;
  severity: "warn" | "info";
  message: string;
};

export type PluginCompatibilitySummary = {
  noticeCount: number;
  pluginCount: number;
};

export function formatPluginCompatibilityNotice(notice: PluginCompatibilityNotice): string {
  return `${notice.pluginId} ${notice.message}`;
}

export function summarizePluginCompatibility(
  notices: PluginCompatibilityNotice[],
): PluginCompatibilitySummary {
  return {
    noticeCount: notices.length,
    pluginCount: new Set(notices.map((notice) => notice.pluginId)).size,
  };
}
