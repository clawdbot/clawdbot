import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { summarizeStringEntries } from "openclaw/plugin-sdk/text-runtime";
import { formatThreadBindingDurationLabel } from "./thread-bindings.messages.js";

function formatThreadBindingDurationForConfigLabel(durationMs: number): string {
  const label = formatThreadBindingDurationLabel(durationMs);
  return label === "disabled" ? "off" : label;
}

export function logDiscordResolvedConfig(params: {
  dmEnabled: boolean;
  dmPolicy: string;
  allowFrom?: string[];
  groupDmEnabled: boolean;
  groupDmChannels?: string[];
  groupPolicy: string;
  guildEntries?: Record<string, unknown>;
  historyLimit: number;
  mediaMaxBytes: number;
  nativeEnabled: boolean;
  nativeSkillsEnabled: boolean;
  useAccessGroups: boolean;
  threadBindingsEnabled: boolean;
  threadBindingIdleTimeoutMs: number;
  threadBindingMaxAgeMs: number;
}): void {
  const allowFromSummary = summarizeStringEntries({
    entries: params.allowFrom ?? [],
    limit: 4,
    emptyText: "any",
  });
  const groupDmChannelSummary = summarizeStringEntries({
    entries: params.groupDmChannels ?? [],
    limit: 4,
    emptyText: "any",
  });
  const guildSummary = summarizeStringEntries({
    entries: Object.keys(params.guildEntries ?? {}),
    limit: 4,
    emptyText: "any",
  });
  logVerbose(
    `discord: config dm=${params.dmEnabled ? "on" : "off"} dmPolicy=${params.dmPolicy} allowFrom=${allowFromSummary} groupDm=${params.groupDmEnabled ? "on" : "off"} groupDmChannels=${groupDmChannelSummary} groupPolicy=${params.groupPolicy} guilds=${guildSummary} historyLimit=${params.historyLimit} mediaMaxMb=${Math.round(params.mediaMaxBytes / (1024 * 1024))} native=${params.nativeEnabled ? "on" : "off"} nativeSkills=${params.nativeSkillsEnabled ? "on" : "off"} accessGroups=${params.useAccessGroups ? "on" : "off"} threadBindings=${params.threadBindingsEnabled ? "on" : "off"} threadIdleTimeout=${formatThreadBindingDurationForConfigLabel(params.threadBindingIdleTimeoutMs)} threadMaxAge=${formatThreadBindingDurationForConfigLabel(params.threadBindingMaxAgeMs)}`,
  );
}
