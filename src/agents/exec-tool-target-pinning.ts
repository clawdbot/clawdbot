// Host-owned projection identity for scheduled shell aliases. A harness (for
// example Codex) presents core `exec`/`process` under runtime-specific alias
// names; this module lets the exact host capability that constructed the
// concrete core tool mint an alias projection and lets cron creator capture
// translate that alias back to its canonical tool name. The registry is
// in-memory object identity only — nothing here is persisted.
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import type { AnyAgentTool } from "./tools/common.js";

/** Canonical identity of a host-created scheduled tool alias. */
export type CronScheduledToolProjectionInfo = Readonly<{
  /** Canonical core tool the alias projects. */
  targetTool: "exec" | "process";
  /** Restrict-only execution policy the alias enforces. */
  execTarget?: Readonly<{ host: "gateway"; ask?: "always" }>;
}>;

type CronScheduledToolProjection = Readonly<{
  assertActive: () => void;
  /** Alias name the projection was sealed under; identity checks reject renames. */
  sourceToolName: string;
  info: CronScheduledToolProjectionInfo;
  execute: AnyAgentTool["execute"];
}>;

// Keyed by tool object identity; readers may hold a narrower structural view
// of the tool than the registering host, so the key type is plain `object`.
const scheduledToolProjections = new WeakMap<object, CronScheduledToolProjection>();

const EXEC_POLICY_PARAMETER_NAMES = new Set(["host", "security", "ask"]);
const NODE_EXEC_PARAMETER_NAMES = new Set(["command", "workdir", "env", "timeoutSeconds", "node"]);
const PROCESS_FOLLOWUP_TEXT =
  "Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.";

type PinnedExecToolTarget = { host: "gateway"; ask?: "always" } | { host: "node"; node?: string };

export type CronScheduledToolProjectionRequest =
  | Readonly<{
      kind: "exec";
      name: string;
      description: string;
      followupText: string;
      ask?: "always";
    }>
  | Readonly<{ kind: "process"; name: string; description: string }>;

/** Constructs and registers an alias from an exact host-owned shell source. */
export function createCronScheduledToolProjection(
  sourceTool: AnyAgentTool,
  assertActive: () => void,
  targetTool: "exec" | "process",
  projection: CronScheduledToolProjectionRequest,
): AnyAgentTool {
  assertActive();
  if (projection.kind !== targetTool) {
    throw new Error("scheduled tool projection does not match its host-created source");
  }
  const projectedTool =
    projection.kind === "exec"
      ? createScheduledExecProjection(sourceTool, projection)
      : { ...sourceTool, name: projection.name, description: projection.description };
  const info: CronScheduledToolProjectionInfo =
    targetTool === "exec"
      ? Object.freeze({
          targetTool,
          execTarget: Object.freeze({
            host: "gateway" as const,
            ...(projection.kind === "exec" && projection.ask ? { ask: projection.ask } : {}),
          }),
        })
      : Object.freeze({ targetTool });
  scheduledToolProjections.set(
    projectedTool,
    Object.freeze({
      assertActive,
      sourceToolName: projectedTool.name,
      info,
      execute: projectedTool.execute,
    }),
  );
  return projectedTool;
}

function createScheduledExecProjection(
  sourceTool: AnyAgentTool,
  projection: Readonly<{
    name: string;
    description: string;
    followupText: string;
    ask?: "always";
  }>,
): AnyAgentTool {
  const pinnedTool = pinExecToolTarget(sourceTool, {
    host: "gateway",
    ...(projection.ask ? { ask: projection.ask } : {}),
  });
  // The spread below carries the source's symbol-keyed markers (including the
  // before-tool-call wrap marker), so downstream trusted bridges recognize the
  // alias as already wrapped and never replace its registered executable.
  return {
    ...pinnedTool,
    name: projection.name,
    description: projection.description,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const result = await pinnedTool.execute(toolCallId, args, signal, onUpdate);
      return {
        ...result,
        content: result.content.map((item) =>
          item.type === "text"
            ? Object.assign({}, item, {
                text: item.text.replace(PROCESS_FOLLOWUP_TEXT, projection.followupText),
              })
            : item,
        ),
      };
    },
  };
}

/**
 * Resolves the canonical identity of a host-created alias on the final
 * executable surface. Returns undefined for tools without a registered
 * projection; throws when a registered projection's executable or name was
 * changed after host creation, so tampered aliases never canonicalize.
 */
export function readCronScheduledToolProjection(tool: {
  name: string;
  execute?: unknown;
}): CronScheduledToolProjectionInfo | undefined {
  const projection = scheduledToolProjections.get(tool);
  if (!projection) {
    return undefined;
  }
  projection.assertActive();
  if (tool.name !== projection.sourceToolName || tool.execute !== projection.execute) {
    throw new Error("scheduled tool projection executable changed after host creation");
  }
  return projection.info;
}

/** Preserves projection identity across shallow tool-object copies made by tool plumbing. */
export function copyCronScheduledToolProjection(source: AnyAgentTool, target: AnyAgentTool): void {
  const projection = scheduledToolProjections.get(source);
  if (
    projection &&
    source.name === projection.sourceToolName &&
    target.name === projection.sourceToolName &&
    source.execute === projection.execute &&
    target.execute === projection.execute
  ) {
    scheduledToolProjections.set(target, projection);
  }
}

/** Restricts an exec tool to one host target even when callers submit broader arguments. */
export function pinExecToolTarget(tool: AnyAgentTool, target: PinnedExecToolTarget): AnyAgentTool {
  const pinnedNode = target.host === "node" ? target.node?.trim() : undefined;
  const pinArgs = (args: unknown) => pinExecToolArgs(args, target, pinnedNode);
  const prepare = tool.prepareBeforeToolCallParams;
  const finalize = tool.finalizeBeforeToolCallParams;
  return {
    ...tool,
    parameters: restrictExecToolParameters(tool.parameters, target.host, Boolean(pinnedNode)),
    // The whole tool lifecycle sees only pinned arguments: preparation resolves
    // workdir/env against the pinned host, finalize's host-consistency checks
    // compare against the pinned host, and execution runs the pinned host —
    // caller-supplied host/node can never leak target-specific prepared state.
    ...(prepare
      ? {
          prepareBeforeToolCallParams: (args, context) => prepare(pinArgs(args), context),
        }
      : {}),
    ...(finalize
      ? {
          finalizeBeforeToolCallParams: (params, preparedParams) =>
            finalize(pinArgs(params), preparedParams),
        }
      : {}),
    execute: (toolCallId, args, signal, onUpdate) =>
      tool.execute(toolCallId, pinArgs(args), signal, onUpdate),
  };
}

function pinExecToolArgs(
  args: unknown,
  target: PinnedExecToolTarget,
  pinnedNode: string | undefined,
): Record<string, unknown> {
  const source = asNonArrayRecord(args);
  const { host: _host, security: _security, ask: _ask, node: requestedNode, ...rest } = source;
  if (target.host === "gateway") {
    return { ...rest, host: "gateway", ...(target.ask ? { ask: target.ask } : {}) };
  }
  const nodeArgs = Object.fromEntries(
    Object.entries(rest).filter(([name]) => NODE_EXEC_PARAMETER_NAMES.has(name)),
  );
  const node = pinnedNode ?? (typeof requestedNode === "string" ? requestedNode.trim() : "");
  return {
    ...nodeArgs,
    host: "node",
    ...(node ? { node } : {}),
  };
}

function restrictExecToolParameters<T>(
  parameters: T,
  host: PinnedExecToolTarget["host"],
  hasPinnedNode: boolean,
): T {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return parameters;
  }
  // SAFETY: the guards above establish a non-array object schema before field inspection.
  const schema = parameters as Record<string, unknown>;
  const rawProperties = schema.properties;
  if (!rawProperties || typeof rawProperties !== "object" || Array.isArray(rawProperties)) {
    return parameters;
  }
  const includeParameter = (name: string) =>
    host === "node"
      ? NODE_EXEC_PARAMETER_NAMES.has(name) && !(hasPinnedNode && name === "node")
      : !EXEC_POLICY_PARAMETER_NAMES.has(name) && name !== "node";
  const properties = Object.fromEntries(
    Object.entries(rawProperties).filter(([name]) => includeParameter(name)),
  );
  const rawRequired = schema.required;
  const required = Array.isArray(rawRequired)
    ? rawRequired.filter((name) => typeof name !== "string" || includeParameter(name))
    : rawRequired;
  return {
    ...parameters,
    properties,
    ...(Array.isArray(rawRequired) ? { required } : {}),
  };
}
