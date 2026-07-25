// Policy plugin exec approval evidence.
import {
  isRecord,
  asBoolean as readBoolean,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { ocPathSegment } from "./policy-state-helpers.js";
import type { PolicyExecApprovalEvidence } from "./policy-state-types.js";

const DEFAULT_EXEC_APPROVAL_AGENT_ID = "main";

export function scanPolicyExecApprovals(raw: string): readonly PolicyExecApprovalEvidence[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    return [];
  }
  const evidence: PolicyExecApprovalEvidence[] = [];
  const defaults = isRecord(parsed.defaults) ? parsed.defaults : {};
  evidence.push(
    execApprovalPostureEvidence(
      "defaults",
      "defaults",
      defaults,
      "oc://exec-approvals.json/defaults",
    ),
  );

  for (const agent of normalizedExecApprovalAgents(parsed.agents)) {
    const agentSource = `oc://exec-approvals.json/agents/${ocPathSegment(agent.sourceAgentId)}`;
    evidence.push(
      execApprovalPostureEvidence(
        `agent:${agent.agentId}`,
        "agent",
        agent.value,
        agentSource,
        agent.agentId,
      ),
    );
    for (const [index, entry] of agent.allowlistEntries.entries()) {
      const allowlistSource = `oc://exec-approvals.json/agents/${ocPathSegment(
        entry.sourceAgentId,
      )}/allowlist/#${entry.index}`;
      evidence.push({
        id: `agent:${agent.agentId}:allowlist:${index}`,
        kind: "allowlist",
        source: allowlistSource,
        agentId: agent.agentId,
        pattern: entry.pattern,
        ...(entry.argPattern === undefined ? {} : { argPattern: entry.argPattern }),
        ...(entry.entrySource === undefined ? {} : { entrySource: entry.entrySource }),
      });
    }
  }
  return evidence;
}

function execApprovalPostureEvidence(
  id: string,
  kind: "agent" | "defaults",
  value: Record<string, unknown>,
  source: string,
  agentId?: string,
): PolicyExecApprovalEvidence {
  const security = readExecApprovalSecurity(value.security);
  const ask = readExecApprovalAsk(value.ask);
  const askFallback = readExecApprovalSecurity(value.askFallback);
  const autoAllowSkills = readBoolean(value.autoAllowSkills);
  return {
    id,
    kind,
    source,
    ...(agentId === undefined ? {} : { agentId }),
    ...(value.security == null ? {} : { securityConfigured: true }),
    ...(security === undefined ? {} : { security }),
    ...(ask === undefined ? {} : { ask }),
    ...(askFallback === undefined ? {} : { askFallback }),
    ...(autoAllowSkills === undefined ? {} : { autoAllowSkills }),
  };
}

function readExecApprovalSecurity(value: unknown): string | undefined {
  const normalized = readString(value);
  return normalized === "deny" || normalized === "allowlist" || normalized === "full"
    ? normalized
    : undefined;
}

function readExecApprovalAsk(value: unknown): string | undefined {
  const normalized = readString(value);
  return normalized === "off" || normalized === "on-miss" || normalized === "always"
    ? normalized
    : undefined;
}

type NormalizedExecApprovalAllowlistEntry = ReturnType<
  typeof execApprovalAllowlistEntries
>[number] & {
  readonly sourceAgentId: string;
};

type NormalizedExecApprovalAgent = {
  readonly agentId: string;
  readonly sourceAgentId: string;
  readonly value: Record<string, unknown>;
  readonly allowlistEntries: readonly NormalizedExecApprovalAllowlistEntry[];
};

function normalizedExecApprovalAgents(rawAgents: unknown): readonly NormalizedExecApprovalAgent[] {
  if (!isRecord(rawAgents)) {
    return [];
  }
  const agents = Object.entries(rawAgents).filter(
    (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
  );
  const legacyDefault = agents.find(([agentId]) => agentId === "default")?.[1];
  const normalized = agents
    .filter(([agentId]) => agentId !== "default")
    .map(([agentId, value]): NormalizedExecApprovalAgent => {
      if (agentId === DEFAULT_EXEC_APPROVAL_AGENT_ID && legacyDefault !== undefined) {
        return {
          agentId,
          sourceAgentId: agentId,
          value: mergeLegacyExecApprovalAgent(value, legacyDefault),
          allowlistEntries: mergedExecApprovalAllowlistEntries(
            value.allowlist,
            legacyDefault.allowlist,
          ),
        };
      }
      return execApprovalAgentFromParts(agentId, agentId, value);
    });
  if (
    legacyDefault !== undefined &&
    !agents.some(([agentId]) => agentId === DEFAULT_EXEC_APPROVAL_AGENT_ID)
  ) {
    normalized.push(
      execApprovalAgentFromParts(DEFAULT_EXEC_APPROVAL_AGENT_ID, "default", legacyDefault),
    );
  }
  return normalized.toSorted((a, b) => a.agentId.localeCompare(b.agentId));
}

function execApprovalAgentFromParts(
  agentId: string,
  sourceAgentId: string,
  value: Record<string, unknown>,
): NormalizedExecApprovalAgent {
  const allowlistEntries = execApprovalAllowlistEntries(value.allowlist).map(
    (entry): NormalizedExecApprovalAllowlistEntry => ({
      index: entry.index,
      pattern: entry.pattern,
      argPattern: entry.argPattern,
      entrySource: entry.entrySource,
      sourceAgentId,
    }),
  );
  return {
    agentId,
    sourceAgentId,
    value,
    allowlistEntries,
  };
}

function mergeLegacyExecApprovalAgent(
  current: Record<string, unknown>,
  legacy: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...legacy,
    ...current,
    security: current.security ?? legacy.security,
    ask: current.ask ?? legacy.ask,
    askFallback: current.askFallback ?? legacy.askFallback,
    autoAllowSkills: current.autoAllowSkills ?? legacy.autoAllowSkills,
    allowlist: mergedExecApprovalAllowlist(current.allowlist, legacy.allowlist),
  };
}

function mergedExecApprovalAllowlist(
  current: unknown,
  legacy: unknown,
): readonly unknown[] | undefined {
  const entries = mergedExecApprovalAllowlistEntries(current, legacy).map((entry) => {
    const allowlistEntry: Record<string, unknown> = { pattern: entry.pattern };
    if (entry.argPattern !== undefined) {
      allowlistEntry.argPattern = entry.argPattern;
    }
    if (entry.entrySource !== undefined) {
      allowlistEntry.source = entry.entrySource;
    }
    return allowlistEntry;
  });
  return entries.length === 0 ? undefined : entries;
}

function mergedExecApprovalAllowlistEntries(
  current: unknown,
  legacy: unknown,
): readonly NormalizedExecApprovalAllowlistEntry[] {
  const entries: NormalizedExecApprovalAllowlistEntry[] = [];
  const seen = new Set<string>();
  const appendEntries = (sourceEntries: readonly NormalizedExecApprovalAllowlistEntry[]) => {
    for (const sourceEntry of sourceEntries) {
      const key = `${sourceEntry.pattern.toLowerCase()}\x00${sourceEntry.argPattern ?? ""}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      entries.push(sourceEntry);
    }
  };
  appendEntries(withExecApprovalAllowlistSource(current, DEFAULT_EXEC_APPROVAL_AGENT_ID));
  appendEntries(withExecApprovalAllowlistSource(legacy, "default"));
  return entries;
}

function withExecApprovalAllowlistSource(
  value: unknown,
  sourceAgentId: string,
): readonly NormalizedExecApprovalAllowlistEntry[] {
  return execApprovalAllowlistEntries(value).map(
    (entry): NormalizedExecApprovalAllowlistEntry => ({
      index: entry.index,
      pattern: entry.pattern,
      argPattern: entry.argPattern,
      entrySource: entry.entrySource,
      sourceAgentId,
    }),
  );
}

function readExecApprovalAllowlistEntrySource(value: unknown): "allow-always" | undefined {
  return readString(value) === "allow-always" ? "allow-always" : undefined;
}

function execApprovalAllowlistEntries(value: unknown): readonly {
  readonly index: number;
  readonly pattern: string;
  readonly argPattern?: string;
  readonly entrySource?: string;
}[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: {
    readonly index: number;
    readonly pattern: string;
    readonly argPattern?: string;
    readonly entrySource?: string;
  }[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry === "string") {
      const pattern = entry.trim();
      if (pattern !== "") {
        entries.push({ index, pattern });
      }
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const pattern = readString(entry.pattern);
    if (pattern === undefined) {
      continue;
    }
    const argPattern = readString(entry.argPattern);
    const entrySource = readExecApprovalAllowlistEntrySource(entry.source);
    entries.push({
      index,
      pattern,
      ...(argPattern === undefined ? {} : { argPattern }),
      ...(entrySource === undefined ? {} : { entrySource }),
    });
  }
  return entries;
}
