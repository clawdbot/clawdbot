import { z } from "zod";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

// zod@4 ships "sideEffects": false, so bundlers tree-shake the classic entry's
// implicit config(en()) locale registration (zod/v4/classic/external.js) and a
// built dist renders every issue as the bare "Invalid input" fallback. Register
// the locale explicitly where the config schemas live; zod stores it on
// globalThis, so one call covers every zod parse in the process.
function installZodDefaultLocale(): void {
  z.config(z.locales.en());
}
installZodDefaultLocale();

export const OpenClawSchema = z.strictObject(OpenClawSchemaShape).superRefine((cfg, ctx) => {
  const agents = listAgentEntries(cfg as OpenClawConfig);
  const agentIds = new Set(agents.map((agent) => agent.id));
  const effectiveAgentIds = new Set(agents.map((agent) => normalizeAgentId(agent.id)));
  if (agents.length === 0) {
    effectiveAgentIds.add("main");
  }

  const explicitTargets = [
    {
      path: ["agents", "defaults", "heartbeat", "agentId"],
      agentId: cfg.agents?.defaults?.heartbeat?.agentId,
    },
    {
      path: ["agents", "defaults", "systemAgent", "agentId"],
      agentId: cfg.agents?.defaults?.systemAgent?.agentId,
    },
    { path: ["talk", "agentId"], agentId: cfg.talk?.agentId },
  ] as const;
  for (const target of explicitTargets) {
    if (
      typeof target.agentId === "string" &&
      !effectiveAgentIds.has(normalizeAgentId(target.agentId))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...target.path],
        message: `Unknown agent id "${target.agentId}" (not in agents.entries).`,
      });
    }
  }

  if (agents.length === 0) {
    return;
  }

  // Bindings referencing a missing agent id silently misroute at gateway
  // load time. Match routing's normalized id semantics; otherwise valid
  // configured routes like "Team Ops" -> "team-ops" would fail at load.
  const bindings = cfg.bindings;
  if (Array.isArray(bindings)) {
    for (let idx = 0; idx < bindings.length; idx += 1) {
      const binding = bindings[idx];
      if (!binding || typeof binding !== "object") {
        continue;
      }
      const agentId = (binding as { agentId?: unknown }).agentId;
      if (
        typeof agentId === "string" &&
        agentId !== DEFAULT_AGENT_ID &&
        !effectiveAgentIds.has(normalizeAgentId(agentId))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bindings", idx, "agentId"],
          message: `Unknown agent id "${agentId}" (not in agents.entries).`,
        });
      }
    }
  }

  const broadcast = cfg.broadcast;
  if (!broadcast) {
    return;
  }

  for (const [peerId, ids] of Object.entries(broadcast)) {
    if (peerId === "strategy") {
      continue;
    }
    if (!Array.isArray(ids)) {
      continue;
    }
    for (const [idx, agentId] of ids.entries()) {
      if (!agentIds.has(agentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["broadcast", peerId, idx],
          message: `Unknown agent id "${agentId}" (not in agents.entries).`,
        });
      }
    }
  }
});
