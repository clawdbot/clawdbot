import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { FILE_TRANSFER_POLICY_VERSION } from "./shared/policy.js";

export type LegacyApprovalItem = {
  selector: string;
  kind: "read" | "write";
  path: string;
};

export type ApprovalMigrationDecision = {
  item: LegacyApprovalItem;
  action: "keep-glob" | "exact" | "remove";
};

export function listLegacyApprovalItems(pluginConfig: unknown): LegacyApprovalItem[] {
  const config = asNullableRecord(pluginConfig);
  if (!config || config.policyVersion === FILE_TRANSFER_POLICY_VERSION) {
    return [];
  }
  const nodes = asNullableRecord(config.nodes);
  if (!nodes) {
    return [];
  }
  const items: LegacyApprovalItem[] = [];
  const seen = new Set<string>();
  for (const [selector, rawNode] of Object.entries(nodes)) {
    const node = asNullableRecord(rawNode);
    if (!node) {
      continue;
    }
    for (const [kind, field] of [
      ["read", "allowReadPaths"],
      ["write", "allowWritePaths"],
    ] as const) {
      const paths = Array.isArray(node[field]) ? node[field] : [];
      for (const value of paths) {
        if (typeof value === "string" && value.length > 0) {
          const key = `${selector}\0${kind}\0${value}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          items.push({ selector, kind, path: value });
        }
      }
    }
  }
  return items;
}

export function applyApprovalMigration(
  pluginConfig: unknown,
  decisions: readonly ApprovalMigrationDecision[],
): Record<string, unknown> {
  const original = asNullableRecord(pluginConfig) ?? {};
  const next = structuredClone(original);
  const nodes = asNullableRecord(next.nodes) ?? {};
  next.nodes = nodes;
  for (const decision of decisions) {
    if (decision.action === "keep-glob") {
      continue;
    }
    const node = asNullableRecord(nodes[decision.item.selector]);
    if (!node) {
      continue;
    }
    const field = decision.item.kind === "read" ? "allowReadPaths" : "allowWritePaths";
    const paths = Array.isArray(node[field]) ? node[field] : [];
    node[field] = paths.filter((value) => value !== decision.item.path);
    if (decision.action === "exact") {
      // Legacy rows do not contain a node-authoritative canonical path or the
      // originating command. Remove the ambiguous grant and prompt once on
      // its next use; that approval records the complete exact tuple.
      if (node.ask !== "always") {
        node.ask = "on-miss";
      }
    }
  }

  next.policyVersion = FILE_TRANSFER_POLICY_VERSION;
  return next;
}
