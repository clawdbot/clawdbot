/**
 * Policy Presets - Built-in rule sets users can reference by name.
 *
 * Presets provide sensible defaults for common governance postures.
 * Users can override individual fields and append additional rules.
 */

import type { PolicyConfig, PolicyRule } from "./policy-types.js";

export type PresetName = "permissive" | "safety" | "strict" | "audit-only";

export type PresetDefinition = {
  name: PresetName;
  description: string;
  config: PolicyConfig;
};

const SAFETY_RULES: PolicyRule[] = [
  {
    id: "deny-destructive-commands",
    name: "Block destructive shell commands",
    priority: 1,
    decision: "deny",
    reason: "Destructive command blocked by safety preset",
    match: {
      tools: ["Bash"],
      targetPatterns: ["rm\\s+-rf", "mkfs\\."],
      targetPatternsAreRegex: true,
    },
  },
  {
    id: "deny-secret-files",
    name: "Block reading secret files",
    priority: 5,
    decision: "deny",
    reason: "Secret file access denied by safety preset",
    match: {
      categories: ["file_read"],
      targetPatterns: ["**/.env", "**/.env.*", "**/credentials.*", "**/*secret*"],
    },
  },
  {
    id: "warn-network",
    name: "Warn on network access",
    priority: 10,
    decision: "warn",
    reason: "Network access flagged by safety preset",
    match: {
      categories: ["network"],
    },
  },
];

const PRESETS: Record<PresetName, PresetDefinition> = {
  permissive: {
    name: "permissive",
    description: "Pure observation — no rules, all actions allowed",
    config: {
      defaultPolicy: "allow",
      enforce: false,
      rules: [],
    },
  },
  safety: {
    name: "safety",
    description: "Deny destructive bash, deny secret file reads, warn on network",
    config: {
      defaultPolicy: "allow",
      enforce: true,
      rules: SAFETY_RULES,
    },
  },
  strict: {
    name: "strict",
    description: "Deny everything except Read, Glob, Grep, and TodoWrite",
    config: {
      defaultPolicy: "deny",
      enforce: true,
      rules: [
        {
          id: "allow-read-tools",
          name: "Allow read-only tools",
          priority: 1,
          decision: "allow",
          reason: "Read-only tool permitted by strict preset",
          match: {
            tools: ["Read", "Glob", "Grep", "TodoWrite"],
          },
        },
      ],
    },
  },
  "audit-only": {
    name: "audit-only",
    description: "Same rules as safety but enforce=false (dry-run, logs what would be blocked)",
    config: {
      defaultPolicy: "allow",
      enforce: false,
      rules: SAFETY_RULES,
    },
  },
};

/** Get a preset by name, or undefined if not found. */
export function getPreset(name: string): PresetDefinition | undefined {
  return PRESETS[name as PresetName];
}

/** List all available preset names. */
export function listPresets(): PresetDefinition[] {
  return Object.values(PRESETS);
}

/** All valid preset names. */
export function isPresetName(name: string): name is PresetName {
  return name in PRESETS;
}

/**
 * Resolve a policy config from preset + overrides.
 *
 * Merge order:
 *   1. Preset defaults (defaultPolicy, enforce, rules)
 *   2. Top-level overrides (defaultPolicy, enforce) from user config
 *   3. Additional rules from user config are appended after preset rules
 */
export function resolvePreset(
  presetName: string,
  overrides?: Partial<PolicyConfig>,
): PolicyConfig {
  const preset = getPreset(presetName);
  if (!preset) {
    throw new Error(`Unknown policy preset: "${presetName}". Available: ${Object.keys(PRESETS).join(", ")}`);
  }

  const base = { ...preset.config };

  if (overrides) {
    if (overrides.defaultPolicy !== undefined) {
      base.defaultPolicy = overrides.defaultPolicy;
    }
    if (overrides.enforce !== undefined) {
      base.enforce = overrides.enforce;
    }
    if (overrides.rules && overrides.rules.length > 0) {
      base.rules = [...base.rules, ...overrides.rules];
    }
  }

  return base;
}
