import fs from "node:fs";
import path from "node:path";
import type { ZodIssue } from "zod";

import type { MoltbotConfig } from "../config/config.js";
import {
  MoltbotSchema,
  CONFIG_PATH,
  migrateLegacyConfig,
  readConfigFileSnapshot,
} from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { formatCliCommand } from "../cli/command-format.js";
import { note } from "../terminal/note.js";
import { normalizeLegacyConfigValues } from "./doctor-legacy-config.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { autoMigrateLegacyStateDir } from "./doctor-state-migrations.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

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

function formatPath(parts: Array<string | number>): string {
  if (parts.length === 0) return "<root>";
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

function resolvePathTarget(root: unknown, path: Array<string | number>): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) return null;
      if (part < 0 || part >= current.length) return null;
      current = current[part];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    const record = current as Record<string, unknown>;
    if (!(part in record)) return null;
    current = record[part];
  }
  return current;
}

function stripUnknownConfigKeys(config: MoltbotConfig): {
  config: MoltbotConfig;
  removed: string[];
} {
  const parsed = MoltbotSchema.safeParse(config);
  if (parsed.success) {
    return { config, removed: [] };
  }

  const next = structuredClone(config) as MoltbotConfig;
  const removed: string[] = [];
  for (const issue of parsed.error.issues) {
    if (!isUnrecognizedKeysIssue(issue)) continue;
    const path = normalizeIssuePath(issue.path);
    const target = resolvePathTarget(next, path);
    if (!target || typeof target !== "object" || Array.isArray(target)) continue;
    const record = target as Record<string, unknown>;
    for (const key of issue.keys) {
      if (typeof key !== "string") continue;
      if (!(key in record)) continue;
      delete record[key];
      removed.push(formatPath([...path, key]));
    }
  }

  return { config: next, removed };
}

function noteOpencodeProviderOverrides(cfg: MoltbotConfig) {
  const providers = cfg.models?.providers;
  if (!providers) return;

  // 2026-01-10: warn when OpenCode Zen overrides mask built-in routing/costs (8a194b4abc360c6098f157956bb9322576b44d51, 2d105d16f8a099276114173836d46b46cdfbdbae).
  const overrides: string[] = [];
  if (providers.opencode) overrides.push("opencode");
  if (providers["opencode-zen"]) overrides.push("opencode-zen");
  if (overrides.length === 0) return;

  const lines = overrides.flatMap((id) => {
    const providerEntry = providers[id];
    const api =
      isRecord(providerEntry) && typeof providerEntry.api === "string"
        ? providerEntry.api
        : undefined;
    return [
      `- models.providers.${id} is set; this overrides the built-in OpenCode Zen catalog.`,
      api ? `- models.providers.${id}.api=${api}` : null,
    ].filter((line): line is string => Boolean(line));
  });

  lines.push(
    "- Remove these entries to restore per-model API routing + costs (then re-run onboarding if needed).",
  );

  note(lines.join("\n"), "OpenCode Zen");
}

function hasExplicitConfigPath(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.MOLTBOT_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim());
}

function moveLegacyConfigFile(legacyPath: string, canonicalPath: string) {
  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(legacyPath, canonicalPath);
  } catch {
    fs.copyFileSync(legacyPath, canonicalPath);
    fs.chmodSync(canonicalPath, 0o600);
    try {
      fs.unlinkSync(legacyPath);
    } catch {
      // Best-effort cleanup; we'll warn later if both files exist.
    }
  }
}

export async function loadAndMaybeMigrateDoctorConfig(params: {
  options: DoctorOptions;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
}) {
  const shouldRepair = params.options.repair === true || params.options.yes === true;
  const stateDirResult = await autoMigrateLegacyStateDir({ env: process.env });
  if (stateDirResult.changes.length > 0) {
    note(stateDirResult.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
  }
  if (stateDirResult.warnings.length > 0) {
    note(stateDirResult.warnings.map((entry) => `- ${entry}`).join("\n"), "Doctor warnings");
  }

  let snapshot = await readConfigFileSnapshot();
  if (!hasExplicitConfigPath(process.env) && snapshot.exists) {
    const basename = path.basename(snapshot.path);
    if (basename === "clawdbot.json") {
      const canonicalPath = path.join(path.dirname(snapshot.path), "moltbot.json");
      if (!fs.existsSync(canonicalPath)) {
        moveLegacyConfigFile(snapshot.path, canonicalPath);
        note(`- Config: ${snapshot.path} → ${canonicalPath}`, "Doctor changes");
        snapshot = await readConfigFileSnapshot();
      }
    }
  }
  const baseCfg = snapshot.config ?? {};
  let cfg: MoltbotConfig = baseCfg;
  let candidate = structuredClone(baseCfg) as MoltbotConfig;
  let pendingChanges = false;
  let shouldWriteConfig = false;
  const fixHints: string[] = [];
  if (snapshot.exists && !snapshot.valid && snapshot.legacyIssues.length === 0) {
    note("Config invalid; doctor will run with best-effort config.", "Config");
  }
  const warnings = snapshot.warnings ?? [];
  if (warnings.length > 0) {
    const lines = warnings.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
    note(lines, "Config warnings");
  }

  if (snapshot.legacyIssues.length > 0) {
    note(
      snapshot.legacyIssues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n"),
      "Legacy config keys detected",
    );
    const { config: migrated, changes } = migrateLegacyConfig(snapshot.parsed);
    if (changes.length > 0) {
      note(changes.join("\n"), "Doctor changes");
    }
    if (migrated) {
      candidate = migrated;
      pendingChanges = pendingChanges || changes.length > 0;
    }
    if (shouldRepair) {
      // Legacy migration (2026-01-02, commit: 16420e5b) — normalize per-provider allowlists; move WhatsApp gating into channels.whatsapp.allowFrom.
      if (migrated) cfg = migrated;
    } else {
      fixHints.push(
        `Run "${formatCliCommand("moltbot doctor --fix")}" to apply legacy migrations.`,
      );
    }
  }

  const normalized = normalizeLegacyConfigValues(candidate);
  if (normalized.changes.length > 0) {
    note(normalized.changes.join("\n"), "Doctor changes");
    candidate = normalized.config;
    pendingChanges = true;
    if (shouldRepair) {
      cfg = normalized.config;
    } else {
      fixHints.push(`Run "${formatCliCommand("moltbot doctor --fix")}" to apply these changes.`);
    }
  }

  const autoEnable = applyPluginAutoEnable({ config: candidate, env: process.env });
  if (autoEnable.changes.length > 0) {
    note(autoEnable.changes.join("\n"), "Doctor changes");
    candidate = autoEnable.config;
    pendingChanges = true;
    if (shouldRepair) {
      cfg = autoEnable.config;
    } else {
      fixHints.push(`Run "${formatCliCommand("moltbot doctor --fix")}" to apply these changes.`);
    }
  }

  const unknown = stripUnknownConfigKeys(candidate);
  if (unknown.removed.length > 0) {
    const lines = unknown.removed.map((path) => `- ${path}`).join("\n");
    candidate = unknown.config;
    pendingChanges = true;
    if (shouldRepair) {
      cfg = unknown.config;
      note(lines, "Doctor changes");
    } else {
      note(lines, "Unknown config keys");
      fixHints.push('Run "moltbot doctor --fix" to remove these keys.');
    }
  }

  if (!shouldRepair && pendingChanges) {
    const shouldApply = await params.confirm({
      message: "Apply recommended config repairs now?",
      initialValue: true,
    });
    if (shouldApply) {
      cfg = candidate;
      shouldWriteConfig = true;
    } else if (fixHints.length > 0) {
      note(fixHints.join("\n"), "Doctor");
    }
  }

  noteOpencodeProviderOverrides(cfg);

  return { cfg, path: snapshot.path ?? CONFIG_PATH, shouldWriteConfig };
}
