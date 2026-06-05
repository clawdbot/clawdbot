// Control UI view renders nodes shared screen content.
import { normalizeOptionalString } from "../string-coerce.ts";

export type NodeTargetOption = {
  id: string;
  label: string;
};

export type ConfigAgentOption = {
  id: string;
  name?: string;
  isDefault: boolean;
  index: number;
  record: Record<string, unknown>;
};

export function resolveConfigAgents(config: Record<string, unknown> | null): ConfigAgentOption[] {
  const agentsNode = (config?.agents ?? {}) as Record<string, unknown>;
  const list = Array.isArray(agentsNode.list) ? agentsNode.list : [];
  const agents: ConfigAgentOption[] = [];

  list.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const record = entry as Record<string, unknown>;
    const id = normalizeOptionalString(record.id) ?? "";
    if (!id) {
      return;
    }
    const name = normalizeOptionalString(record.name);
    const isDefault = record.default === true;
    agents.push({ id, name, isDefault, index, record });
  });

  return agents;
}

export function resolveNodeTargets(
  nodes: Array<Record<string, unknown>>,
  requiredCommands: string[],
): NodeTargetOption[] {
  const required = new Set(requiredCommands);
  const list: NodeTargetOption[] = [];

  for (const node of nodes) {
    const commands = Array.isArray(node.commands) ? node.commands : [];
    const supports = commands.some((cmd) => required.has(String(cmd)));
    if (!supports) {
      continue;
    }

    const nodeId = normalizeOptionalString(node.nodeId) ?? "";
    if (!nodeId) {
      continue;
    }
    const displayName = normalizeOptionalString(node.displayName) ?? nodeId;
    list.push({
      id: nodeId,
      label: displayName === nodeId ? nodeId : `${displayName} · ${nodeId}`,
    });
  }

  list.sort((a, b) => a.label.localeCompare(b.label));
  return list;
}
