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
const BLOCKED_GENERIC_NODE_INVOKE_COMMANDS = new Set(["system.run", "system.run.prepare"]);
const DEDICATED_NODE_TOOL_COMMANDS = new Set([
  "computer.act",
  "mobile.ui.observe",
  "mobile.ui.act",
]);
const DEFAULT_BLOCKED_MEDIA_NODE_COMMANDS = new Set([
  "camera.snap",
  "camera.clip",
  "photos.latest",
  "screen.record",
  "screen.snapshot",
  "file.fetch",
  "dir.list",
  "dir.fetch",
  "file.write",
]);

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

function isSafePromptIdentifier(value: string | undefined): value is string {
  return typeof value === "string" && PROMPT_IDENTIFIER_PATTERN.test(value);
}

function safeArgumentHints(hints: readonly string[]): readonly string[] {
  return hints.filter(isSafePromptIdentifier);
}

function isDefaultGenericNodeInvokeCommand(command: string): boolean {
  return (
    !BLOCKED_GENERIC_NODE_INVOKE_COMMANDS.has(command) &&
    !DEDICATED_NODE_TOOL_COMMANDS.has(command) &&
    !DEFAULT_BLOCKED_MEDIA_NODE_COMMANDS.has(command)
  );
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
      risk: "unknown",
      confirmationRequired: true,
    }));
  const nodeSurfaces =
    params.scope === "node-operator"
      ? catalog.cli.nodeCommands
          .filter(
            (command) =>
              isSafePromptIdentifier(command.command) &&
              isSafePromptIdentifier(command.nodeId) &&
              isDefaultGenericNodeInvokeCommand(command.command) &&
              command.visibility.includes("prompt") &&
              (command.availability === "approved" || command.availability === "available"),
          )
          .map((command) => {
            const safeHints = safeArgumentHints(command.argumentHints);
            return {
              id: `node:${command.nodeId}:${command.command}`,
              kind: "node-command" as const,
              target: modelFacingLiteral(command.command, 240),
              commandHints: [
                [
                  `nodes action=invoke node=${command.nodeId}`,
                  `invokeCommand=${command.command}`,
                  safeHints.length > 0
                    ? `invokeParamsJson=<JSON object with fields: ${safeHints.join(", ")}>`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" "),
              ].map((hint) => modelFacingLiteral(hint, 240)),
              risk: command.risk ?? "unknown",
              confirmationRequired: command.confirmationRequired ?? true,
            };
          })
      : [];
  const sortById = (surfaces: readonly CommandPromptSurface[]) =>
    surfaces.toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const dynamicSurfaces =
    params.scope === "node-operator"
      ? [...sortById(nodeSurfaces), ...sortById(pluginSurfaces)]
      : [...sortById(pluginSurfaces), ...sortById(nodeSurfaces)];
  const routedSurfaces =
    params.includeHostCli === false ? [] : listRoutedCommandSurfaces(catalog.cli.routedOperations);
  return [...dynamicSurfaces, ...routedSurfaces].slice(0, MAX_DYNAMIC_PROMPT_SURFACES);
}
