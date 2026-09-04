/**
 * Tags Code Mode exec/wait control tools and normalizes hook params for the
 * exec-compatible before-tool-call surface.
 */
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { isPlainObject } from "../utils.js";
import { normalizeToolPolicyName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

/** Model-visible Code Mode exec tool name. */
export const CODE_MODE_EXEC_TOOL_NAME = "exec";
/** Model-visible Code Mode wait tool name. */
export const CODE_MODE_WAIT_TOOL_NAME = "wait";
/** Hook metadata kind for Code Mode exec tools. */
const CODE_MODE_EXEC_TOOL_KIND = "code_mode_exec";

/** Hook metadata kind type for Code Mode exec tools. */
type CodeModeExecToolKind = typeof CODE_MODE_EXEC_TOOL_KIND;
/** Source language accepted by the Code Mode exec tool. */
type CodeModeExecToolInputKind = "javascript" | "typescript";
/** Metadata attached to before-tool-call events for Code Mode exec. */
type CodeModeExecHookMetadata = {
  toolKind: CodeModeExecToolKind;
  toolInputKind?: CodeModeExecToolInputKind;
};

const codeModeControlTools = new WeakSet<object>();
type CodeModeExecDescriptionTarget = Pick<AnyAgentTool, "description">;
type CodeModeExecDescriptionState = {
  description: string;
  targets: Set<WeakRef<CodeModeExecDescriptionTarget>>;
};
const codeModeExecDescriptionTargets = new WeakMap<
  object,
  { state: CodeModeExecDescriptionState; reference: WeakRef<CodeModeExecDescriptionTarget> }
>();

/** Mark a tool as owned by code mode control flow. */
export function markCodeModeControlTool<T extends AnyAgentTool>(tool: T): T {
  codeModeControlTools.add(tool);
  return tool;
}

/** Replicate code-mode identity from an original tool object to a wrapper. */
export function copyCodeModeControlToolIdentity(
  original: object,
  wrapper: CodeModeExecDescriptionTarget,
): void {
  if (codeModeControlTools.has(original)) {
    codeModeControlTools.add(wrapper);
    const descriptionState = codeModeExecDescriptionTargets.get(original)?.state;
    if (descriptionState && descriptionState.targets.size > 0) {
      // Registry refresh recreates wrappers from retained definitions; every
      // live copy must reflect the current authorized catalog.
      wrapper.description = descriptionState.description;
      // Reuse target identity across observers so duplicate copies still update once.
      const reference =
        codeModeExecDescriptionTargets.get(wrapper)?.reference ?? new WeakRef(wrapper);
      descriptionState.targets.add(reference);
      codeModeExecDescriptionTargets.set(wrapper, { state: descriptionState, reference });
    }
  }
}

/** Keep catalog updates synchronized across every live exec definition and wrapper. */
export function createCodeModeExecDescriptionUpdater(tool: AnyAgentTool): {
  update: (description: string) => void;
  dispose: () => void;
} {
  const initialDescription = tool.description;
  const toolReference = codeModeExecDescriptionTargets.get(tool)?.reference ?? new WeakRef(tool);
  const state = { description: initialDescription, targets: new Set([toolReference]) };
  codeModeExecDescriptionTargets.set(tool, { state, reference: toolReference });
  return {
    update(description) {
      state.description = description;
      // Obsolete registry wrappers retain their old extension runner. Keep live
      // copies synchronized without extending either lifetime until catalog disposal.
      for (const reference of state.targets) {
        const target = reference.deref();
        if (target) {
          target.description = description;
        } else {
          state.targets.delete(reference);
        }
      }
    },
    dispose: () => state.targets.clear(),
  };
}

/** Return whether a tool was marked as code-mode owned. */
export function isCodeModeControlTool(tool: object): boolean {
  return codeModeControlTools.has(tool);
}

/** Return whether a tool is the marked Code Mode `exec` control tool (not a plain shell exec). */
export function isCodeModeExecTool(tool: AnyAgentTool): boolean {
  return (
    isCodeModeControlTool(tool) && normalizeToolPolicyName(tool.name) === CODE_MODE_EXEC_TOOL_NAME
  );
}

export function resolveCodeModeExecToolInputKind(
  params: unknown,
): CodeModeExecToolInputKind | undefined {
  if (!isPlainObject(params)) {
    return undefined;
  }
  const language = params.language;
  if (language === undefined || language === "javascript") {
    return "javascript";
  }
  if (language === "typescript") {
    return "typescript";
  }
  return undefined;
}

function normalizeCodeModeExecParams(params: unknown): unknown {
  if (!isPlainObject(params)) {
    return params;
  }
  const code = readNonBlankString(params.code);
  const command = readNonBlankString(params.command);
  if (code !== undefined && command === undefined) {
    // Code-mode accepts both `code` and generic exec `command`; keep them paired
    // so downstream hooks can read either shape.
    return { ...params, command: code };
  }
  if (command !== undefined && code === undefined) {
    return { ...params, code: command };
  }
  return params;
}

/** Build before-tool-call metadata for a marked code-mode exec tool. */
export function getCodeModeExecBeforeHookMetadata(params: {
  tool: AnyAgentTool;
  params: unknown;
}): CodeModeExecHookMetadata | undefined {
  if (!isCodeModeExecTool(params.tool)) {
    return undefined;
  }
  const toolInputKind = resolveCodeModeExecToolInputKind(params.params);
  return {
    toolKind: CODE_MODE_EXEC_TOOL_KIND,
    ...(toolInputKind && { toolInputKind }),
  };
}

/** Build before-tool-call metadata when only the tool kind is available. */
export function getCodeModeExecBeforeHookMetadataForToolKind(params: {
  toolKind: unknown;
  params: unknown;
}): CodeModeExecHookMetadata | undefined {
  if (params.toolKind !== CODE_MODE_EXEC_TOOL_KIND) {
    return undefined;
  }
  const toolInputKind = resolveCodeModeExecToolInputKind(params.params);
  return {
    toolKind: CODE_MODE_EXEC_TOOL_KIND,
    ...(toolInputKind && { toolInputKind }),
  };
}

/** Normalize before-hook params for a marked code-mode exec tool. */
export function normalizeCodeModeExecBeforeHookParams(params: {
  tool: AnyAgentTool;
  params: unknown;
}): unknown {
  if (!isCodeModeExecTool(params.tool)) {
    return params.params;
  }
  return normalizeCodeModeExecParams(params.params);
}

type CodeModeExecReconcileOwner = { tool: AnyAgentTool } | { toolKind: unknown };

/** Reconcile policy- or hook-adjusted aliases after raw-input normalization. */
export function reconcileCodeModeExecBeforeHookParams(params: {
  owner: CodeModeExecReconcileOwner;
  originalParams: unknown;
  hookParams: unknown;
  adjustedParams: unknown;
}): unknown {
  const isCodeModeExecOwner =
    "tool" in params.owner
      ? isCodeModeExecTool(params.owner.tool)
      : params.owner.toolKind === CODE_MODE_EXEC_TOOL_KIND;
  if (
    !isCodeModeExecOwner ||
    !isPlainObject(params.originalParams) ||
    !isPlainObject(params.hookParams) ||
    !isPlainObject(params.adjustedParams)
  ) {
    return params.adjustedParams;
  }
  const hookCode = params.hookParams.code;
  const hookCommand = params.hookParams.command;
  if (typeof hookCode !== "string" || hookCode !== hookCommand) {
    return params.adjustedParams;
  }

  const adjustedCode = params.adjustedParams.code;
  const adjustedCommand = params.adjustedParams.command;
  const adjustedCodeChanged =
    Object.hasOwn(params.adjustedParams, "code") && adjustedCode !== hookCode;
  const adjustedCommandChanged =
    Object.hasOwn(params.adjustedParams, "command") && adjustedCommand !== hookCode;
  // Invalidation must dominate a simultaneous valid rewrite; otherwise runtime
  // ignores the invalid alias and executes the other one.
  if (adjustedCodeChanged && readNonBlankString(adjustedCode) === undefined) {
    return { ...params.adjustedParams, command: adjustedCode };
  }
  if (adjustedCommandChanged && readNonBlankString(adjustedCommand) === undefined) {
    return { ...params.adjustedParams, code: adjustedCommand };
  }
  if (adjustedCodeChanged === adjustedCommandChanged) {
    return params.adjustedParams;
  }

  if (adjustedCodeChanged) {
    return { ...params.adjustedParams, command: adjustedCode };
  }
  if (adjustedCommandChanged) {
    return { ...params.adjustedParams, code: adjustedCommand };
  }
  return params.adjustedParams;
}
