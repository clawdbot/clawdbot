import type { CodexAppServerModelListResult } from "./app-server/models.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./app-server/protocol.js";
import type { SafeValue } from "./command-rpc.js";

export type CodexStatusProbes = {
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
          .map((model) => model.id)
          .slice(0, 8)
          .join(", ") || "none"
      }`,
    );
  } else {
    lines.push(`Models: ${probes.models.error}`);
  }
  lines.push(
    `Account: ${probes.account.ok ? summarizeAccount(probes.account.value) : probes.account.error}`,
  );
  lines.push(
    `Rate limits: ${probes.limits.ok ? summarizeArrayLike(probes.limits.value) : probes.limits.error}`,
  );
  lines.push(
    `MCP servers: ${probes.mcps.ok ? summarizeArrayLike(probes.mcps.value) : probes.mcps.error}`,
  );
  lines.push(
    `Skills: ${probes.skills.ok ? summarizeArrayLike(probes.skills.value) : probes.skills.error}`,
  );
  return lines.join("\n");
}

export function formatModels(result: CodexAppServerModelListResult): string {
  if (result.models.length === 0) {
    return "No Codex app-server models returned.";
  }
  return [
    "Codex models:",
    ...result.models.map((model) => `- ${model.id}${model.isDefault ? " (default)" : ""}`),
  ].join("\n");
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
      ].filter(Boolean);
      return `- ${id}${title ? ` - ${title}` : ""}${
        details.length > 0 ? ` (${details.join(", ")})` : ""
      }\n  Resume: /codex resume ${id}`;
    }),
  ].join("\n");
}

export function formatAccount(
  account: SafeValue<JsonValue | undefined>,
  limits: SafeValue<JsonValue | undefined>,
): string {
  return [
    `Account: ${account.ok ? summarizeAccount(account.value) : account.error}`,
    `Rate limits: ${limits.ok ? summarizeArrayLike(limits.value) : limits.error}`,
  ].join("\n");
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
      return `- ${readString(record, "name") ?? readString(record, "id") ?? JSON.stringify(entry)}`;
    }),
  ].join("\n");
}

export function buildHelp(): string {
  return [
    "Codex commands:",
    "- /codex status",
    "- /codex models",
    "- /codex threads [filter]",
    "- /codex resume <thread-id>",
    "- /codex compact",
    "- /codex review",
    "- /codex account",
    "- /codex mcp",
    "- /codex skills",
  ].join("\n");
}

function summarizeAccount(value: JsonValue | undefined): string {
  if (!isJsonObject(value)) {
    return "unavailable";
  }
  return (
    readString(value, "email") ??
    readString(value, "accountEmail") ??
    readString(value, "planType") ??
    readString(value, "id") ??
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
