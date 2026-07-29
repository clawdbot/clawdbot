// Checks config help text quality and coverage.

import { describe, expect, it } from "vitest";
import { computeBaseConfigSchemaResponse } from "./schema-base.js";
import { FIELD_HELP } from "./schema.help.js";
import {
  CHANNELS_AGENTS_TARGET_KEYS,
  ENUM_EXPECTATIONS,
  FINAL_BACKLOG_TARGET_KEYS,
  ROOT_SECTIONS,
  TARGET_KEYS,
  TOOLS_HOOKS_TARGET_KEYS,
} from "./schema.help.quality.test-fixtures.js";
import { buildBaseHints } from "./schema.hints.js";
import { FIELD_LABELS } from "./schema.labels.js";

type JsonSchemaNode = {
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: JsonSchemaNode | boolean;
  items?: JsonSchemaNode | JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
};

function collectSchemaLeafPaths(
  schema: JsonSchemaNode,
  path = "",
  leaves = new Set<string>(),
  visited = new WeakMap<object, Set<string>>(),
): Set<string> {
  const priorPaths = visited.get(schema);
  if (priorPaths?.has(path)) {
    return leaves;
  }
  if (priorPaths) {
    priorPaths.add(path);
  } else {
    visited.set(schema, new Set([path]));
  }

  let hasChildren = false;
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    hasChildren = true;
    collectSchemaLeafPaths(child, path ? `${path}.${key}` : key, leaves, visited);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    hasChildren = true;
    collectSchemaLeafPaths(schema.additionalProperties, path ? `${path}.*` : "*", leaves, visited);
  }
  const items = Array.isArray(schema.items) ? schema.items : schema.items ? [schema.items] : [];
  for (const item of items) {
    hasChildren = true;
    collectSchemaLeafPaths(item, path ? `${path}.*` : "*", leaves, visited);
  }
  for (const branches of [schema.anyOf, schema.oneOf, schema.allOf]) {
    for (const branch of branches ?? []) {
      hasChildren = true;
      collectSchemaLeafPaths(branch, path, leaves, visited);
    }
  }
  if (path && !hasChildren) {
    leaves.add(path);
  }
  return leaves;
}

function formatMissingTierFailure(paths: readonly string[]): string {
  const stubs = paths.map((path) => `  ${JSON.stringify(path)}: { advanced: true },`).join("\n");
  return [
    `${paths.length} config path(s) have no tier declaration.`,
    "Add common/advanced boundaries in src/config/schema.tiers.ts:",
    "",
    stubs,
    "",
    "New leaves inherit their nearest declared ancestor; use a leaf hint for exceptions.",
  ].join("\n");
}

function titleCaseLabelSegment(segment: string): string {
  return segment
    .replace(/\[\]/g, "")
    .replace(/[*_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function createFieldLabelStub(key: string): string {
  const segments = key.split(".").filter((segment) => segment !== "*");
  const leaf = segments.at(-1) ?? key;
  return titleCaseLabelSegment(leaf) || key;
}

function collectMissingLabelKeys(
  helpKeys: readonly string[],
  labels: Record<string, string>,
): string[] {
  return helpKeys.filter((key) => {
    const label = labels[key];
    return typeof label !== "string" || label.length === 0;
  });
}

function formatMissingLabelFailure(missingKeys: readonly string[]): string {
  const stubs = missingKeys
    .map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(createFieldLabelStub(key))},`)
    .join("\n");
  return [
    `${missingKeys.length} help key(s) missing from FIELD_LABELS.`,
    "Add or adjust these entries in src/config/schema.labels.ts:",
    "",
    stubs,
    "",
    "Review generated labels before committing; they are mechanical starting points.",
  ].join("\n");
}

describe("config help copy quality", () => {
  function requireHelp(key: string): string {
    const help = FIELD_HELP[key];
    if (typeof help !== "string") {
      throw new Error(`missing help for ${key}`);
    }
    return help;
  }

  function requireLabel(key: string): string {
    const label = FIELD_LABELS[key];
    if (typeof label !== "string") {
      throw new Error(`missing label for ${key}`);
    }
    return label;
  }

  function expectOperationalGuidance(
    keys: readonly string[],
    guidancePattern: RegExp,
    minLength = 80,
  ) {
    for (const key of keys) {
      const help = requireHelp(key);
      expect(help.length, `help too short for ${key}`).toBeGreaterThanOrEqual(minLength);
      expect(
        guidancePattern.test(help),
        `help should include operational guidance for ${key}`,
      ).toBe(true);
    }
  }

  it("keeps root section labels and help complete", () => {
    for (const key of ROOT_SECTIONS) {
      expect(requireLabel(key)).not.toHaveLength(0);
      expect(requireHelp(key)).not.toHaveLength(0);
    }
  });

  it("keeps labels in parity for all help keys", () => {
    const missing = collectMissingLabelKeys(Object.keys(FIELD_HELP), FIELD_LABELS);
    if (missing.length > 0) {
      expect.fail(formatMissingLabelFailure(missing));
    }
  });

  it("prints copy-paste-ready label stubs for missing help labels", () => {
    const message = formatMissingLabelFailure([
      "gateway.push",
      "gateway.push.apns.relay.timeoutMs",
    ]);
    expect(message).toContain("2 help key(s) missing from FIELD_LABELS.");
    expect(message).toContain("src/config/schema.labels.ts");
    expect(message).toContain(`  "gateway.push": "Push",`);
    expect(message).toContain(`  "gateway.push.apns.relay.timeoutMs": "Timeout Ms",`);
  });

  it("covers the target confusing fields with non-trivial explanations", () => {
    expectOperationalGuidance(
      TARGET_KEYS,
      /(default|keep|use|enable|disable|controls|selects|sets|defines)/i,
    );
  });

  it("covers tools/hooks help keys with non-trivial operational guidance", () => {
    expectOperationalGuidance(
      TOOLS_HOOKS_TARGET_KEYS,
      /(default|keep|use|enable|disable|controls|set|sets|increase|lower|prefer|tune|avoid|choose|when)/i,
    );
  });

  it("covers channels/agents help keys with non-trivial operational guidance", () => {
    expectOperationalGuidance(
      CHANNELS_AGENTS_TARGET_KEYS,
      /(default|keep|use|enable|disable|controls|set|sets|increase|lower|prefer|tune|avoid|choose|when)/i,
    );
  });

  it("covers final backlog help keys with non-trivial operational guidance", () => {
    expectOperationalGuidance(
      FINAL_BACKLOG_TARGET_KEYS,
      /(default|keep|use|enable|disable|controls|set|sets|increase|lower|prefer|tune|avoid|choose|when)/i,
    );
  });

  it("documents option behavior for enum-style fields", () => {
    for (const [key, options] of Object.entries(ENUM_EXPECTATIONS)) {
      const help = requireHelp(key);
      for (const token of options) {
        expect(help.includes(token), `missing option ${token} in ${key}`).toBe(true);
      }
    }
  });

  it.each([
    {
      name: "explains memory citations mode semantics",
      fields: [
        ["memory.citations", ['"auto"', '"on"', '"off"', /always|always shows/i, /hides|hide/i]],
      ],
    },
    {
      name: "includes a concrete example on memory path fields",
      fields: [["memory.qmd.paths.pattern", ["**/*.md"]]],
    },
    {
      name: "documents cron retention formats",
      fields: [
        ["cron.sessionRetention", ["24h", "7d", "1h30m", /false/i]],
        ["cron.webhookToken", [/token|bearer/i, /secret|env|rotate/i]],
      ],
    },
    {
      name: "documents session send-policy examples and prefix semantics",
      fields: [
        ["session.sendPolicy.rules", ["{ action:", '"deny"', '"discord"']],
        ["session.sendPolicy.rules[].match.keyPrefix", [/normalized/i]],
        ["session.sendPolicy.rules[].match.rawKeyPrefix", [/raw|unnormalized/i]],
      ],
    },
    {
      name: "documents session maintenance duration/size examples and deprecations",
      fields: [
        ["session.maintenance.pruneAfter", ["30d", "12h"]],
        ["session.maintenance.resetArchiveRetention", [".reset.", /false/i]],
        ["session.maintenance.maxDiskBytes", ["500mb"]],
        ["session.maintenance.highWaterBytes", ["80%"]],
      ],
    },
    {
      name: "documents approvals filters and target semantics",
      fields: [
        ["approvals.exec.sessionFilter", [/substring|regex/i, "discord:", "^agent:ops:"]],
        ["approvals.exec.agentFilter", ["primary", "ops-agent"]],
        [
          "approvals.exec.targets[].to",
          [/channel ID|user ID|thread root/i, /differs|per provider/i],
        ],
      ],
    },
    {
      name: "documents broadcast command examples",
      fields: [["broadcast.*", [/source peer ID/i, /destination peer IDs/i]]],
    },
    {
      name: "documents hook transform safety and queue behavior options",
      fields: [
        ["hooks.mappings[].transform.module", [/relative/i, /path traversal|reviewed|controlled/i]],
        ["messages.queue.mode", ['"interrupt"', '"steer"']],
      ],
    },
    {
      name: "documents gateway bind modes",
      fields: [["gateway.bind", ['"loopback"', '"tailnet"']]],
    },
    {
      name: "documents admin semantics for logging and plugins",
      fields: [
        ["logging.consoleStyle", ['"pretty"', '"json"']],
        ["plugins.entries.*.apiKey", [/secret|env|credential/i]],
        ["plugins.entries.*.env", [/scope|plugin|environment/i]],
        ["plugins.entries.*.hooks.allowPromptInjection", ["before_prompt_build"]],
        [
          "plugins.entries.*.hooks.allowConversationAccess",
          ["llm_input", "llm_output", "before_agent_finalize", "agent_end"],
        ],
        ["plugins.entries.*.hooks.timeoutMs", ["typed hooks", "hooks.timeouts"]],
        ["plugins.entries.*.hooks.timeouts", ["before_prompt_build", "agent_end"]],
      ],
    },
    {
      name: "documents auth/model root semantics and provider secret handling",
      fields: [
        ["models.providers.*.apiKey", [/secret|env|credential/i]],
        ["models.mode", ["SecretRef-managed", "preserve"]],
      ],
    },
    {
      name: "documents agent compaction safeguards and memory flush behavior",
      fields: [
        ["agents.defaults.compaction.mode", ['"default"', '"safeguard"']],
        [
          "agents.defaults.compaction.thinkingLevel",
          [/session level|inherit/i, /Codex app-server|no per-operation thinking override/i],
        ],
        ["agents.defaults.compaction.identifierPolicy", ['"strict"', '"off"']],
        [
          "agents.defaults.compaction.recentTurnsPreserve",
          [/recent.*turn|verbatim/i, /default:\s*3/i],
        ],
        [
          "agents.defaults.compaction.midTurnPrecheck.enabled",
          [/mid-turn|tool loop|default:\s*false/i],
        ],
        [
          "agents.defaults.compaction.model",
          [/provider\/model|different model|primary agent model/i, /alias/i],
        ],
        [
          "agents.defaults.compaction.maxActiveTranscriptBytes",
          [/transcript|bytes|compaction/i, /Codex app-server|native rollout|restart fresh/i],
        ],
        ["agents.defaults.compaction.memoryFlush.enabled", [/pre-compaction|memory flush|token/i]],
      ],
    },
    {
      name: "documents agent startup-context preload controls",
      fields: [
        ["agents.defaults.startupContext", [/first-turn|\/new|\/reset|daily memory/i]],
        ["agents.defaults.startupContext.applyOn", ['"new"', '"reset"']],
        ["agents.defaults.startupContext.dailyMemoryDays", [/today \+ yesterday|default:\s*2/i]],
      ],
    },
  ] satisfies Array<{ name: string; fields: Array<[string, Array<string | RegExp>]> }>)(
    "$name",
    ({ fields }) => {
      for (const [key, patterns] of fields) {
        const help = requireHelp(key);
        for (const pattern of patterns) {
          const matches = typeof pattern === "string" ? help.includes(pattern) : pattern.test(help);
          expect(matches, `missing ${String(pattern)} in ${key}`).toBe(true);
        }
      }
    },
  );
});

describe("config tier coverage", () => {
  const response = computeBaseConfigSchemaResponse({ generatedAt: "tier-quality-test" });
  const schema = response.schema as JsonSchemaNode;
  const leaves = [...collectSchemaLeafPaths(schema)].toSorted();

  it("requires every root section to declare a tier boundary", () => {
    const authoredHints = buildBaseHints();
    const missing = Object.keys(schema.properties ?? {})
      .filter((path) => typeof authoredHints[path]?.advanced !== "boolean")
      .toSorted();
    expect(missing, formatMissingTierFailure(missing)).toEqual([]);
  });

  it("materializes a deterministic tier on every baseline leaf", () => {
    const missing = leaves.filter((path) => typeof response.uiHints[path]?.advanced !== "boolean");
    expect(missing, formatMissingTierFailure(missing)).toEqual([]);
  });

  it("keeps the curated common leaf set reviewable", () => {
    const common = leaves.filter((path) => response.uiHints[path]?.advanced === false);
    expect(common).toMatchSnapshot();
  });
});
