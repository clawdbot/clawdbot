import {
  normalizeCommandEffectProfile,
  normalizeCommandExposure,
  type CliCatalogVisibility,
} from "../cli/catalog-metadata.js";
import { cliCommandCatalog, type CliCommandCatalogEntry } from "../cli/command-catalog.js";
import { getCoreCliCommandDescriptors } from "../cli/program/core-command-descriptors.js";
import { getSubCliEntries } from "../cli/program/subcli-descriptors.js";
import { buildNodeCommandCatalog, type CliCatalogNodeCommand } from "./node-commands.js";
import type { CliCatalogPluginCommand } from "./plugin-commands.js";
import type { CliCatalogRuntimeCommand } from "./runtime-commands.js";

function markdownTableCell(value: string): string {
  return value.replace(/\r\n?|\n/g, " ").replace(/\|/g, "\\|");
}

function markdownCodeCell(value: string): string {
  const cell = markdownTableCell(value);
  const longestFence = Math.max(0, ...Array.from(cell.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  return longestFence > 0 ? `${fence} ${cell} ${fence}` : `${fence}${cell}${fence}`;
}

type CliCatalogListDescriptor = {
  readonly name: string;
  readonly description: string;
  readonly hasSubcommands: boolean;
  readonly parentDefaultHelp: boolean;
  readonly source: "core" | "subcli";
  readonly sourceKind: "core" | "subcli";
  readonly sourceId: string;
  readonly discoveryMode: "static-descriptor";
  readonly visibility: readonly CliCatalogVisibility[];
  readonly effectProfile?: {
    readonly effectMode: string;
    readonly confirmationRequired?: boolean;
    readonly risk?: string;
  };
  readonly exposureTier?: "public" | "internal";
};

type CliCatalogListCommandRoute = {
  readonly commandPath: readonly string[];
  readonly exact: boolean;
  readonly routeId?: NonNullable<CliCommandCatalogEntry["route"]>["id"];
  readonly policyKeys: readonly string[];
  readonly sourceKind: "route-policy";
  readonly sourceId: string;
  readonly discoveryMode: "route-policy";
  readonly visibility: readonly CliCatalogVisibility[];
};

type CliCatalogListRoutedOperation = {
  readonly id: string;
  readonly commandPaths: readonly (readonly string[])[];
  readonly risk?: string;
  readonly confirmationRequired?: boolean;
  readonly effectMode?: string;
  readonly sourceKind: "route-policy";
  readonly discoveryMode: "route-policy";
  readonly visibility: readonly CliCatalogVisibility[];
};

type CliCatalogRuntimeCommandScope = "current-invocation-registered-tree";
type CliCatalogNodeCommandScope = "caller-supplied";

const RUNTIME_COMMAND_SCOPE: CliCatalogRuntimeCommandScope = "current-invocation-registered-tree";
const NODE_COMMAND_SCOPE: CliCatalogNodeCommandScope = "caller-supplied";

export type CliCatalogList = {
  readonly schemaVersion: 1;
  readonly generatedFrom: "command-inventory";
  readonly counts: {
    readonly commandDescriptors: number;
    readonly commandRoutes: number;
    readonly routedOperations: number;
    readonly runtimeCommands: number;
    readonly pluginCommands: number;
    readonly nodeCommands: number;
  };
  readonly collection: {
    readonly descriptors: "complete";
    readonly commandRoutes: "complete";
    readonly runtimeCommands: "collected" | "not-requested";
    readonly pluginCommands: "collected" | "not-requested";
    readonly nodeCommands: "caller-supplied" | "not-requested";
  };
  readonly cli: {
    readonly descriptors: readonly CliCatalogListDescriptor[];
    readonly commandRoutes: readonly CliCatalogListCommandRoute[];
    readonly routedOperations: readonly CliCatalogListRoutedOperation[];
    readonly runtimeCommandScope: CliCatalogRuntimeCommandScope;
    readonly nodeCommandScope: CliCatalogNodeCommandScope;
    readonly runtimeCommands: readonly CliCatalogRuntimeCommand[];
    readonly pluginCommands: readonly CliCatalogPluginCommand[];
    readonly nodeCommands: readonly CliCatalogNodeCommand[];
  };
};

function mapDescriptor(
  descriptor: ReturnType<typeof getCoreCliCommandDescriptors>[number],
  source: "core" | "subcli",
): CliCatalogListDescriptor {
  const commandExposure = normalizeCommandExposure(descriptor.commandExposure);
  const effectProfile = normalizeCommandEffectProfile(descriptor.effectProfile);
  return {
    name: descriptor.name,
    description: descriptor.description,
    hasSubcommands: descriptor.hasSubcommands,
    parentDefaultHelp: Boolean(descriptor.parentDefaultHelp),
    source,
    sourceKind: source,
    sourceId: descriptor.name,
    discoveryMode: "static-descriptor",
    visibility:
      commandExposure?.tier === "internal"
        ? ["audit", "operator", "policy"]
        : ["docs", "audit", "operator", "policy"],
    ...(effectProfile ? { effectProfile } : {}),
    ...(commandExposure?.tier ? { exposureTier: commandExposure.tier } : {}),
  };
}

function buildDescriptors(): readonly CliCatalogListDescriptor[] {
  const core = getCoreCliCommandDescriptors()
    .filter((descriptor) => descriptor.hidden !== true)
    .map((descriptor) => mapDescriptor(descriptor, "core"));
  const subcli = getSubCliEntries()
    .filter((descriptor) => descriptor.hidden !== true)
    .map((descriptor) => mapDescriptor(descriptor, "subcli"));
  return [...core, ...subcli];
}

function buildCommandRoutes(): readonly CliCatalogListCommandRoute[] {
  return cliCommandCatalog.map((entry) => {
    const route: CliCatalogListCommandRoute = {
      commandPath: entry.commandPath,
      exact: Boolean(entry.exact),
      policyKeys: entry.policy ? Object.keys(entry.policy).toSorted() : [],
      sourceKind: "route-policy",
      sourceId: entry.commandPath.join(" "),
      discoveryMode: "route-policy",
      visibility: ["audit", "operator", "policy"],
    };
    if (entry.route) {
      Object.assign(route, { routeId: entry.route.id });
    }
    return route;
  });
}

function buildRoutedOperations(
  routes = buildCommandRoutes(),
): readonly CliCatalogListRoutedOperation[] {
  const effectProfiles = new Map(
    cliCommandCatalog.flatMap((entry) => {
      const effectProfile = normalizeCommandEffectProfile(entry.route?.effectProfile);
      return entry.route && effectProfile ? [[entry.route.id, effectProfile] as const] : [];
    }),
  );
  return [...new Set(routes.flatMap((route) => (route.routeId ? [route.routeId] : [])))]
    .toSorted()
    .map((id) => {
      const effectProfile = effectProfiles.get(id);
      const operation: CliCatalogListRoutedOperation = {
        id,
        sourceKind: "route-policy" as const,
        discoveryMode: "route-policy" as const,
        visibility: ["audit", "operator", "policy"] as const,
        commandPaths: routes
          .filter((route) => route.routeId === id)
          .map((route) => route.commandPath),
      };
      if (effectProfile?.risk) {
        Object.assign(operation, { risk: effectProfile.risk });
      }
      if (effectProfile?.confirmationRequired !== undefined) {
        Object.assign(operation, {
          confirmationRequired: effectProfile.confirmationRequired,
        });
      }
      if (effectProfile?.effectMode) {
        Object.assign(operation, { effectMode: effectProfile.effectMode });
      }
      return operation;
    });
}

export function buildCatalogList(
  params: {
    runtimeCommands?: readonly CliCatalogRuntimeCommand[];
    pluginCommands?: readonly CliCatalogPluginCommand[];
    nodeCommands?: readonly CliCatalogNodeCommand[];
  } = {},
): CliCatalogList {
  const descriptors = buildDescriptors();
  const commandRoutes = buildCommandRoutes();
  const routedOperations = buildRoutedOperations(commandRoutes);
  const runtimeCommands = params.runtimeCommands ?? [];
  const pluginCommands = params.pluginCommands ?? [];
  const nodeCommands = buildNodeCommandCatalog(params.nodeCommands);
  return {
    schemaVersion: 1,
    generatedFrom: "command-inventory",
    counts: {
      commandDescriptors: descriptors.length,
      commandRoutes: commandRoutes.length,
      routedOperations: routedOperations.length,
      runtimeCommands: runtimeCommands.length,
      pluginCommands: pluginCommands.length,
      nodeCommands: nodeCommands.length,
    },
    collection: {
      descriptors: "complete",
      commandRoutes: "complete",
      runtimeCommands: params.runtimeCommands === undefined ? "not-requested" : "collected",
      pluginCommands: params.pluginCommands === undefined ? "not-requested" : "collected",
      nodeCommands: params.nodeCommands === undefined ? "not-requested" : "caller-supplied",
    },
    cli: {
      descriptors,
      commandRoutes,
      routedOperations,
      runtimeCommandScope: RUNTIME_COMMAND_SCOPE,
      nodeCommandScope: NODE_COMMAND_SCOPE,
      runtimeCommands,
      pluginCommands,
      nodeCommands,
    },
  };
}

export function renderCatalogListMarkdown(
  params: {
    runtimeCommands?: readonly CliCatalogRuntimeCommand[];
    pluginCommands?: readonly CliCatalogPluginCommand[];
    nodeCommands?: readonly CliCatalogNodeCommand[];
  } = {},
): string {
  const list = buildCatalogList(params);
  const lines = [
    "# OpenClaw Commands",
    "",
    "Read-only inventory of OpenClaw CLI, routed, runtime, plugin, and node commands.",
    "",
    "## Counts",
    "",
    `- CLI descriptors: ${list.counts.commandDescriptors}`,
    `- Command routes: ${list.counts.commandRoutes}`,
    `- Routed operations: ${list.counts.routedOperations}`,
    `- Runtime commands: ${list.counts.runtimeCommands}`,
    `- Runtime command scope: ${list.cli.runtimeCommandScope}`,
    `- Plugin descriptor commands: ${list.counts.pluginCommands}`,
    `- Supplied node commands: ${list.counts.nodeCommands}`,
    `- Node command scope: ${list.cli.nodeCommandScope}`,
    "",
    "## Routed operations",
    "",
    "| Operation | Risk | Effect mode | Confirmation | Command paths |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const operation of list.cli.routedOperations) {
    const paths = operation.commandPaths.map((path) => markdownCodeCell(path.join(" "))).join(", ");
    lines.push(
      `| ${markdownCodeCell(operation.id)} | ${markdownCodeCell(operation.risk ?? "unknown")} | ${markdownCodeCell(operation.effectMode ?? "unknown")} | ${operation.confirmationRequired === undefined ? "unknown" : operation.confirmationRequired ? "yes" : "no"} | ${paths || "None"} |`,
    );
  }
  if (list.cli.pluginCommands.length > 0) {
    lines.push(
      "",
      "## Plugin descriptor commands",
      "",
      "| Command path | Parent | Depth | Plugin | Description |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const command of list.cli.pluginCommands) {
      lines.push(
        `| ${markdownCodeCell(command.commandPath.join(" "))} | ${command.parentPath.length > 0 ? markdownCodeCell(command.parentPath.join(" ")) : "None"} | ${command.depth} | ${markdownCodeCell(command.pluginId)} | ${markdownTableCell(command.description || "None")} |`,
      );
    }
  }

  if (list.cli.runtimeCommands.length > 0) {
    lines.push(
      "",
      "## Runtime registered commands",
      "",
      "| Command path | Parent | Depth | Visible subcommands | Description |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const command of list.cli.runtimeCommands) {
      lines.push(
        `| ${markdownCodeCell(command.commandPath.join(" "))} | ${command.parentPath.length > 0 ? markdownCodeCell(command.parentPath.join(" ")) : "None"} | ${command.depth} | ${command.visibleSubcommandCount} | ${markdownTableCell(command.description || "None")} |`,
      );
    }
  }

  if (list.cli.nodeCommands.length > 0) {
    lines.push(
      "",
      "## Node/operator commands",
      "",
      "| Command | Node | Availability | Approval | Risk | Effect mode | Invocation |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const command of list.cli.nodeCommands) {
      lines.push(
        `| ${markdownCodeCell(command.command)} | ${markdownTableCell(command.nodeName ?? command.nodeId ?? "Any")} | ${markdownCodeCell(command.availability ?? "unknown")} | ${markdownCodeCell(command.approvalKind ?? "unknown")} | ${markdownCodeCell(command.risk ?? "unknown")} | ${markdownCodeCell(command.effectMode ?? "unknown")} | ${command.invocationHint ? markdownCodeCell(command.invocationHint) : "None"} |`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}
