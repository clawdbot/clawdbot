import type { ModelCompatConfig } from "../config/types.models.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import {
  rewrapToolWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.wrapper.js";
import { applyToolAvailabilityDescriptions } from "./agent-tools.deferred-followup.js";
import { normalizeToolParameters } from "./agent-tools.schema.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { isToolWrappedWithBeforeToolCallHook } from "./before-tool-call-metadata.js";

type FinalizeAgentToolsOptions = {
  tools: AnyAgentTool[];
  modelProvider?: string;
  modelId?: string;
  modelCompat?: ModelCompatConfig;
  hookContext: HookContext;
  wrapBeforeToolCallHook?: boolean;
  emitBeforeToolCallDiagnostics?: boolean;
  approvalMode?: "request" | "report" | "deny";
  abortSignal?: AbortSignal;
  agentId?: string;
  recordToolPrepStage?: (name: string) => void;
};

/** Apply the shared schema, hook, abort, and description wrappers to an authorized tool set. */
export function finalizeAgentTools(options: FinalizeAgentToolsOptions): AnyAgentTool[] {
  const normalized = options.tools.map((tool) =>
    normalizeToolParameters(tool, {
      modelProvider: options.modelProvider,
      modelId: options.modelId,
      modelCompat: options.modelCompat,
    }),
  );
  options.recordToolPrepStage?.("schema-normalization");
  const hookOptions = {
    emitDiagnostics: options.emitBeforeToolCallDiagnostics,
    ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
  };
  const withHooks =
    options.wrapBeforeToolCallHook === false
      ? normalized
      : normalized.map((tool) =>
          isToolWrappedWithBeforeToolCallHook(tool)
            ? rewrapToolWithBeforeToolCallHook(tool, options.hookContext, hookOptions)
            : wrapToolWithBeforeToolCallHook(tool, options.hookContext, hookOptions),
        );
  options.recordToolPrepStage?.("tool-hooks");
  const abortSignal = options.abortSignal;
  const withAbort = abortSignal
    ? withHooks.map((tool) => wrapToolWithAbortSignal(tool, abortSignal))
    : withHooks;
  options.recordToolPrepStage?.("abort-wrappers");
  const finalized = applyToolAvailabilityDescriptions(withAbort, {
    agentId: options.agentId,
  });
  options.recordToolPrepStage?.("deferred-followup-descriptions");
  return finalized;
}
