// Checks config help text quality and coverage.

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { FIELD_HELP } from "./schema.help.js";
import {
  CHANNELS_AGENTS_TARGET_KEYS,
  ENUM_EXPECTATIONS,
  FINAL_BACKLOG_TARGET_KEYS,
  ROOT_SECTIONS,
  TARGET_KEYS,
  TOOLS_HOOKS_TARGET_KEYS,
} from "./schema.help.quality.test-fixtures.js";
import { FIELD_LABELS } from "./schema.labels.js";

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

  it("explains memory citations mode semantics", () => {
    const help = expectDefined(
      FIELD_HELP["memory.citations"],
      'FIELD_HELP["memory.citations"] test invariant',
    );
    expect(help.includes('"auto"')).toBe(true);
    expect(help.includes('"on"')).toBe(true);
    expect(help.includes('"off"')).toBe(true);
    expect(/always|always shows/i.test(help)).toBe(true);
    expect(/hides|hide/i.test(help)).toBe(true);
  });

  it("includes concrete examples on path and interval fields", () => {
    expect(
      expectDefined(
        FIELD_HELP["memory.qmd.paths.pattern"],
        'FIELD_HELP["memory.qmd.paths.pattern"] test invariant',
      ).includes("**/*.md"),
    ).toBe(true);
    expect(
      expectDefined(
        FIELD_HELP["memory.qmd.update.interval"],
        'FIELD_HELP["memory.qmd.update.interval"] test invariant',
      ).includes("5m"),
    ).toBe(true);
    expect(
      expectDefined(
        FIELD_HELP["memory.qmd.update.embedInterval"],
        'FIELD_HELP["memory.qmd.update.embedInterval"] test invariant',
      ).includes("60m"),
    ).toBe(true);
  });

  it("documents cron deprecation, migration, and retention formats", () => {
    const legacy = expectDefined(
      FIELD_HELP["cron.webhook"],
      'FIELD_HELP["cron.webhook"] test invariant',
    );
    expect(/deprecated|legacy/i.test(legacy)).toBe(true);
    expect(legacy.includes('delivery.mode="webhook"')).toBe(true);
    expect(legacy.includes("delivery.to")).toBe(true);

    const retention = expectDefined(
      FIELD_HELP["cron.sessionRetention"],
      'FIELD_HELP["cron.sessionRetention"] test invariant',
    );
    expect(retention.includes("24h")).toBe(true);
    expect(retention.includes("7d")).toBe(true);
    expect(retention.includes("1h30m")).toBe(true);
    expect(/false/i.test(retention)).toBe(true);

    const token = expectDefined(
      FIELD_HELP["cron.webhookToken"],
      'FIELD_HELP["cron.webhookToken"] test invariant',
    );
    expect(/token|bearer/i.test(token)).toBe(true);
    expect(/secret|env|rotate/i.test(token)).toBe(true);
  });

  it("documents session send-policy examples and prefix semantics", () => {
    const rules = expectDefined(
      FIELD_HELP["session.sendPolicy.rules"],
      'FIELD_HELP["session.sendPolicy.rules"] test invariant',
    );
    expect(rules.includes("{ action:")).toBe(true);
    expect(rules.includes('"deny"')).toBe(true);
    expect(rules.includes('"discord"')).toBe(true);

    const keyPrefix = expectDefined(
      FIELD_HELP["session.sendPolicy.rules[].match.keyPrefix"],
      'FIELD_HELP["session.sendPolicy.rules[].match.keyPrefix"] test invariant',
    );
    expect(/normalized/i.test(keyPrefix)).toBe(true);

    const rawKeyPrefix = expectDefined(
      FIELD_HELP["session.sendPolicy.rules[].match.rawKeyPrefix"],
      'FIELD_HELP["session.sendPolicy.rules[].match.rawKeyPrefix"] test invariant',
    );
    expect(/raw|unnormalized/i.test(rawKeyPrefix)).toBe(true);
  });

  it("documents session write-lock policy defaults", () => {
    const acquireTimeout = expectDefined(
      FIELD_HELP["session.writeLock.acquireTimeoutMs"],
      'FIELD_HELP["session.writeLock.acquireTimeoutMs"] test invariant',
    );
    expect(acquireTimeout.includes("60000")).toBe(true);
    expect(/transcript|lock/i.test(acquireTimeout)).toBe(true);

    const stale = expectDefined(
      FIELD_HELP["session.writeLock.staleMs"],
      'FIELD_HELP["session.writeLock.staleMs"] test invariant',
    );
    expect(stale.includes("1800000")).toBe(true);
    expect(stale.includes("OPENCLAW_SESSION_WRITE_LOCK_STALE_MS")).toBe(true);

    const maxHold = expectDefined(
      FIELD_HELP["session.writeLock.maxHoldMs"],
      'FIELD_HELP["session.writeLock.maxHoldMs"] test invariant',
    );
    expect(maxHold.includes("300000")).toBe(true);
    expect(maxHold.includes("OPENCLAW_SESSION_WRITE_LOCK_MAX_HOLD_MS")).toBe(true);
  });

  it("documents session maintenance duration/size examples and deprecations", () => {
    const pruneAfter = expectDefined(
      FIELD_HELP["session.maintenance.pruneAfter"],
      'FIELD_HELP["session.maintenance.pruneAfter"] test invariant',
    );
    expect(pruneAfter.includes("30d")).toBe(true);
    expect(pruneAfter.includes("12h")).toBe(true);

    const deprecated = expectDefined(
      FIELD_HELP["session.maintenance.pruneDays"],
      'FIELD_HELP["session.maintenance.pruneDays"] test invariant',
    );
    expect(/deprecated/i.test(deprecated)).toBe(true);
    expect(deprecated.includes("session.maintenance.pruneAfter")).toBe(true);

    const resetRetention = expectDefined(
      FIELD_HELP["session.maintenance.resetArchiveRetention"],
      'FIELD_HELP["session.maintenance.resetArchiveRetention"] test invariant',
    );
    expect(resetRetention.includes(".reset.")).toBe(true);
    expect(/false/i.test(resetRetention)).toBe(true);

    const maxDisk = expectDefined(
      FIELD_HELP["session.maintenance.maxDiskBytes"],
      'FIELD_HELP["session.maintenance.maxDiskBytes"] test invariant',
    );
    expect(maxDisk.includes("500mb")).toBe(true);

    const highWater = expectDefined(
      FIELD_HELP["session.maintenance.highWaterBytes"],
      'FIELD_HELP["session.maintenance.highWaterBytes"] test invariant',
    );
    expect(highWater.includes("80%")).toBe(true);
  });

  it("documents approvals filters and target semantics", () => {
    const sessionFilter = expectDefined(
      FIELD_HELP["approvals.exec.sessionFilter"],
      'FIELD_HELP["approvals.exec.sessionFilter"] test invariant',
    );
    expect(/substring|regex/i.test(sessionFilter)).toBe(true);
    expect(sessionFilter.includes("discord:")).toBe(true);
    expect(sessionFilter.includes("^agent:ops:")).toBe(true);

    const agentFilter = expectDefined(
      FIELD_HELP["approvals.exec.agentFilter"],
      'FIELD_HELP["approvals.exec.agentFilter"] test invariant',
    );
    expect(agentFilter.includes("primary")).toBe(true);
    expect(agentFilter.includes("ops-agent")).toBe(true);

    const targetTo = expectDefined(
      FIELD_HELP["approvals.exec.targets[].to"],
      'FIELD_HELP["approvals.exec.targets[].to"] test invariant',
    );
    expect(/channel ID|user ID|thread root/i.test(targetTo)).toBe(true);
    expect(/differs|per provider/i.test(targetTo)).toBe(true);
  });

  it("documents broadcast command examples", () => {
    const broadcastMap = expectDefined(
      FIELD_HELP["broadcast.*"],
      'FIELD_HELP["broadcast.*"] test invariant',
    );
    expect(/source peer ID/i.test(broadcastMap)).toBe(true);
    expect(/destination peer IDs/i.test(broadcastMap)).toBe(true);
  });

  it("documents hook transform safety and queue behavior options", () => {
    const transformModule = expectDefined(
      FIELD_HELP["hooks.mappings[].transform.module"],
      'FIELD_HELP["hooks.mappings[].transform.module"] test invariant',
    );
    expect(/relative/i.test(transformModule)).toBe(true);
    expect(/path traversal|reviewed|controlled/i.test(transformModule)).toBe(true);

    const queueMode = expectDefined(
      FIELD_HELP["messages.queue.mode"],
      'FIELD_HELP["messages.queue.mode"] test invariant',
    );
    expect(queueMode.includes('"interrupt"')).toBe(true);
    expect(queueMode.includes('"steer"')).toBe(true);
  });

  it("documents gateway bind modes and web reconnect semantics", () => {
    const bind = expectDefined(
      FIELD_HELP["gateway.bind"],
      'FIELD_HELP["gateway.bind"] test invariant',
    );
    expect(bind.includes('"loopback"')).toBe(true);
    expect(bind.includes('"tailnet"')).toBe(true);

    const reconnect = expectDefined(
      FIELD_HELP["web.reconnect.maxAttempts"],
      'FIELD_HELP["web.reconnect.maxAttempts"] test invariant',
    );
    expect(/0 means no retries|no retries/i.test(reconnect)).toBe(true);
    expect(/failure sequence|retry/i.test(reconnect)).toBe(true);
  });

  it("documents metadata/admin semantics for logging, wizard, and plugins", () => {
    const wizardMode = expectDefined(
      FIELD_HELP["wizard.lastRunMode"],
      'FIELD_HELP["wizard.lastRunMode"] test invariant',
    );
    expect(wizardMode.includes('"local"')).toBe(true);
    expect(wizardMode.includes('"remote"')).toBe(true);

    const consoleStyle = expectDefined(
      FIELD_HELP["logging.consoleStyle"],
      'FIELD_HELP["logging.consoleStyle"] test invariant',
    );
    expect(consoleStyle.includes('"pretty"')).toBe(true);
    expect(consoleStyle.includes('"compact"')).toBe(true);
    expect(consoleStyle.includes('"json"')).toBe(true);

    const pluginApiKey = expectDefined(
      FIELD_HELP["plugins.entries.*.apiKey"],
      'FIELD_HELP["plugins.entries.*.apiKey"] test invariant',
    );
    expect(/secret|env|credential/i.test(pluginApiKey)).toBe(true);

    const pluginEnv = expectDefined(
      FIELD_HELP["plugins.entries.*.env"],
      'FIELD_HELP["plugins.entries.*.env"] test invariant',
    );
    expect(/scope|plugin|environment/i.test(pluginEnv)).toBe(true);

    const pluginPromptPolicy = expectDefined(
      FIELD_HELP["plugins.entries.*.hooks.allowPromptInjection"],
      'FIELD_HELP["plugins.entries.*.hooks.allowPromptInjection"] test invariant',
    );
    expect(pluginPromptPolicy.includes("before_prompt_build")).toBe(true);
    expect(pluginPromptPolicy.includes("before_agent_start")).toBe(true);
    expect(pluginPromptPolicy.includes("modelOverride")).toBe(true);

    const pluginConversationPolicy = expectDefined(
      FIELD_HELP["plugins.entries.*.hooks.allowConversationAccess"],
      'FIELD_HELP["plugins.entries.*.hooks.allowConversationAccess"] test invariant',
    );
    expect(pluginConversationPolicy.includes("llm_input")).toBe(true);
    expect(pluginConversationPolicy.includes("llm_output")).toBe(true);
    expect(pluginConversationPolicy.includes("before_agent_finalize")).toBe(true);

    const pluginHookTimeout = expectDefined(
      FIELD_HELP["plugins.entries.*.hooks.timeoutMs"],
      'FIELD_HELP["plugins.entries.*.hooks.timeoutMs"] test invariant',
    );
    expect(pluginHookTimeout.includes("typed hooks")).toBe(true);
    expect(pluginHookTimeout.includes("hooks.timeouts")).toBe(true);

    const pluginHookTimeouts = expectDefined(
      FIELD_HELP["plugins.entries.*.hooks.timeouts"],
      'FIELD_HELP["plugins.entries.*.hooks.timeouts"] test invariant',
    );
    expect(pluginHookTimeouts.includes("before_prompt_build")).toBe(true);
    expect(pluginHookTimeouts.includes("agent_end")).toBe(true);
    expect(pluginConversationPolicy.includes("agent_end")).toBe(true);
  });

  it("documents auth/model root semantics and provider secret handling", () => {
    const providerKey = expectDefined(
      FIELD_HELP["models.providers.*.apiKey"],
      'FIELD_HELP["models.providers.*.apiKey"] test invariant',
    );
    expect(/secret|env|credential/i.test(providerKey)).toBe(true);
    const modelsMode = expectDefined(
      FIELD_HELP["models.mode"],
      'FIELD_HELP["models.mode"] test invariant',
    );
    expect(modelsMode.includes("SecretRef-managed")).toBe(true);
    expect(modelsMode.includes("preserve")).toBe(true);

    const authCooldowns = expectDefined(
      FIELD_HELP["auth.cooldowns"],
      'FIELD_HELP["auth.cooldowns"] test invariant',
    );
    expect(/cooldown|backoff|retry/i.test(authCooldowns)).toBe(true);
  });

  it("documents agent compaction safeguards and memory flush behavior", () => {
    const mode = expectDefined(
      FIELD_HELP["agents.defaults.compaction.mode"],
      'FIELD_HELP["agents.defaults.compaction.mode"] test invariant',
    );
    expect(mode.includes('"default"')).toBe(true);
    expect(mode.includes('"safeguard"')).toBe(true);

    const thinkingLevel = expectDefined(
      FIELD_HELP["agents.defaults.compaction.thinkingLevel"],
      'FIELD_HELP["agents.defaults.compaction.thinkingLevel"] test invariant',
    );
    expect(/session level|inherit/i.test(thinkingLevel)).toBe(true);
    expect(/Codex app-server|no per-operation thinking override/i.test(thinkingLevel)).toBe(true);

    const historyShare = expectDefined(
      FIELD_HELP["agents.defaults.compaction.maxHistoryShare"],
      'FIELD_HELP["agents.defaults.compaction.maxHistoryShare"] test invariant',
    );
    expect(/0\\.1-0\\.9|fraction|share/i.test(historyShare)).toBe(true);

    const identifierPolicy = expectDefined(
      FIELD_HELP["agents.defaults.compaction.identifierPolicy"],
      'FIELD_HELP["agents.defaults.compaction.identifierPolicy"] test invariant',
    );
    expect(identifierPolicy.includes('"strict"')).toBe(true);
    expect(identifierPolicy.includes('"off"')).toBe(true);
    expect(identifierPolicy.includes('"custom"')).toBe(true);

    const recentTurnsPreserve = expectDefined(
      FIELD_HELP["agents.defaults.compaction.recentTurnsPreserve"],
      'FIELD_HELP["agents.defaults.compaction.recentTurnsPreserve"] test invariant',
    );
    expect(/recent.*turn|verbatim/i.test(recentTurnsPreserve)).toBe(true);
    expect(/default:\s*3/i.test(recentTurnsPreserve)).toBe(true);

    const midTurnPrecheck = expectDefined(
      FIELD_HELP["agents.defaults.compaction.midTurnPrecheck.enabled"],
      'FIELD_HELP["agents.defaults.compaction.midTurnPrecheck.enabled"] test invariant',
    );
    expect(/mid-turn|tool loop|default:\s*false/i.test(midTurnPrecheck)).toBe(true);

    const postCompactionSections = expectDefined(
      FIELD_HELP["agents.defaults.compaction.postCompactionSections"],
      'FIELD_HELP["agents.defaults.compaction.postCompactionSections"] test invariant',
    );
    expect(/opt-in|Leave unset/i.test(postCompactionSections)).toBe(true);
    expect(/Session Startup|Red Lines/i.test(postCompactionSections)).toBe(true);
    expect(/Every Session|Safety/i.test(postCompactionSections)).toBe(true);
    expect(/\[\]|disable/i.test(postCompactionSections)).toBe(true);
    expect(/duplicate project context/i.test(postCompactionSections)).toBe(true);

    const compactionModel = expectDefined(
      FIELD_HELP["agents.defaults.compaction.model"],
      'FIELD_HELP["agents.defaults.compaction.model"] test invariant',
    );
    expect(/provider\/model|different model|primary agent model/i.test(compactionModel)).toBe(true);
    expect(/alias/i.test(compactionModel)).toBe(true);

    const transcriptBytes = expectDefined(
      FIELD_HELP["agents.defaults.compaction.maxActiveTranscriptBytes"],
      'FIELD_HELP["agents.defaults.compaction.maxActiveTranscriptBytes"] test invariant',
    );
    expect(/transcript|bytes|compaction/i.test(transcriptBytes)).toBe(true);
    expect(/never splits raw transcript bytes/i.test(transcriptBytes)).toBe(true);

    const flush = expectDefined(
      FIELD_HELP["agents.defaults.compaction.memoryFlush.enabled"],
      'FIELD_HELP["agents.defaults.compaction.memoryFlush.enabled"] test invariant',
    );
    expect(/pre-compaction|memory flush|token/i.test(flush)).toBe(true);
  });

  it("documents agent startup-context preload controls", () => {
    const startupContext = expectDefined(
      FIELD_HELP["agents.defaults.startupContext"],
      'FIELD_HELP["agents.defaults.startupContext"] test invariant',
    );
    expect(/first-turn|\/new|\/reset|daily memory/i.test(startupContext)).toBe(true);

    const applyOn = expectDefined(
      FIELD_HELP["agents.defaults.startupContext.applyOn"],
      'FIELD_HELP["agents.defaults.startupContext.applyOn"] test invariant',
    );
    expect(applyOn.includes('"new"')).toBe(true);
    expect(applyOn.includes('"reset"')).toBe(true);

    const dailyMemoryDays = expectDefined(
      FIELD_HELP["agents.defaults.startupContext.dailyMemoryDays"],
      'FIELD_HELP["agents.defaults.startupContext.dailyMemoryDays"] test invariant',
    );
    expect(/today \+ yesterday|default:\s*2/i.test(dailyMemoryDays)).toBe(true);
  });
});
