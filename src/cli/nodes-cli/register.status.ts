import type { Command } from "commander";
import { formatErrorMessage } from "../../infra/errors.js";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import { defaultRuntime } from "../../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { sanitizeTerminalText } from "../../terminal/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../terminal/table.js";
import { shortenHomeInString } from "../../utils.js";
import { parseDurationMs } from "../parse-duration.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import { formatPermissions, parseNodeList, parsePairingList } from "./format.js";
import { renderPendingPairingRequestsTable } from "./pairing-render.js";
import { callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodeListNode, NodesRpcOpts, PairedNode } from "./types.js";

type PairedNodeListRow = PairedNode & Partial<NodeListNode>;

function formatVersionLabel(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return raw;
  }
  if (normalizeLowercaseStringOrEmpty(trimmed).startsWith("v")) {
    return trimmed;
  }
  return /^\d/.test(trimmed) ? `v${trimmed}` : trimmed;
}

function resolveNodeVersions(node: {
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
}) {
  const core = normalizeOptionalString(node.coreVersion);
  const ui = normalizeOptionalString(node.uiVersion);
  if (core || ui) {
    return { core, ui };
  }
  const legacy = node.version?.trim();
  if (!legacy) {
    return { core: undefined, ui: undefined };
  }
  const platform = normalizeOptionalLowercaseString(node.platform) ?? "";
  const headless =
    platform === "darwin" || platform === "linux" || platform === "win32" || platform === "windows";
  return headless ? { core: legacy, ui: undefined } : { core: undefined, ui: legacy };
}

function formatNodeVersions(node: {
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
}) {
  const { core, ui } = resolveNodeVersions(node);
  const parts: string[] = [];
  if (core) {
    parts.push(`core ${formatVersionLabel(core)}`);
  }
  if (ui) {
    parts.push(`ui ${formatVersionLabel(ui)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatPathEnv(raw?: string): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(":").filter(Boolean);
  const display =
    parts.length <= 3 ? trimmed : `${parts.slice(0, 2).join(":")}:…:${parts.slice(-1)[0]}`;
  return shortenHomeInString(display);
}

function formatClientLabel(node: { clientId?: string; clientMode?: string }): string | null {
  const clientId = node.clientId?.trim();
  const clientMode = node.clientMode?.trim();
  if (clientId && clientMode) {
    return `${clientId}/${clientMode}`;
  }
  return clientId || clientMode || null;
}

function formatNodeTerminalLabel(node: { nodeId: string; displayName?: string }): string {
  const label = node.displayName?.trim() ? node.displayName.trim() : node.nodeId;
  return sanitizeTerminalText(label);
}

function parseSinceMs(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const value = normalizeOptionalString(raw) ?? (typeof raw === "number" ? String(raw) : null);
  if (value === null) {
    defaultRuntime.error(`${label}: invalid duration value`);
    defaultRuntime.exit(1);
    return undefined;
  }
  if (!value) {
    return undefined;
  }
  try {
    return parseDurationMs(value);
  } catch (err) {
    const message = formatErrorMessage(err);
    defaultRuntime.error(`${label}: ${message}`);
    defaultRuntime.exit(1);
    return undefined;
  }
}

function mergePairedNodeWithEffectiveNode(
  paired: PairedNode | undefined,
  effective: NodeListNode,
): PairedNodeListRow {
  return {
    ...paired,
    ...effective,
    token: paired?.token,
    createdAtMs: paired?.createdAtMs,
    lastConnectedAtMs: paired?.lastConnectedAtMs ?? effective.connectedAtMs,
    displayName: effective.displayName ?? paired?.displayName,
    platform: effective.platform ?? paired?.platform,
    version: effective.version ?? paired?.version,
    coreVersion: effective.coreVersion ?? paired?.coreVersion,
    uiVersion: effective.uiVersion ?? paired?.uiVersion,
    remoteIp: effective.remoteIp ?? paired?.remoteIp,
    permissions: effective.permissions ?? paired?.permissions,
    approvedAtMs: effective.approvedAtMs ?? paired?.approvedAtMs,
  };
}

function mergePairedNodesWithEffectiveNodes(
  paired: PairedNode[],
  effectiveNodes: NodeListNode[] | null,
): PairedNodeListRow[] {
  if (effectiveNodes === null) {
    return paired;
  }
  const pairedById = new Map(paired.map((node) => [node.nodeId, node]));
  const seen = new Set<string>();
  const rows: PairedNodeListRow[] = [];
  for (const effective of effectiveNodes) {
    const pairedNode = pairedById.get(effective.nodeId);
    if (!pairedNode && effective.paired !== true) {
      continue;
    }
    seen.add(effective.nodeId);
    rows.push(mergePairedNodeWithEffectiveNode(pairedNode, effective));
  }
  for (const node of paired) {
    if (!seen.has(node.nodeId)) {
      rows.push(node);
    }
  }
  return rows;
}

async function tryReadNodeList(opts: NodesRpcOpts): Promise<NodeListNode[] | null> {
  try {
    return parseNodeList(await callGatewayCli("node.list", opts, {}));
  } catch {
    return null;
  }
}

function sanitizePairedNodeForListJson(node: PairedNodeListRow): Omit<PairedNodeListRow, "token"> {
  const copy: Record<string, unknown> = { ...node };
  delete copy.token;
  return copy as Omit<PairedNodeListRow, "token">;
}

export function registerNodesStatusCommands(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("status")
      .description("List known nodes with connection status and capabilities")
      .option("--connected", "Only show connected nodes")
      .option("--last-connected <duration>", "Only show nodes connected within duration (e.g. 24h)")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("status", async () => {
          const connectedOnly = Boolean(opts.connected);
          const sinceMs = parseSinceMs(opts.lastConnected, "Invalid --last-connected");
          const result = await callGatewayCli("node.list", opts, {});
          const obj: Record<string, unknown> =
            typeof result === "object" && result !== null ? result : {};
          const { ok, warn, muted } = getNodesTheme();
          const tableWidth = getTerminalTableWidth();
          const now = Date.now();
          const nodes = parseNodeList(result);
          const lastConnectedById =
            sinceMs !== undefined
              ? new Map(
                  parsePairingList(await callGatewayCli("node.pair.list", opts, {})).paired.map(
                    (entry) => [entry.nodeId, entry],
                  ),
                )
              : null;
          const filtered = nodes.filter((n) => {
            if (connectedOnly && !n.connected) {
              return false;
            }
            if (sinceMs !== undefined) {
              const paired = lastConnectedById?.get(n.nodeId);
              const lastConnectedAtMs =
                typeof paired?.lastConnectedAtMs === "number"
                  ? paired.lastConnectedAtMs
                  : typeof n.connectedAtMs === "number"
                    ? n.connectedAtMs
                    : undefined;
              if (typeof lastConnectedAtMs !== "number") {
                return false;
              }
              if (now - lastConnectedAtMs > sinceMs) {
                return false;
              }
            }
            return true;
          });

          if (opts.json) {
            const ts = typeof obj.ts === "number" ? obj.ts : Date.now();
            defaultRuntime.writeJson({ ...obj, ts, nodes: filtered });
            return;
          }

          const pairedCount = filtered.filter((n) => Boolean(n.paired)).length;
          const connectedCount = filtered.filter((n) => Boolean(n.connected)).length;
          const filteredLabel = filtered.length !== nodes.length ? ` (of ${nodes.length})` : "";
          defaultRuntime.log(
            `Known: ${filtered.length}${filteredLabel} · Paired: ${pairedCount} · Connected: ${connectedCount}`,
          );
          if (filtered.length === 0) {
            return;
          }

          const rows = filtered.map((n) => {
            const perms = formatPermissions(n.permissions);
            const versions = formatNodeVersions(n);
            const pathEnv = formatPathEnv(n.pathEnv);
            const client = formatClientLabel(n);
            const detailParts = [
              client ? `client: ${client}` : null,
              n.deviceFamily ? `device: ${n.deviceFamily}` : null,
              n.modelIdentifier ? `hw: ${n.modelIdentifier}` : null,
              perms ? `perms: ${perms}` : null,
              versions,
              pathEnv ? `path: ${pathEnv}` : null,
            ]
              .filter(Boolean)
              .map((part) => sanitizeTerminalText(String(part)));
            const caps = Array.isArray(n.caps)
              ? sanitizeTerminalText(n.caps.map(String).filter(Boolean).toSorted().join(", "))
              : "?";
            const paired = n.paired ? ok("paired") : warn("unpaired");
            const connected = n.connected ? ok("connected") : muted("disconnected");
            const since =
              typeof n.connectedAtMs === "number"
                ? ` (${formatTimeAgo(Math.max(0, now - n.connectedAtMs))})`
                : "";

            return {
              Node: formatNodeTerminalLabel(n),
              ID: sanitizeTerminalText(n.nodeId),
              IP: sanitizeTerminalText(n.remoteIp ?? ""),
              Detail: detailParts.join(" · "),
              Status: `${paired} · ${connected}${since}`,
              Caps: caps,
            };
          });

          defaultRuntime.log(
            renderTable({
              width: tableWidth,
              columns: [
                { key: "Node", header: "Node", minWidth: 14, flex: true },
                { key: "ID", header: "ID", minWidth: 10 },
                { key: "IP", header: "IP", minWidth: 10 },
                { key: "Detail", header: "Detail", minWidth: 18, flex: true },
                { key: "Status", header: "Status", minWidth: 18 },
                { key: "Caps", header: "Caps", minWidth: 12, flex: true },
              ],
              rows,
            }).trimEnd(),
          );
        });
      }),
  );

  nodesCallOpts(
    nodes
      .command("describe")
      .description("Describe a node (capabilities + supported invoke commands)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("describe", async () => {
          const nodeId = await resolveNodeId(opts, opts.node ?? "");
          const result = await callGatewayCli("node.describe", opts, {
            nodeId,
          });
          if (opts.json) {
            defaultRuntime.writeJson(result);
            return;
          }

          const obj: Record<string, unknown> =
            typeof result === "object" && result !== null ? result : {};
          const displayName = typeof obj.displayName === "string" ? obj.displayName : nodeId;
          const connected = Boolean(obj.connected);
          const paired = Boolean(obj.paired);
          const caps = Array.isArray(obj.caps)
            ? obj.caps.map(String).filter(Boolean).toSorted()
            : null;
          const commands = Array.isArray(obj.commands)
            ? obj.commands.map(String).filter(Boolean).toSorted()
            : [];
          const perms = formatPermissions(obj.permissions);
          const family = typeof obj.deviceFamily === "string" ? obj.deviceFamily : null;
          const model = typeof obj.modelIdentifier === "string" ? obj.modelIdentifier : null;
          const client = formatClientLabel(obj as { clientId?: string; clientMode?: string });
          const ip = typeof obj.remoteIp === "string" ? obj.remoteIp : null;
          const pathEnv = typeof obj.pathEnv === "string" ? obj.pathEnv : null;
          const versions = formatNodeVersions(
            obj as {
              platform?: string;
              version?: string;
              coreVersion?: string;
              uiVersion?: string;
            },
          );

          const { heading, ok, warn, muted } = getNodesTheme();
          const status = `${paired ? ok("paired") : warn("unpaired")} · ${
            connected ? ok("connected") : muted("disconnected")
          }`;
          const tableWidth = getTerminalTableWidth();
          const rows = [
            { Field: "ID", Value: sanitizeTerminalText(nodeId) },
            displayName ? { Field: "Name", Value: sanitizeTerminalText(displayName) } : null,
            client ? { Field: "Client", Value: sanitizeTerminalText(client) } : null,
            ip ? { Field: "IP", Value: sanitizeTerminalText(ip) } : null,
            family ? { Field: "Device", Value: sanitizeTerminalText(family) } : null,
            model ? { Field: "Model", Value: sanitizeTerminalText(model) } : null,
            perms ? { Field: "Perms", Value: sanitizeTerminalText(perms) } : null,
            versions ? { Field: "Version", Value: sanitizeTerminalText(versions) } : null,
            pathEnv ? { Field: "PATH", Value: sanitizeTerminalText(pathEnv) } : null,
            { Field: "Status", Value: status },
            { Field: "Caps", Value: caps ? sanitizeTerminalText(caps.join(", ")) : "?" },
          ].filter(Boolean) as Array<{ Field: string; Value: string }>;

          defaultRuntime.log(heading("Node"));
          defaultRuntime.log(
            renderTable({
              width: tableWidth,
              columns: [
                { key: "Field", header: "Field", minWidth: 8 },
                { key: "Value", header: "Value", minWidth: 24, flex: true },
              ],
              rows,
            }).trimEnd(),
          );
          defaultRuntime.log("");
          defaultRuntime.log(heading("Commands"));
          if (commands.length === 0) {
            defaultRuntime.log(muted("- (none reported)"));
            return;
          }
          for (const c of commands) {
            defaultRuntime.log(`- ${c}`);
          }
        });
      }),
  );

  nodesCallOpts(
    nodes
      .command("list")
      .description("List pending and paired nodes")
      .option("--connected", "Only show connected nodes")
      .option("--last-connected <duration>", "Only show nodes connected within duration (e.g. 24h)")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("list", async () => {
          const connectedOnly = Boolean(opts.connected);
          const sinceMs = parseSinceMs(opts.lastConnected, "Invalid --last-connected");
          const result = await callGatewayCli("node.pair.list", opts, {});
          const { pending, paired } = parsePairingList(result);
          const { heading, muted, warn } = getNodesTheme();
          const tableWidth = getTerminalTableWidth();
          const now = Date.now();
          const hasFilters = connectedOnly || sinceMs !== undefined;
          const pendingRows = hasFilters ? [] : pending;
          const effectiveNodes = hasFilters
            ? parseNodeList(await callGatewayCli("node.list", opts, {}))
            : await tryReadNodeList(opts);
          const effectivePairedRows = mergePairedNodesWithEffectiveNodes(paired, effectiveNodes);
          const filteredPaired = effectivePairedRows.filter((node) => {
            if (connectedOnly) {
              if (!node.connected) {
                return false;
              }
            }
            if (sinceMs !== undefined) {
              const lastConnectedAtMs =
                typeof node.lastConnectedAtMs === "number"
                  ? node.lastConnectedAtMs
                  : typeof node.connectedAtMs === "number"
                    ? node.connectedAtMs
                    : undefined;
              if (typeof lastConnectedAtMs !== "number") {
                return false;
              }
              if (now - lastConnectedAtMs > sinceMs) {
                return false;
              }
            }
            return true;
          });
          const filteredLabel =
            hasFilters && filteredPaired.length !== paired.length ? ` (of ${paired.length})` : "";
          defaultRuntime.log(
            `Pending: ${pendingRows.length} · Paired: ${filteredPaired.length}${filteredLabel}`,
          );

          if (opts.json) {
            defaultRuntime.writeJson({
              pending: pendingRows,
              paired: filteredPaired.map(sanitizePairedNodeForListJson),
            });
            return;
          }

          if (pendingRows.length > 0) {
            const rendered = renderPendingPairingRequestsTable({
              pending: pendingRows,
              now,
              tableWidth,
              theme: { heading, warn, muted },
            });
            defaultRuntime.log("");
            defaultRuntime.log(rendered.heading);
            defaultRuntime.log(rendered.table);
          }

          if (filteredPaired.length > 0) {
            const pairedTableRows = filteredPaired.map((n) => {
              const lastConnectedAtMs =
                typeof n.lastConnectedAtMs === "number"
                  ? n.lastConnectedAtMs
                  : typeof n.connectedAtMs === "number"
                    ? n.connectedAtMs
                    : undefined;
              return {
                Node: formatNodeTerminalLabel(n),
                Id: sanitizeTerminalText(n.nodeId),
                IP: sanitizeTerminalText(n.remoteIp ?? ""),
                LastConnect:
                  typeof lastConnectedAtMs === "number"
                    ? formatTimeAgo(Math.max(0, now - lastConnectedAtMs))
                    : muted("unknown"),
              };
            });
            defaultRuntime.log("");
            defaultRuntime.log(heading("Paired"));
            defaultRuntime.log(
              renderTable({
                width: tableWidth,
                columns: [
                  { key: "Node", header: "Node", minWidth: 14, flex: true },
                  { key: "Id", header: "ID", minWidth: 10 },
                  { key: "IP", header: "IP", minWidth: 10 },
                  { key: "LastConnect", header: "Last Connect", minWidth: 14 },
                ],
                rows: pairedTableRows,
              }).trimEnd(),
            );
          }
        });
      }),
  );
}
