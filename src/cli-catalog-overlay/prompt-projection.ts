import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { buildCatalogList } from "./list.js";
import type { CliCatalogNodeCommand } from "./node-commands.js";
import type { CliCatalogPluginCommand } from "./plugin-commands.js";

type CommandPromptSurface = {
  readonly id: string;
  readonly kind: "routed-operation" | "plugin-command" | "node-command";
  readonly target: string;
  readonly commandHints: readonly string[];
  readonly risk: string;
  readonly confirmationRequired: boolean;
};

const MAX_DYNAMIC_PROMPT_SURFACES = 32;
const PROMPT_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function openClawCommand(path: readonly string[]): string {
  return `openclaw ${path.join(" ")}`;
}

function modelFacingLiteral(value: string, maxChars = 160): string {
  const singleLine = value
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf16Safe(singleLine, maxChars);
}

function listRoutedCommandSurfaces(
  operations: ReturnType<typeof buildCatalogList>["cli"]["routedOperations"],
): readonly CommandPromptSurface[] {
  return operations.map((operation) => ({
    id: operation.id,
    kind: "routed-operation" as const,
    target: operation.commandPaths[0]
      ? openClawCommand(operation.commandPaths[0])
      : `openclaw ${operation.id}`,
    commandHints: operation.commandPaths.map(openClawCommand),
    risk: operation.risk ?? "unknown",
    confirmationRequired: operation.confirmationRequired ?? true,
  }));
}

export function listCommandPromptSurfaces(
  params: {
    includeHostCli?: boolean;
    pluginCommands?: readonly CliCatalogPluginCommand[];
    promptPluginIds?: ReadonlySet<string>;
    nodeCommands?: readonly CliCatalogNodeCommand[];
    scope?: "default" | "node-operator";
  } = {},
): readonly CommandPromptSurface[] {
  const catalog = buildCatalogList({
    ...(params.pluginCommands ? { pluginCommands: params.pluginCommands } : {}),
    ...(params.nodeCommands ? { nodeCommands: params.nodeCommands } : {}),
  });
  const pluginSurfaces = (params.includeHostCli === false ? [] : catalog.cli.pluginCommands)
    .filter((command) => params.promptPluginIds?.has(command.pluginId))
    .map((command) => ({
      id: modelFacingLiteral(command.sourceId),
      kind: "plugin-command" as const,
      target: modelFacingLiteral(openClawCommand(command.commandPath), 240),
      commandHints: [modelFacingLiteral(openClawCommand(command.commandPath), 240)],
      risk: command.risk ?? "unknown",
      confirmationRequired: command.confirmationRequired ?? true,
    }));
  const nodeSurfaces =
    params.scope === "node-operator"
      ? catalog.cli.nodeCommands
          .filter(
            (command) =>
              PROMPT_IDENTIFIER_PATTERN.test(command.command) &&
              Boolean(command.nodeId && PROMPT_IDENTIFIER_PATTERN.test(command.nodeId)) &&
              (command.sourceKind === "node-runtime" ||
                command.availability === "approved" ||
                command.availability === "available"),
          )
          .map((command) => ({
            id: `node:${command.nodeId}:${command.command}`,
            kind: "node-command" as const,
            target: modelFacingLiteral(command.command, 240),
            commandHints: [
              [
                `nodes action=invoke node=${command.nodeId}`,
                `invokeCommand=${command.command}`,
                command.argumentHints.length > 0
                  ? `invokeParamsJson=<JSON object with fields: ${command.argumentHints.join(", ")}>`
                  : "",
              ]
                .filter(Boolean)
                .join(" "),
            ].map((hint) => modelFacingLiteral(hint, 240)),
            risk: command.risk ?? "unknown",
            confirmationRequired: command.confirmationRequired ?? true,
          }))
      : [];
  const sortById = (surfaces: readonly CommandPromptSurface[]) =>
    surfaces.toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const dynamicSurfaces = (
    params.scope === "node-operator"
      ? [...sortById(nodeSurfaces), ...sortById(pluginSurfaces)]
      : [...sortById(pluginSurfaces), ...sortById(nodeSurfaces)]
  ).slice(0, MAX_DYNAMIC_PROMPT_SURFACES);
  return [
    ...(params.includeHostCli === false
      ? []
      : listRoutedCommandSurfaces(catalog.cli.routedOperations)),
    ...dynamicSurfaces,
  ];
}
