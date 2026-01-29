/**
 * Web4 Governance Plugin for Moltbot
 *
 * Adds R6 workflow formalism, audit trails, and session identity
 * to moltbot agent sessions. Uses internal hooks for session lifecycle
 * and typed after_tool_call hooks for tool-level audit.
 */

import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createSoftLCT } from "./src/soft-lct.js";
import { createR6Request, hashOutput, classifyTool, extractTarget } from "./src/r6.js";
import { AuditChain } from "./src/audit.js";
import { SessionStore, type SessionState } from "./src/session-state.js";
import { PolicyEngine } from "./src/policy.js";
import type { PolicyConfig, PolicyEvaluation } from "./src/policy-types.js";
import { RateLimiter } from "./src/rate-limiter.js";
import { resolvePreset, listPresets, isPresetName } from "./src/presets.js";
import { AuditReporter } from "./src/reporter.js";
import { PolicyRegistry, type PolicyEntityId } from "./src/policy-entity.js";

type PluginConfig = {
  auditLevel?: string;
  showR6Status?: boolean;
  storagePath?: string;
  policy?: Partial<PolicyConfig> & { preset?: string };
};

const plugin = {
  id: "web4-governance",
  name: "Web4 Governance",
  description: "R6 workflow formalism, audit trails, and trust-native session identity",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      auditLevel: { type: "string", enum: ["minimal", "standard", "verbose"], default: "standard" },
      showR6Status: { type: "boolean", default: true },
      storagePath: { type: "string" },
    },
  },

  register(api: MoltbotPluginApi) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const storagePath = config.storagePath ?? join(homedir(), ".moltbot", "extensions", "web4-governance");
    const auditLevel = config.auditLevel ?? "standard";
    const logger = api.logger;

    // Per-session state (keyed by sessionKey)
    const sessions = new Map<string, { state: SessionState; audit: AuditChain }>();
    const sessionStore = new SessionStore(storagePath);

    // Rate limiter (memory-only, shared across all sessions)
    const rateLimiter = new RateLimiter();

    // Policy entity registry (policies as first-class trust participants)
    const policyRegistry = new PolicyRegistry();

    // Resolve policy config: preset → merge with overrides
    let resolvedPolicyConfig: Partial<PolicyConfig> = {};
    if (config.policy) {
      const { preset, ...overrides } = config.policy;
      if (preset && isPresetName(preset)) {
        resolvedPolicyConfig = resolvePreset(preset, overrides);
        logger.info(`[web4] Policy preset "${preset}" loaded`);
      } else if (preset) {
        logger.warn(`[web4] Unknown policy preset "${preset}", using inline config`);
        resolvedPolicyConfig = overrides;
      } else {
        resolvedPolicyConfig = overrides;
      }
    }

    // Policy engine with rate limiter
    const policyEngine = new PolicyEngine(resolvedPolicyConfig, rateLimiter);
    if (policyEngine.ruleCount > 0) {
      logger.info(
        `[web4] Policy engine: ${policyEngine.ruleCount} rules, enforce=${policyEngine.isEnforcing}`,
      );
    }

    // Stash for passing policy evaluations from before_tool_call to after_tool_call
    const policyStash = new Map<string, PolicyEvaluation>();

    function getOrCreateSession(sessionKey: string): { state: SessionState; audit: AuditChain } {
      let entry = sessions.get(sessionKey);
      if (!entry) {
        const sessionId = sessionKey || randomUUID();
        const lct = createSoftLCT(sessionId);

        // Register policy entity (policy as first-class trust participant)
        let policyEntityId: PolicyEntityId | undefined;
        const presetName = config.policy?.preset ?? "safety";
        if (isPresetName(presetName)) {
          const policyEntity = policyRegistry.registerPolicy({
            name: presetName,
            preset: presetName,
          });
          policyEntityId = policyEntity.entityId;
          // Session witnesses operating under this policy
          policyRegistry.witnessSession(policyEntity.entityId, sessionId);
        }

        const state: SessionState = {
          sessionId,
          lct,
          actionIndex: 0,
          startedAt: new Date().toISOString(),
          toolCounts: {},
          categoryCounts: {},
          policyEntityId,
        };
        const audit = new AuditChain(storagePath, sessionId);
        sessionStore.save(state);
        entry = { state, audit };
        sessions.set(sessionKey, entry);
        const policyInfo = policyEntityId ? ` [policy:${presetName}]` : "";
        logger.info(`[web4] Session ${lct.tokenId} initialized (${auditLevel} audit)${policyInfo}`);
      }
      return entry;
    }

    // --- Internal Hooks (these actually fire in current moltbot) ---

    // Hook into agent bootstrap - fires when agent session starts
    api.registerHook(["agent", "agent:bootstrap"], async (event) => {
      const sessionKey = event.sessionKey || "default";
      const entry = getOrCreateSession(sessionKey);
      logger.info(`[web4] Governance active: ${entry.state.lct.tokenId} (session: ${sessionKey})`);
    }, { name: "web4-agent-bootstrap", description: "Initialize Web4 governance session on agent bootstrap" });

    // Hook into session events
    api.registerHook(["session"], async (event) => {
      const sessionKey = event.sessionKey || "default";
      if (event.action === "new" || event.action === "start") {
        const entry = getOrCreateSession(sessionKey);
        logger.info(`[web4] Session ${event.action}: ${entry.state.lct.tokenId}`);
      } else if (event.action === "end" || event.action === "stop" || event.action === "reset") {
        const entry = sessions.get(sessionKey);
        if (entry) {
          const verification = entry.audit.verify();
          logger.info(
            `[web4] Session ${event.action}: ${entry.state.actionIndex} actions, ` +
              `chain ${verification.valid ? "VALID" : "INVALID"} (${verification.recordCount} records)`,
          );
          sessionStore.save(entry.state);
          sessions.delete(sessionKey);
        }
      }
    }, { name: "web4-session-lifecycle", description: "Track Web4 session lifecycle events" });

    // Hook into command events - captures all agent commands
    api.registerHook(["command"], async (event) => {
      const sessionKey = event.sessionKey || "default";
      const entry = getOrCreateSession(sessionKey);
      const { state } = entry;

      // Create R6 request for the command
      const toolName = String(event.context.command ?? event.action ?? "unknown");
      const params = (event.context ?? {}) as Record<string, unknown>;

      const r6 = createR6Request(
        state.sessionId,
        undefined,
        toolName,
        params,
        state.actionIndex,
        state.lastR6Id,
        auditLevel,
        state.policyEntityId,
      );

      // Record in audit chain with success (commands that reach hooks succeeded)
      const result = {
        status: "success" as const,
        outputHash: hashOutput(event.context),
      };
      r6.result = result;
      entry.audit.record(r6, result);

      // Update session state
      const category = classifyTool(toolName);
      sessionStore.incrementAction(state, toolName, category, r6.id);

      if (auditLevel === "verbose") {
        logger.info(`[web4] R6 ${r6.id}: ${toolName} [${category}] → ${r6.request.target ?? "(no target)"}`);
      }
    }, { name: "web4-command-audit", description: "Record R6 audit entries for agent commands" });

    // --- Typed Tool Hooks (wired via pi-tools.hooks.ts) ---

    // Pre-action policy gating
    api.on("before_tool_call", (event, ctx) => {
      if (policyEngine.ruleCount === 0) return;

      const category = classifyTool(event.toolName);
      const target = extractTarget(event.toolName, event.params);
      const { blocked, evaluation } = policyEngine.shouldBlock(event.toolName, category, target);

      // Stash evaluation for after_tool_call to pick up
      const sid = ctx.sessionKey ?? ctx.agentId ?? "default";
      policyStash.set(sid, evaluation);

      if (evaluation.decision === "warn") {
        logger.warn(
          `[web4] Policy WARN: ${event.toolName} [${category}] → ${target ?? "(no target)"} — ${evaluation.reason}`,
        );
      }

      if (blocked) {
        logger.warn(
          `[web4] Policy DENY: ${event.toolName} [${category}] → ${target ?? "(no target)"} — ${evaluation.reason}`,
        );
        return { block: true, blockReason: `[web4-policy] ${evaluation.reason}` };
      }

      if (evaluation.decision === "deny" && !evaluation.enforced) {
        // Dry-run mode: log but don't block
        logger.warn(
          `[web4] Policy DENY (dry-run): ${event.toolName} [${category}] → ${target ?? "(no target)"} — ${evaluation.reason}`,
        );
      }
    });

    api.on("after_tool_call", (event, ctx) => {
      const sid = ctx.sessionKey ?? ctx.agentId ?? "default";
      const entry = sessions.get(sid);
      if (!entry) return;

      // Pick up stashed policy evaluation from before_tool_call
      const policyEval = policyStash.get(sid);
      policyStash.delete(sid);

      const r6 = createR6Request(
        entry.state.sessionId,
        ctx.agentId,
        event.toolName,
        event.params,
        entry.state.actionIndex,
        entry.state.lastR6Id,
        auditLevel,
        entry.state.policyEntityId,
      );

      // Write policy constraints to R6
      if (policyEval) {
        r6.rules.constraints = policyEval.constraints;
      }

      // Witness policy decision (policy witnesses the outcome)
      if (entry.state.policyEntityId) {
        const decision = policyEval?.decision ?? "allow";
        const success = !event.error;
        policyRegistry.witnessDecision(
          entry.state.policyEntityId as PolicyEntityId,
          entry.state.sessionId,
          event.toolName,
          decision,
          success
        );
      }

      const result = {
        status: (event.error ? "error" : "success") as "success" | "error",
        outputHash: event.result ? hashOutput(event.result) : undefined,
        errorMessage: event.error,
        durationMs: event.durationMs,
      };
      r6.result = result;
      entry.audit.record(r6, result);
      sessionStore.incrementAction(entry.state, event.toolName, classifyTool(event.toolName), r6.id);

      // Record rate limit action after successful tool execution
      if (policyEngine.ruleCount > 0) {
        const category = classifyTool(event.toolName);
        for (const rule of policyEngine.sortedRules) {
          if (rule.match.rateLimit) {
            const key = rule.match.tools?.length
              ? `ratelimit:${rule.id}:tool:${event.toolName}`
              : rule.match.categories?.length
                ? `ratelimit:${rule.id}:category:${category}`
                : `ratelimit:${rule.id}:global`;
            rateLimiter.record(key);
          }
        }
      }

      if (auditLevel === "verbose") {
        logger.info(`[web4] R6 ${r6.id}: ${event.toolName} [${classifyTool(event.toolName)}] (${event.durationMs ?? 0}ms)`);
      }
    });

    // --- CLI Commands ---

    api.registerCli(
      ({ program, logger }) => {
        const audit = program.command("audit").description("Web4 governance audit trail");

        audit
          .command("summary")
          .description("Show session audit summary")
          .action(() => {
            for (const [, entry] of sessions) {
              const v = entry.audit.verify();
              logger.info(`Session: ${entry.state.lct.tokenId}`);
              logger.info(`  Actions: ${entry.state.actionIndex}`);
              logger.info(`  Audit records: ${v.recordCount}`);
              logger.info(`  Chain valid: ${v.valid}`);
              logger.info(`  Tools: ${JSON.stringify(entry.state.toolCounts)}`);
              logger.info(`  Categories: ${JSON.stringify(entry.state.categoryCounts)}`);
            }
            if (sessions.size === 0) {
              logger.info("No active governance sessions.");
            }
          });

        audit
          .command("verify")
          .description("Verify audit chain integrity")
          .argument("[sessionId]", "Session ID to verify")
          .action((sessionId?: string) => {
            if (sessionId) {
              const chain = new AuditChain(storagePath, sessionId);
              const result = chain.verify();
              logger.info(`Chain valid: ${result.valid}`);
              logger.info(`Records: ${result.recordCount}`);
              if (result.errors.length > 0) {
                logger.info("Errors:");
                for (const e of result.errors) logger.info(`  - ${e}`);
              }
            } else {
              for (const [, entry] of sessions) {
                const result = entry.audit.verify();
                logger.info(`${entry.state.sessionId}: ${result.valid ? "VALID" : "INVALID"} (${result.recordCount} records)`);
              }
            }
          });

        audit
          .command("last")
          .description("Show last N audit records")
          .argument("[count]", "Number of records", "10")
          .action((countStr: string) => {
            const count = parseInt(countStr, 10) || 10;
            for (const [, entry] of sessions) {
              const records = entry.audit.getLast(count);
              for (const r of records) {
                logger.info(`${r.timestamp} ${r.tool} → ${r.target ?? "?"} [${r.result.status}]`);
              }
            }
          });

        // --- Audit Query CLI ---
        audit
          .command("query")
          .description("Query and filter audit records")
          .option("--tool <tool>", "Filter by tool name")
          .option("--category <category>", "Filter by category")
          .option("--status <status>", "Filter by status (success|error|blocked)")
          .option("--target <pattern>", "Filter by target (glob pattern)")
          .option("--since <duration>", "Filter by time (ISO date or relative: 1h, 30m, 2d)")
          .option("--limit <n>", "Max results (default 50)")
          .action((opts: Record<string, string>) => {
            let hasResults = false;
            for (const [, entry] of sessions) {
              const results = entry.audit.filter({
                tool: opts.tool,
                category: opts.category,
                status: opts.status as "success" | "error" | "blocked" | undefined,
                targetPattern: opts.target,
                since: opts.since,
                limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
              });

              if (results.length > 0) {
                hasResults = true;
                logger.info(`Session: ${entry.state.sessionId} (${results.length} results)`);
                for (const r of results) {
                  const dur = r.result.durationMs !== undefined ? ` ${r.result.durationMs}ms` : "";
                  const err = r.result.errorMessage ? ` — ${r.result.errorMessage}` : "";
                  logger.info(`  ${r.timestamp} ${r.tool} [${r.category}] → ${r.target ?? "?"} [${r.result.status}]${dur}${err}`);
                }
              }
            }
            if (!hasResults) {
              logger.info("No matching audit records found.");
            }
          });

        // --- Audit Report CLI ---
        audit
          .command("report")
          .description("Generate aggregated audit report")
          .option("--json", "Output as JSON")
          .action((opts: Record<string, boolean>) => {
            const allRecords = [];
            for (const [, entry] of sessions) {
              allRecords.push(...entry.audit.getAll());
            }

            if (allRecords.length === 0) {
              logger.info("No audit records to report on.");
              return;
            }

            const reporter = new AuditReporter(allRecords);
            if (opts.json) {
              logger.info(JSON.stringify(reporter.generate(), null, 2));
            } else {
              logger.info(reporter.formatText());
            }
          });
      },
      { commands: ["audit"] },
    );

    // --- Policy Admin CLI ---

    api.registerCli(
      ({ program, logger }) => {
        const policy = program.command("policy").description("Web4 policy engine administration");

        policy
          .command("status")
          .description("Show policy engine status")
          .action(() => {
            logger.info(`Policy engine:`);
            logger.info(`  Rules:    ${policyEngine.ruleCount}`);
            logger.info(`  Default:  ${policyEngine.defaultDecision}`);
            logger.info(`  Enforce:  ${policyEngine.isEnforcing}`);
            if (config.policy?.preset) {
              logger.info(`  Preset:   ${config.policy.preset}`);
            }
          });

        policy
          .command("rules")
          .description("List all policy rules in evaluation order")
          .action(() => {
            const rules = policyEngine.sortedRules;
            if (rules.length === 0) {
              logger.info("No policy rules configured.");
              return;
            }
            logger.info(`${rules.length} rules (priority order):\n`);
            for (const rule of rules) {
              const match = rule.match;
              const criteria: string[] = [];
              if (match.tools) criteria.push(`tools=[${match.tools.join(", ")}]`);
              if (match.categories) criteria.push(`categories=[${match.categories.join(", ")}]`);
              if (match.targetPatterns) {
                const kind = match.targetPatternsAreRegex ? "regex" : "glob";
                criteria.push(`targets(${kind})=[${match.targetPatterns.join(", ")}]`);
              }
              if (match.rateLimit) {
                criteria.push(`rateLimit(max=${match.rateLimit.maxCount}, window=${match.rateLimit.windowMs}ms)`);
              }
              logger.info(`  [${rule.priority}] ${rule.id} → ${rule.decision}`);
              logger.info(`       ${rule.name}`);
              if (criteria.length > 0) logger.info(`       match: ${criteria.join(" AND ")}`);
              if (rule.reason) logger.info(`       reason: ${rule.reason}`);
              logger.info();
            }
            logger.info(`Default: ${policyEngine.defaultDecision} | Enforce: ${policyEngine.isEnforcing}`);
          });

        policy
          .command("test")
          .description("Dry-run a tool call against the policy engine")
          .argument("<toolName>", "Tool name (e.g. Bash, Read, WebFetch)")
          .argument("[target]", "Target string (e.g. command, file path, URL)")
          .action((toolName: string, target?: string) => {
            const category = classifyTool(toolName);
            const evaluation = policyEngine.evaluate(toolName, category, target);
            logger.info(`Tool:       ${toolName}`);
            logger.info(`Category:   ${category}`);
            logger.info(`Target:     ${target ?? "(none)"}`);
            logger.info(`Decision:   ${evaluation.decision}`);
            logger.info(`Enforced:   ${evaluation.enforced}`);
            logger.info(`Reason:     ${evaluation.reason}`);
            if (evaluation.matchedRule) {
              logger.info(`Rule:       ${evaluation.matchedRule.id} (priority ${evaluation.matchedRule.priority})`);
            }
            logger.info(`Constraints: ${evaluation.constraints.join(", ")}`);
          });

        // --- Policy Presets CLI ---
        policy
          .command("presets")
          .description("List available policy presets")
          .action(() => {
            const presets = listPresets();
            logger.info(`${presets.length} available presets:\n`);
            for (const p of presets) {
              const ruleCount = p.config.rules.length;
              logger.info(`  ${p.name}`);
              logger.info(`    ${p.description}`);
              logger.info(`    default: ${p.config.defaultPolicy} | enforce: ${p.config.enforce} | rules: ${ruleCount}`);
              logger.info();
            }
            logger.info(`Usage: { "policy": { "preset": "<name>" } }`);
          });

        // --- Policy Entity CLI ---
        policy
          .command("entities")
          .description("List registered policy entities (policies as trust participants)")
          .action(() => {
            const entities = policyRegistry.listPolicies();
            if (entities.length === 0) {
              logger.info("No policy entities registered.");
              return;
            }
            logger.info(`${entities.length} policy entities:\n`);
            for (const e of entities) {
              logger.info(`  ${e.entityId}`);
              logger.info(`    name: ${e.name} | source: ${e.source}`);
              logger.info(`    hash: ${e.contentHash}`);
              logger.info(`    created: ${e.createdAt}`);
              const witnessedBy = policyRegistry.getWitnessedBy(e.entityId);
              const hasWitnessed = policyRegistry.getHasWitnessed(e.entityId);
              logger.info(`    witnessed by: ${witnessedBy.length} | has witnessed: ${hasWitnessed.length}`);
              logger.info();
            }
          });
      },
      { commands: ["policy"] },
    );

    logger.info(`[web4] Web4 Governance plugin loaded (audit: ${auditLevel})`);
  },
};

export default plugin;
