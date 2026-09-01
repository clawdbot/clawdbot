/**
 * Session tool public barrel.
 *
 * Re-exports built-in tool factories, operation interfaces, contracts, and shared truncation helpers.
 */
import type { AgentTool } from "../../runtime/index.js";
import type { ToolDefinition } from "../extensions/types.js";
import { type BashToolOptions, createBashToolDefinition } from "./bash.js";
import { createEditToolDefinition, type EditToolOptions } from "./edit.js";
import { createFindToolDefinition, type FindToolOptions } from "./find.js";
import { createGrepToolDefinition, type GrepToolOptions } from "./grep.js";
import { createLsToolDefinition, type LsToolOptions } from "./ls.js";
import { createReadToolDefinition, type ReadToolOptions } from "./read.js";
import { wrapToolDefinition, wrapToolDefinitions } from "./tool-definition-wrapper.js";
import { createWriteToolDefinition, type WriteToolOptions } from "./write.js";
export {
  type BashSpawnContext,
  type BashSpawnHook,
  type BashToolOptions,
  createBashTool,
  createBashToolDefinition,
  createLocalBashOperations,
} from "./bash.js";
export type { BashOperations } from "./bash-operations.js";
export type {
  BashToolDetails,
  BashToolInput,
  EditToolDetails,
  EditToolInput,
  FindToolDetails,
  FindToolInput,
  GrepToolDetails,
  GrepToolInput,
  LsToolDetails,
  LsToolInput,
  ReadToolDetails,
  ReadToolInput,
  ReadToolTruncationDetails,
  WriteToolDetails,
  WriteToolInput,
} from "./tool-contracts.js";
export {
  createEditTool,
  createEditToolDefinition,
  type EditOperations,
  type EditToolOptions,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
  createFindTool,
  createFindToolDefinition,
  type FindOperations,
  type FindToolOptions,
} from "./find.js";
export {
  createGrepTool,
  createGrepToolDefinition,
  type GrepOperations,
  type GrepToolOptions,
} from "./grep.js";
export {
  createLsTool,
  createLsToolDefinition,
  type LsOperations,
  type LsToolOptions,
} from "./ls.js";
export {
  createReadTool,
  createReadToolDefinition,
  type ReadOperations,
  type ReadToolOptions,
} from "./read.js";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationOptions,
  type TruncationResult,
  truncateHead,
  truncateLine,
  truncateTail,
} from "./truncate.js";
export {
  createWriteTool,
  createWriteToolDefinition,
  type WriteOperations,
  type WriteToolOptions,
} from "./write.js";

/**
 * Public factory barrel for the built-in coding and read-only session tools.
 *
 * Keep grouped creators here so callers can request stable tool sets without importing each
 * individual implementation module.
 */
type Tool = AgentTool;
export type ToolDef = ToolDefinition;
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
export const allToolNames: Set<ToolName> = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

export interface ToolsOptions {
  read?: ReadToolOptions;
  bash?: BashToolOptions;
  write?: WriteToolOptions;
  edit?: EditToolOptions;
  grep?: GrepToolOptions;
  find?: FindToolOptions;
  ls?: LsToolOptions;
}

/** Creates one tool definition by stable built-in tool name. */
export function createToolDefinition(
  toolName: ToolName,
  cwd: string,
  options?: ToolsOptions,
): ToolDef {
  switch (toolName) {
    case "read":
      return createReadToolDefinition(cwd, options?.read);
    case "bash":
      return createBashToolDefinition(cwd, options?.bash);
    case "edit":
      return createEditToolDefinition(cwd, options?.edit);
    case "write":
      return createWriteToolDefinition(cwd, options?.write);
    case "grep":
      return createGrepToolDefinition(cwd, options?.grep);
    case "find":
      return createFindToolDefinition(cwd, options?.find);
    case "ls":
      return createLsToolDefinition(cwd, options?.ls);
    default:
      throw new Error(`Unknown tool name: ${String(toolName)}`);
  }
}

/** Creates one executable built-in tool by stable tool name. */
export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
  return wrapToolDefinition(createToolDefinition(toolName, cwd, options));
}

/** Creates the mutable coding tool definitions used by agent coding sessions. */
export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
  return [
    createReadToolDefinition(cwd, options?.read),
    createBashToolDefinition(cwd, options?.bash),
    createEditToolDefinition(cwd, options?.edit),
    createWriteToolDefinition(cwd, options?.write),
  ];
}

/** Creates read-only discovery tool definitions for restricted sessions. */
export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
  return [
    createReadToolDefinition(cwd, options?.read),
    createGrepToolDefinition(cwd, options?.grep),
    createFindToolDefinition(cwd, options?.find),
    createLsToolDefinition(cwd, options?.ls),
  ];
}

/** Creates all built-in tool definitions keyed by tool name. */
export function createAllToolDefinitions(
  cwd: string,
  options?: ToolsOptions,
): Record<ToolName, ToolDef> {
  return {
    read: createReadToolDefinition(cwd, options?.read),
    bash: createBashToolDefinition(cwd, options?.bash),
    edit: createEditToolDefinition(cwd, options?.edit),
    write: createWriteToolDefinition(cwd, options?.write),
    grep: createGrepToolDefinition(cwd, options?.grep),
    find: createFindToolDefinition(cwd, options?.find),
    ls: createLsToolDefinition(cwd, options?.ls),
  };
}

/** Creates the mutable coding tools used by local agent sessions. */
export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
  return wrapToolDefinitions(createCodingToolDefinitions(cwd, options));
}

/** Creates read-only discovery tools for restricted sessions. */
export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
  return wrapToolDefinitions(createReadOnlyToolDefinitions(cwd, options));
}

/** Creates all built-in tools keyed by tool name. */
export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
  const definitions = createAllToolDefinitions(cwd, options);
  return {
    read: wrapToolDefinition(definitions.read),
    bash: wrapToolDefinition(definitions.bash),
    edit: wrapToolDefinition(definitions.edit),
    write: wrapToolDefinition(definitions.write),
    grep: wrapToolDefinition(definitions.grep),
    find: wrapToolDefinition(definitions.find),
    ls: wrapToolDefinition(definitions.ls),
  };
}
