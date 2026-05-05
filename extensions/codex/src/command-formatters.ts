import type { CodexComputerUseStatus } from "./app-server/computer-use.js";
import type { CodexAppServerModelListResult } from "./app-server/models.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./app-server/protocol.js";
import { summarizeCodexRateLimits } from "./app-server/rate-limits.js";
import type { SafeValue } from "./command-rpc.js";

type CodexStatusProbes = {
  models: SafeValue<CodexAppServerModelListResult>;
  account: SafeValue<JsonValue | undefined>;
  limits: SafeValue<JsonValue | undefined>;
  mcps: SafeValue<JsonValue | undefined>;
  skills: SafeValue<JsonValue | undefined>;
};

export function formatCodexStatus(probes: CodexStatusProbes): string {
  const connected =
    probes.models.ok || probes.account.ok || probes.limits.ok || probes.mcps.ok || probes.skills.ok;
  const lines = [`Codex app-server: ${connected ? "connected" : "unavailable"}`];
  if (probes.models.ok) {
    lines.push(
      `Models: ${
        probes.models.value.models
          .map((model) => formatCodexDisplayText(model.id))
          .slice(0, 8)
          .join(", ") || "none"
      }`,
    );
  } else {
    lines.push(`Models: ${formatCodexDisplayText(probes.models.error)}`);
  }
  lines.push(
    `Account: ${
      probes.account.ok
        ? formatCodexAccountSummary(probes.account.value)
        : formatCodexDisplayText(probes.account.error)
    }`,
  );
  lines.push(
    `Rate limits: ${
      probes.limits.ok
        ? formatCodexRateLimitSummary(probes.limits.value)
        : formatCodexDisplayText(probes.limits.error)
    }`,
  );
  lines.push(
    `MCP servers: ${
      probes.mcps.ok
        ? summarizeArrayLike(probes.mcps.value)
        : formatCodexDisplayText(probes.mcps.error)
    }`,
  );
  lines.push(
    `Skills: ${
      probes.skills.ok
        ? summarizeArrayLike(probes.skills.value)
        : formatCodexDisplayText(probes.skills.error)
    }`,
  );
  return lines.join("\n");
}

export function formatModels(result: CodexAppServerModelListResult): string {
  if (result.models.length === 0) {
    return "No Codex app-server models returned.";
  }
  const lines = [
    "Codex models:",
    ...result.models.map(
      (model) => `- ${formatCodexDisplayText(model.id)}${model.isDefault ? " (default)" : ""}`,
    ),
  ];
  if (result.truncated) {
    lines.push("- More models available; output truncated.");
  }
  return lines.join("\n");
}

export function formatThreads(response: JsonValue | undefined): string {
  const threads = extractArray(response);
  if (threads.length === 0) {
    return "No Codex threads returned.";
  }
  return [
    "Codex threads:",
    ...threads.slice(0, 10).map((thread) => {
      const record = isJsonObject(thread) ? thread : {};
      const id = readString(record, "threadId") ?? readString(record, "id") ?? "<unknown>";
      const title =
        readString(record, "title") ?? readString(record, "name") ?? readString(record, "summary");
      const details = [
        readString(record, "model"),
        readString(record, "cwd"),
        readString(record, "updatedAt") ?? readString(record, "lastUpdatedAt"),
      ].filter((value): value is string => Boolean(value));
      return `- ${formatCodexDisplayText(id)}${title ? ` - ${formatCodexDisplayText(title)}` : ""}${
        details.length > 0 ? ` (${details.map(formatCodexDisplayText).join(", ")})` : ""
      }\n  Resume: ${formatCodexResumeHint(id)}`;
    }),
  ].join("\n");
}

export function formatAccount(
  account: SafeValue<JsonValue | undefined>,
  limits: SafeValue<JsonValue | undefined>,
): string {
  return [
    `Account: ${account.ok ? formatCodexAccountSummary(account.value) : formatCodexDisplayText(account.error)}`,
    `Rate limits: ${
      limits.ok ? formatCodexRateLimitSummary(limits.value) : formatCodexDisplayText(limits.error)
    }`,
  ].join("\n");
}

export function formatComputerUseStatus(status: CodexComputerUseStatus): string {
  const lines = [
    `Computer Use: ${status.ready ? "ready" : status.enabled ? "not ready" : "disabled"}`,
  ];
  lines.push(
    `Plugin: ${formatCodexDisplayText(status.pluginName)} (${computerUsePluginState(status)})`,
  );
  lines.push(
    `MCP server: ${formatCodexDisplayText(status.mcpServerName)}${
      status.mcpServerAvailable ? ` (${status.tools.length} tools)` : " (unavailable)"
    }`,
  );
  if (status.marketplaceName) {
    lines.push(`Marketplace: ${formatCodexDisplayText(status.marketplaceName)}`);
  }
  if (status.tools.length > 0) {
    lines.push(`Tools: ${status.tools.slice(0, 8).map(formatCodexDisplayText).join(", ")}`);
  }
  lines.push(formatCodexDisplayText(status.message));
  return lines.join("\n");
}

function computerUsePluginState(status: CodexComputerUseStatus): string {
  if (!status.installed) {
    return "not installed";
  }
  return status.pluginEnabled ? "installed" : "installed, disabled";
}

export function formatList(response: JsonValue | undefined, label: string): string {
  const entries = extractArray(response);
  if (entries.length === 0) {
    return `${label}: none returned.`;
  }
  return [
    `${label}:`,
    ...entries.slice(0, 25).map((entry) => {
      const record = isJsonObject(entry) ? entry : {};
      return `- ${formatCodexDisplayText(
        readString(record, "name") ?? readString(record, "id") ?? JSON.stringify(entry),
      )}`;
    }),
  ].join("\n");
}

const CODEX_RESUME_SAFE_THREAD_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function formatCodexResumeHint(threadId: string): string {
  const safe = formatCodexTextForDisplay(threadId);
  if (!CODEX_RESUME_SAFE_THREAD_ID_PATTERN.test(safe)) {
    return "copy the thread id above and run /codex resume <thread-id>";
  }
  return `/codex resume ${safe}`;
}

export function formatCodexDisplayText(value: string): string {
  return escapeCodexChatText(formatCodexTextForDisplay(value));
}

function formatCodexAccountSummary(value: JsonValue | undefined): string {
  const safe = formatCodexTextForDisplay(summarizeAccount(value));
  return isLikelyEmailAddress(safe)
    ? escapeCodexChatTextPreservingAt(safe)
    : escapeCodexChatText(safe);
}

function formatCodexTextForDisplay(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    safe += codePoint != null && isUnsafeDisplayCodePoint(codePoint) ? "?" : character;
  }
  safe = safe.trim();
  return safe || "<unknown>";
}

function escapeCodexChatText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("@", "\uff20")
    .replaceAll("`", "\uff40")
    .replaceAll("[", "\uff3b")
    .replaceAll("]", "\uff3d")
    .replaceAll("(", "\uff08")
    .replaceAll(")", "\uff09")
    .replaceAll("*", "\u2217")
    .replaceAll("_", "\uff3f")
    .replaceAll("~", "\uff5e")
    .replaceAll("|", "\uff5c");
}

function escapeCodexChatTextPreservingAt(value: string): string {
  return escapeCodexChatText(value).replaceAll("\uff20", "@");
}

function isLikelyEmailAddress(value: string): boolean {
  return /^[^\s@<>()[\]`]+@[^\s@<>()[\]`]+\.[^\s@<>()[\]`]+$/.test(value);
}

function isUnsafeDisplayCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x001f ||
    (codePoint >= 0x007f && codePoint <= 0x009f) ||
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    codePoint === 0x180e ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f)
  );
}

export function buildHelp(): string {
  return [
    "Codex commands:",
    "- /codex status",
    "- /codex models",
    "- /codex threads [filter]",
    "- /codex resume <thread-id>",
    "- /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    "- /codex binding",
    "- /codex stop",
    "- /codex steer <message>",
    "- /codex model [model]",
    "- /codex fast [on|off|status]",
    "- /codex permissions [default|yolo|status]",
    "- /codex detach",
    "- /codex compact",
    "- /codex review",
    "- /codex diagnostics [note]",
    "- /codex computer-use [status|install]",
    "- /codex account",
    "- /codex mcp",
    "- /codex skills",
  ].join("\n");
}

function summarizeAccount(value: JsonValue | undefined): string {
  if (!isJsonObject(value)) {
    return "unavailable";
  }
  const account = isJsonObject(value.account) ? value.account : value;
  const accountType = readString(account, "type");
  if (accountType === "amazonBedrock") {
    return "Amazon Bedrock";
  }
  return (
    readString(account, "email") ??
    readString(account, "accountEmail") ??
    readString(account, "planType") ??
    readString(account, "id") ??
    "available"
  );
}

function summarizeArrayLike(value: JsonValue | undefined): string {
  const entries = extractArray(value);
  if (entries.length === 0) {
    return "none returned";
  }
  return `${entries.length}`;
}

function formatCodexRateLimitSummary(value: JsonValue | undefined): string {
  return formatCodexDisplayText(summarizeCodexRateLimits(value) ?? summarizeRateLimits(value));
}

function summarizeRateLimits(value: JsonValue | undefined): string {
  const entries = extractArray(value);
  if (entries.length > 0) {
    return `${entries.length}`;
  }
  if (!isJsonObject(value)) {
    return "none returned";
  }
  const keyed = value.rateLimitsByLimitId;
  if (isJsonObject(keyed)) {
    const count = Object.values(keyed).filter(isMeaningfulRateLimitSnapshot).length;
    if (count > 0) {
      return `${count}`;
    }
  }
  return isMeaningfulRateLimitSnapshot(value.rateLimits) ? "1" : "none returned";
}

function isMeaningfulRateLimitSnapshot(value: JsonValue | undefined): boolean {
  return isJsonObject(value) && Object.values(value).some((entry) => entry != null);
}

function extractArray(value: JsonValue | undefined): JsonValue[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isJsonObject(value)) {
    return [];
  }
  for (const key of ["data", "items", "threads", "models", "skills", "servers", "rateLimits"]) {
    const child = value[key];
    if (Array.isArray(child)) {
      return child;
    }
  }
  return [];
}

export function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
