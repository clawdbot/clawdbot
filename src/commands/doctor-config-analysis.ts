import path from "node:path";
import type { ZodIssue } from "zod";
import { CONFIG_PATH } from "../config/config.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { OpenClawSchema } from "../config/zod-schema.js";
import { resolvePrimaryStringValue } from "../shared/string-coerce.js";
import { note } from "../terminal/note.js";
import { isRecord } from "../utils.js";

type UnrecognizedKeysIssue = ZodIssue & {
  code: "unrecognized_keys";
  keys: PropertyKey[];
};

function normalizeIssuePath(path: PropertyKey[]): Array<string | number> {
  return path.filter((part): part is string | number => typeof part !== "symbol");
}

function isUnrecognizedKeysIssue(issue: ZodIssue): issue is UnrecognizedKeysIssue {
  return issue.code === "unrecognized_keys";
}

export function formatConfigPath(parts: Array<string | number>): string {
  if (parts.length === 0) {
    return "<root>";
  }
  let out = "";
  for (const part of parts) {
    if (typeof part === "number") {
      out += `[${part}]`;
      continue;
    }
    out = out ? `${out}.${part}` : part;
  }
  return out || "<root>";
}

export function resolveConfigPathTarget(root: unknown, path: Array<string | number>): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) {
        return null;
      }
      if (part < 0 || part >= current.length) {
        return null;
      }
      current = current[part];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    const record = current as Record<string, unknown>;
    if (!(part in record)) {
      return null;
    }
    current = record[part];
  }
  return current;
}

export function stripUnknownConfigKeys(config: OpenClawConfig): {
  config: OpenClawConfig;
  removed: string[];
} {
  const parsed = OpenClawSchema.safeParse(config);
  if (parsed.success) {
    return { config, removed: [] };
  }

  const next = structuredClone(config);
  const removed: string[] = [];
  for (const issue of parsed.error.issues) {
    if (!isUnrecognizedKeysIssue(issue)) {
      continue;
    }
    const issuePath = normalizeIssuePath(issue.path);
    const target = resolveConfigPathTarget(next, issuePath);
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      continue;
    }
    const record = target as Record<string, unknown>;
    for (const key of issue.keys) {
      if (typeof key !== "string" || !(key in record)) {
        continue;
      }
      delete record[key];
      removed.push(formatConfigPath([...issuePath, key]));
    }
  }

  return { config: next, removed };
}

export function noteOpencodeProviderOverrides(cfg: OpenClawConfig): void {
  const providers = cfg.models?.providers;
  if (!providers) {
    return;
  }

  const overrides: string[] = [];
  if (providers.opencode) {
    overrides.push("opencode");
  }
  if (providers["opencode-zen"]) {
    overrides.push("opencode-zen");
  }
  if (providers["opencode-go"]) {
    overrides.push("opencode-go");
  }
  if (overrides.length === 0) {
    return;
  }

  const lines = overrides.flatMap((id) => {
    const providerLabel = id === "opencode-go" ? "OpenCode Go" : "OpenCode Zen";
    const providerEntry = providers[id];
    const api =
      isRecord(providerEntry) && typeof providerEntry.api === "string"
        ? providerEntry.api
        : undefined;
    return [
      `- models.providers.${id} is set; this overrides the built-in ${providerLabel} catalog.`,
      api ? `- models.providers.${id}.api=${api}` : null,
    ].filter((line): line is string => Boolean(line));
  });

  lines.push(
    "- Remove these entries to restore per-model API routing + costs (then re-run setup if needed).",
  );
  note(lines.join("\n"), "OpenCode");
}

function isImplicitFallbackClobber(model: unknown): boolean {
  const primary = resolvePrimaryStringValue(model);
  if (typeof model === "string") {
    return primary !== undefined;
  }
  if (model !== null && typeof model === "object" && !Array.isArray(model)) {
    const obj = model as Record<string, unknown>;
    // Object with primary but no fallbacks key — intent is ambiguous; warn.
    // Object with fallbacks: [] — explicit no-fallbacks; no warn.
    return (
      Object.hasOwn(obj, "primary") && !Object.hasOwn(obj, "fallbacks") && primary !== undefined
    );
  }
  return false;
}

export function collectImplicitFallbackClobberWarnings(cfg: OpenClawConfig): string[] {
  const defaultFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
  if (defaultFallbacks.length === 0) {
    return [];
  }
  const warnings: string[] = [];
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    if (!agent || !isImplicitFallbackClobber(agent.model)) {
      continue;
    }
    const id = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : String(index);
    const primary = resolvePrimaryStringValue(agent.model);
    const location = `agents.list[${index}].model (id=${id})`;
    const modelStr =
      typeof agent.model === "string" ? `"${agent.model}"` : `{ primary: "${primary}" }`;
    const shape =
      typeof agent.model === "string"
        ? "bare string with no fallbacks"
        : 'object with no explicit "fallbacks" key';
    warnings.push(
      [
        `- ${location} is ${modelStr}, a ${shape}. At runtime this clobbers agents.defaults.model.fallbacks (${defaultFallbacks.join(", ")}), leaving the agent with no fallbacks.`,
        `  Fix: add "fallbacks": [...] to inherit or override, or "fallbacks": [] to explicitly disable.`,
      ].join("\n"),
    );
  }
  return warnings;
}

export function noteImplicitFallbackClobberWarnings(cfg: OpenClawConfig): void {
  const warnings = collectImplicitFallbackClobberWarnings(cfg);
  if (warnings.length === 0) {
    return;
  }
  note(warnings.join("\n"), "Doctor warnings");
}

export function noteIncludeConfinementWarning(snapshot: {
  path?: string | null;
  issues?: Array<{ message: string }>;
}): void {
  const issues = snapshot.issues ?? [];
  const includeIssue = issues.find(
    (issue) =>
      issue.message.includes("Include path escapes config directory") ||
      issue.message.includes("Include path resolves outside config directory"),
  );
  if (!includeIssue) {
    return;
  }
  const configRoot = path.dirname(snapshot.path ?? CONFIG_PATH);
  note(
    [
      `- $include paths must stay under: ${configRoot}`,
      '- Move shared include files under that directory and update to relative paths like "./shared/common.json".',
      `- Error: ${includeIssue.message}`,
    ].join("\n"),
    "Doctor warnings",
  );
}
