/**
 * LLM Request Hook Wrapper
 *
 * Wraps the streamFn to intercept LLM API payloads and emit them
 * to plugins via the llm_request hook.
 *
 * This enables plugins (like W&B Weave) to capture the complete
 * request payload including system prompts for observability.
 */

import crypto from "node:crypto";

import type { StreamFn } from "@mariozechner/pi-agent-core";

import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookLlmRequestContext, PluginHookLlmRequestEvent } from "../plugins/hooks.js";

/**
 * Context for the LLM request hook wrapper
 */
export type LlmRequestHookContext = {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
};

/**
 * Safely stringify a value to JSON, handling special types
 */
function safeJsonStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "function") return "[Function]";
      if (val instanceof Error) {
        return { name: val.name, message: val.message, stack: val.stack };
      }
      if (val instanceof Uint8Array) {
        return { type: "Uint8Array", data: Buffer.from(val).toString("base64") };
      }
      return val;
    });
  } catch {
    return null;
  }
}

/**
 * Compute SHA256 digest of a value
 */
function digest(value: unknown): string | undefined {
  const serialized = safeJsonStringify(value);
  if (!serialized) return undefined;
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

/**
 * Create a wrapper for streamFn that emits llm_request hooks
 *
 * Supports ALL LLM providers that use pi-ai's streaming functions,
 * as onPayload callback is supported by all APIs:
 * - anthropic-messages (Claude)
 * - openai-completions (OpenAI, Mistral, xAI, Cerebras, Groq, etc.)
 * - openai-responses (OpenAI newer API)
 * - google-generative-ai (Gemini)
 * - bedrock-converse-stream (AWS Bedrock)
 * - google-vertex (Vertex AI)
 */
export function createLlmRequestHookWrapper(ctx: LlmRequestHookContext): {
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
} | null {
  const hookRunner = getGlobalHookRunner();

  // If no hook runner or no hooks registered, skip wrapping
  if (!hookRunner || !hookRunner.hasHooks("llm_request")) {
    return null;
  }

  const hookCtx: PluginHookLlmRequestContext = {
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    provider: ctx.provider,
    modelId: ctx.modelId,
    modelApi: ctx.modelApi,
    workspaceDir: ctx.workspaceDir,
  };

  const wrapStreamFn = (streamFn: StreamFn): StreamFn => {
    const wrapped: StreamFn = (model, context, options) => {
      const nextOnPayload = (payload: unknown) => {
        // Emit the llm_request hook with the full payload
        const event: PluginHookLlmRequestEvent = {
          payload: payload as PluginHookLlmRequestEvent["payload"],
          payloadDigest: digest(payload),
          timestamp: new Date().toISOString(),
        };

        // Fire hook asynchronously (don't block the request)
        hookRunner.runLlmRequest(event, hookCtx).catch((err) => {
          console.error("[llm-request-hook] Hook execution failed:", err);
        });

        // Pass through to any existing onPayload handler
        options?.onPayload?.(payload);
      };

      return streamFn(model, context, {
        ...options,
        onPayload: nextOnPayload,
      });
    };

    return wrapped;
  };

  return { wrapStreamFn };
}
