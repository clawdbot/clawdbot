import { normalizeOptionalString } from "../../lib/string-coerce.ts";

export type DraftBranches = {
  repoRoot: string;
  branches: Array<{ name: string; kind: "local" | "remote" }>;
  defaultBranch?: string;
  headBranch?: string;
};

export type DraftNode = {
  nodeId: string;
  displayName: string;
  connected: boolean;
  canExec: boolean;
  canBrowse: boolean;
};

export type BrowserTarget = { nodeId: string; label: string };

export function readDraftNodes(value: unknown): DraftNode[] {
  const rawNodes = Array.isArray(value) ? value : [];
  return rawNodes
    .flatMap((raw) => {
      const node = raw as {
        nodeId?: unknown;
        displayName?: unknown;
        connected?: unknown;
        commands?: unknown;
      };
      const nodeId = normalizeOptionalString(node.nodeId);
      const commands = Array.isArray(node.commands)
        ? node.commands.filter((command): command is string => typeof command === "string")
        : [];
      if (!nodeId) {
        return [];
      }
      const connected = node.connected === true;
      const canExec = connected && commands.includes("system.run");
      return [
        {
          nodeId,
          displayName: normalizeOptionalString(node.displayName) ?? nodeId,
          connected,
          canExec,
          canBrowse: canExec && commands.includes("fs.listDir"),
        },
      ];
    })
    .toSorted(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.nodeId.localeCompare(right.nodeId),
    );
}
