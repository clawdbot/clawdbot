import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createContinueDelegateTool } from "./tools/continue-delegate-tool.js";
import { createContinueWorkTool, type ContinueWorkRequest } from "./tools/continue-work-tool.js";
import { createDelegateArtifactTools } from "./tools/delegate-artifacts-tool.js";
import {
  createRequestCompactionTool,
  type RequestCompactionToolOpts,
} from "./tools/request-compaction-tool.js";

const log = createSubsystemLogger("agents/openclaw-tools");

export type OpenClawContinuationToolOptions = {
  /** Whether the current run consumes the continue_delegate staging queue. */
  drainsContinuationDelegateQueue?: boolean;
  /** Internal maintenance/model-only runs that cannot schedule continuation work. */
  disableContinuationTools?: boolean;
  /** Callback for continue_work to request a post-turn continuation. */
  continueWorkOpts?: {
    requestContinuation: (request: ContinueWorkRequest) => void;
  };
  /** Closures for request_compaction. Only set when continuation is enabled. */
  requestCompactionOpts?: {
    sessionId?: string;
    getContextUsage: () => number | null;
    triggerCompaction: RequestCompactionToolOpts["triggerCompaction"];
  };
};

export function createOpenClawContinuationTools(
  options: OpenClawContinuationToolOptions & {
    config?: OpenClawConfig;
    agentSessionKey?: string;
    runSessionKey?: string;
    sessionId?: string;
    runId?: string;
    workspaceDir?: string;
    sandboxRoot?: string;
    sandboxFsBridge?: SandboxFsBridge;
    sandboxWritable?: boolean;
  },
): AnyAgentTool[] {
  const enabled =
    options.disableContinuationTools !== true &&
    options.config?.agents?.defaults?.continuation?.enabled === true;
  if (!enabled) {
    return [];
  }

  const liveSessionKey = options.runSessionKey ?? options.agentSessionKey;
  const tools: AnyAgentTool[] = [];
  tools.push(
    ...createDelegateArtifactTools({
      config: options.config,
      agentSessionKey: liveSessionKey,
      sessionId: options.sessionId,
      runId: options.runId,
      workspaceDir: options.workspaceDir,
      sandboxRoot: options.sandboxRoot,
      sandboxFsBridge: options.sandboxFsBridge,
      sandboxWritable: options.sandboxWritable,
    }),
  );
  if (options.continueWorkOpts) {
    tools.push(
      createContinueWorkTool({
        agentSessionKey: options.agentSessionKey,
        ...options.continueWorkOpts,
      }),
    );
  }
  if (options.drainsContinuationDelegateQueue !== false) {
    tools.push(createContinueDelegateTool({ agentSessionKey: liveSessionKey }));
  }
  if (options.requestCompactionOpts) {
    tools.push(
      createRequestCompactionTool({
        agentSessionKey: options.agentSessionKey,
        sessionId: options.sessionId,
        runId: options.runId,
        ...options.requestCompactionOpts,
      }),
    );
  }

  if (!options.continueWorkOpts && !options.requestCompactionOpts) {
    log.warn(
      "continuation.enabled=true but neither continueWorkOpts nor requestCompactionOpts " +
        "were supplied — only continue_delegate will register. If this is a live runner, it " +
        "must supply both callbacks for the full continuation tool set (likely a config/wiring " +
        "gap). If this is an inventory/catalog/dispatch build, register the tools via stub " +
        "callbacks (buildInventoryContinuationToolOpts) so the catalog reflects the full surface " +
        "and this warning is satisfied honestly rather than suppressed.",
      {
        agentSessionKey: options.agentSessionKey,
        runSessionKey: options.runSessionKey,
        drainsContinuationDelegateQueue: options.drainsContinuationDelegateQueue,
      },
    );
  }
  return tools;
}
