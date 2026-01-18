import JSON5 from "json5";

import { parseFrontmatterBlock } from "../markdown/frontmatter.js";
import type {
  ClawdbotHookMetadata,
  HookEntry,
  HookInstallSpec,
  HookInvocationPolicy,
  ParsedHookFrontmatter,
} from "./types.js";

export function parseFrontmatter(content: string): ParsedHookFrontmatter {
  return parseFrontmatterBlock(content);
}

function normalizeStringList(input: unknown): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((value) => String(value).trim()).filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [];
}

function parseInstallSpec(input: unknown): HookInstallSpec | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const kindRaw =
    typeof raw.kind === "string" ? raw.kind : typeof raw.type === "string" ? raw.type : "";
  const kind = kindRaw.trim().toLowerCase();
  if (kind !== "bundled" && kind !== "npm" && kind !== "git") {
    return undefined;
  }

  const spec: HookInstallSpec = {
    kind: kind as HookInstallSpec["kind"],
  };

  if (typeof raw.id === "string") spec.id = raw.id;
  if (typeof raw.label === "string") spec.label = raw.label;
  const bins = normalizeStringList(raw.bins);
  if (bins.length > 0) spec.bins = bins;
  if (typeof raw.package === "string") spec.package = raw.package;
  if (typeof raw.repository === "string") spec.repository = raw.repository;

  return spec;
}

function getFrontmatterValue(frontmatter: ParsedHookFrontmatter, key: string): string | undefined {
  const raw = frontmatter[key];
  return typeof raw === "string" ? raw : undefined;
}

function parseFrontmatterBool(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

export function resolveClawdbotMetadata(
  frontmatter: ParsedHookFrontmatter,
): ClawdbotHookMetadata | undefined {
  const raw = getFrontmatterValue(frontmatter, "metadata");
  if (!raw) return undefined;
  try {
    const parsed = JSON5.parse(raw) as { clawdbot?: unknown };
    if (!parsed || typeof parsed !== "object") return undefined;
    const clawdbot = (parsed as { clawdbot?: unknown }).clawdbot;
    if (!clawdbot || typeof clawdbot !== "object") return undefined;
    const clawdbotObj = clawdbot as Record<string, unknown>;
    const requiresRaw =
      typeof clawdbotObj.requires === "object" && clawdbotObj.requires !== null
        ? (clawdbotObj.requires as Record<string, unknown>)
        : undefined;
    const installRaw = Array.isArray(clawdbotObj.install) ? (clawdbotObj.install as unknown[]) : [];
    const install = installRaw
      .map((entry) => parseInstallSpec(entry))
      .filter((entry): entry is HookInstallSpec => Boolean(entry));
    const osRaw = normalizeStringList(clawdbotObj.os);
    const eventsRaw = normalizeStringList(clawdbotObj.events);
    return {
      always: typeof clawdbotObj.always === "boolean" ? clawdbotObj.always : undefined,
      emoji: typeof clawdbotObj.emoji === "string" ? clawdbotObj.emoji : undefined,
      homepage: typeof clawdbotObj.homepage === "string" ? clawdbotObj.homepage : undefined,
      hookKey: typeof clawdbotObj.hookKey === "string" ? clawdbotObj.hookKey : undefined,
      export: typeof clawdbotObj.export === "string" ? clawdbotObj.export : undefined,
      os: osRaw.length > 0 ? osRaw : undefined,
      events: eventsRaw.length > 0 ? eventsRaw : [],
      requires: requiresRaw
        ? {
            bins: normalizeStringList(requiresRaw.bins),
            anyBins: normalizeStringList(requiresRaw.anyBins),
            env: normalizeStringList(requiresRaw.env),
            config: normalizeStringList(requiresRaw.config),
          }
        : undefined,
      install: install.length > 0 ? install : undefined,
    };
  } catch {
    return undefined;
  }
}

export function resolveHookInvocationPolicy(
  frontmatter: ParsedHookFrontmatter,
): HookInvocationPolicy {
  return {
    enabled: parseFrontmatterBool(getFrontmatterValue(frontmatter, "enabled"), true),
  };
}

export function resolveHookKey(hookName: string, entry?: HookEntry): string {
  return entry?.clawdbot?.hookKey ?? hookName;
}
