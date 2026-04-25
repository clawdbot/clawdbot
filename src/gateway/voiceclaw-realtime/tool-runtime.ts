import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { resolveAgentWorkspaceDir, resolveSessionAgentIds } from "../../agents/agent-scope.js";
import { createOpenClawCodingTools } from "../../agents/pi-tools.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildAsyncToolAck,
  buildToolErrorContext,
  buildToolResultContext,
  parseToolArgs,
  summarizeToolUpdate,
  toGeminiToolDeclarations,
} from "./tools.js";
import type { VoiceClawRealtimeToolDeclaration, VoiceClawToolCallEvent } from "./types.js";

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CONCURRENT_TOOLS = 3;
const REALTIME_DIRECT_TOOL_DENY = new Set([
  "ask_brain",
  "cron",
  "gateway",
  "nodes",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
]);

type RuntimeCallbacks = {
  beginAsyncToolCall: (callId: string) => void;
  finishAsyncToolCall: (callId: string) => void;
  sendToolResult: (callId: string, output: string) => void;
  sendProgress: (callId: string, summary: string) => void;
  injectContext: (text: string) => void;
};

type InFlightTool = {
  controller: AbortController;
  toolName: string;
  timeout?: ReturnType<typeof setTimeout>;
  abortReason?: "cancelled" | "timeout";
};

type ToolRuntimeDeps = {
  createTools?: typeof createOpenClawCodingTools;
};

export type VoiceClawRealtimeToolRuntimeOptions = {
  config: OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  senderIsOwner: boolean;
  modelId?: string;
  deps?: ToolRuntimeDeps;
};

export class VoiceClawRealtimeToolRuntime {
  readonly declarations: VoiceClawRealtimeToolDeclaration[];
  private readonly toolsByName = new Map<string, AnyAgentTool>();
  private readonly inFlight = new Map<string, InFlightTool>();
  private readonly timeoutMs = resolveToolTimeoutMs();
  private readonly maxConcurrentTools = resolveMaxConcurrentTools();

  constructor(tools: AnyAgentTool[]) {
    for (const tool of tools.filter(isRealtimeDirectToolAllowed)) {
      if (!this.toolsByName.has(tool.name)) {
        this.toolsByName.set(tool.name, tool);
      }
    }
    this.declarations = toGeminiToolDeclarations(Array.from(this.toolsByName.values()));
  }

  hasTool(name: string): boolean {
    return this.toolsByName.has(name);
  }

  handleToolCall(event: VoiceClawToolCallEvent, callbacks: RuntimeCallbacks): boolean {
    const tool = this.toolsByName.get(event.name);
    if (!tool) {
      return false;
    }
    if (this.inFlight.size >= this.maxConcurrentTools) {
      callbacks.sendToolResult(
        event.callId,
        JSON.stringify({
          status: "busy",
          tool: event.name,
          error: "Too many OpenClaw tools are already running.",
        }),
      );
      return true;
    }

    const args = parseToolArgs(event.arguments);
    const controller = new AbortController();
    const startedAt = Date.now();
    const inFlight: InFlightTool = {
      controller,
      toolName: event.name,
    };
    this.inFlight.set(event.callId, inFlight);

    callbacks.beginAsyncToolCall(event.callId);
    callbacks.sendToolResult(event.callId, buildAsyncToolAck(event.name));
    callbacks.sendProgress(event.callId, `Running ${event.name}...`);

    void this.executeToolAsync({
      tool,
      callId: event.callId,
      args,
      startedAt,
      inFlight,
      callbacks,
    });
    return true;
  }

  abortTool(callId: string): void {
    const inFlight = this.inFlight.get(callId);
    if (!inFlight) {
      return;
    }
    inFlight.abortReason = "cancelled";
    inFlight.controller.abort(new Error("OpenClaw tool cancelled"));
  }

  abortAll(): void {
    for (const callId of this.inFlight.keys()) {
      this.abortTool(callId);
    }
  }

  private async executeToolAsync(params: {
    tool: AnyAgentTool;
    callId: string;
    args: Record<string, unknown>;
    startedAt: number;
    inFlight: InFlightTool;
    callbacks: RuntimeCallbacks;
  }): Promise<void> {
    const { tool, callId, args, startedAt, inFlight, callbacks } = params;
    try {
      const preparedArgs = tool.prepareArguments ? tool.prepareArguments(args) : args;
      const onUpdate: AgentToolUpdateCallback<unknown> = (partial) => {
        if (this.inFlight.get(callId) !== inFlight || inFlight.controller.signal.aborted) {
          return;
        }
        callbacks.sendProgress(callId, summarizeToolUpdate(partial));
      };
      const result = await this.executeToolWithTimeout({
        tool,
        callId,
        args: preparedArgs,
        inFlight,
        onUpdate,
      });
      if (inFlight.controller.signal.aborted || this.inFlight.get(callId) !== inFlight) {
        return;
      }
      callbacks.injectContext(
        buildToolResultContext({
          toolName: tool.name,
          args,
          result,
          elapsedMs: Date.now() - startedAt,
        }),
      );
      callbacks.sendProgress(callId, `${tool.name} finished.`);
    } catch (err) {
      if (inFlight.abortReason === "cancelled") {
        callbacks.sendProgress(callId, `${tool.name} cancelled.`);
        return;
      }
      const message =
        inFlight.abortReason === "timeout"
          ? `OpenClaw tool timed out after ${this.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      callbacks.injectContext(
        buildToolErrorContext({
          toolName: tool.name,
          args,
          message,
          elapsedMs: Date.now() - startedAt,
        }),
      );
      callbacks.sendProgress(callId, `${tool.name} failed: ${message}`);
    } finally {
      if (inFlight.timeout) {
        clearTimeout(inFlight.timeout);
      }
      this.inFlight.delete(callId);
      callbacks.finishAsyncToolCall(callId);
    }
  }

  private async executeToolWithTimeout(params: {
    tool: AnyAgentTool;
    callId: string;
    args: unknown;
    inFlight: InFlightTool;
    onUpdate: AgentToolUpdateCallback<unknown>;
  }): Promise<AgentToolResult<unknown>> {
    const { tool, callId, args, inFlight, onUpdate } = params;
    const execution = tool.execute(callId, args, inFlight.controller.signal, onUpdate);
    execution.catch(() => {});

    const timeout = new Promise<never>((_, reject) => {
      inFlight.timeout = setTimeout(() => {
        if (inFlight.abortReason === "cancelled") {
          reject(new Error("OpenClaw tool cancelled"));
          return;
        }
        inFlight.abortReason = "timeout";
        inFlight.controller.abort(new Error(`OpenClaw tool timed out after ${this.timeoutMs}ms`));
        reject(new Error(`OpenClaw tool timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });

    return await Promise.race([execution, timeout]);
  }
}

export function createVoiceClawRealtimeToolRuntime(
  options: VoiceClawRealtimeToolRuntimeOptions,
): VoiceClawRealtimeToolRuntime {
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: options.sessionKey,
    config: options.config,
  });
  const workspaceDir = resolveAgentWorkspaceDir(options.config, sessionAgentId);
  const createTools = options.deps?.createTools ?? createOpenClawCodingTools;
  return new VoiceClawRealtimeToolRuntime(
    createTools({
      config: options.config,
      sessionKey: options.sessionKey,
      sessionId: options.sessionId,
      runId: `voiceclaw-realtime-${options.sessionId}`,
      trigger: "user",
      workspaceDir,
      modelProvider: "gemini",
      modelId: options.modelId,
      senderIsOwner: options.senderIsOwner,
      allowGatewaySubagentBinding: false,
    }),
  );
}

function isRealtimeDirectToolAllowed(tool: AnyAgentTool): boolean {
  return Boolean(tool.name) && !REALTIME_DIRECT_TOOL_DENY.has(tool.name);
}

function resolveToolTimeoutMs(): number {
  const value = Number.parseInt(process.env.OPENCLAW_VOICECLAW_REALTIME_TOOL_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TOOL_TIMEOUT_MS;
}

function resolveMaxConcurrentTools(): number {
  const value = Number.parseInt(
    process.env.OPENCLAW_VOICECLAW_REALTIME_MAX_CONCURRENT_TOOLS ?? "",
    10,
  );
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_CONCURRENT_TOOLS;
}
