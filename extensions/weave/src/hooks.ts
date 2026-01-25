/**
 * W&B Weave Plugin Hooks
 *
 * Lifecycle hooks for automatic observability and tracing
 */

import type { ClawdbotPluginApi } from 'clawdbot/plugin-sdk';
import type { WeavePluginConfig } from './types.js';
import { getWeaveClient } from './client.js';
import { shouldSample } from './config.js';

/**
 * Hook event and context types (simplified for our needs)
 */
interface SessionStartEvent {
  sessionId: string;
  resumedFrom?: string;
}

interface SessionEndEvent {
  sessionId: string;
  messageCount: number;
  durationMs?: number;
}

interface SessionContext {
  agentId?: string;
  sessionId: string;
}

interface AgentStartEvent {
  prompt: string;
  messages?: unknown[];
}

interface AgentContext {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageProvider?: string;
}

interface AgentEndEvent {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
}

interface ToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
}

interface ToolCallEndEvent {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

interface ToolContext {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
}

interface MessageReceivedEvent {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

interface MessageSentEvent {
  to: string;
  content: string;
  success: boolean;
  error?: string;
}

interface LlmRequestEvent {
  payload: {
    system?: unknown;
    messages?: unknown[];
    model?: string;
    max_tokens?: number;
    temperature?: number;
    tools?: unknown[];
    [key: string]: unknown;
  };
  payloadDigest?: string;
  timestamp: string;
}

interface LlmRequestContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
}

/**
 * Track active spans by session key for tool call nesting
 */
const toolSpans = new Map<string, string[]>();

/**
 * Register all observability hooks
 */
export function registerHooks(api: ClawdbotPluginApi, config: WeavePluginConfig): void {
  const logger = api.logger;

  // Session tracking hooks
  if (config.traceSessions) {
    api.on('session_start', async (rawEvent, rawCtx) => {
      const event = rawEvent as SessionStartEvent;
      const ctx = rawCtx as SessionContext;

      if (!shouldSample(config.sampleRate ?? 1.0)) return;

      try {
        const client = getWeaveClient();
        client.startTrace(ctx.sessionId, {
          type: 'session',
          resumedFrom: event.resumedFrom,
        });
        logger.debug?.(`[weave] Session started: ${ctx.sessionId}`);
      } catch (error) {
        logger.error(`[weave] Failed to start session trace: ${error}`);
      }
    });

    api.on('session_end', async (rawEvent, rawCtx) => {
      const event = rawEvent as SessionEndEvent;
      const ctx = rawCtx as SessionContext;

      try {
        const client = getWeaveClient();
        const trace = client.getTrace(ctx.sessionId);
        if (trace) {
          trace.metadata.messageCount = event.messageCount;
          trace.metadata.durationMs = event.durationMs;
          await client.endTrace(ctx.sessionId);
          logger.debug?.(`[weave] Session ended: ${ctx.sessionId}`);
        }
      } catch (error) {
        logger.error(`[weave] Failed to end session trace: ${error}`);
      }
    });
  }

  // Agent run tracing hooks
  if (config.autoTrace) {
    console.log('[weave] Registering before_agent_start hook');
    api.on('before_agent_start', async (rawEvent, rawCtx) => {
      console.log('[weave] HOOK FIRED: before_agent_start');
      const event = rawEvent as AgentStartEvent;
      const ctx = rawCtx as AgentContext;
      // Log ALL available data to discover system prompt
      console.log('[weave] before_agent_start event keys:', Object.keys(rawEvent as object));
      console.log('[weave] before_agent_start context keys:', Object.keys(rawCtx as object));
      console.log('[weave] Full event (truncated):', JSON.stringify(rawEvent).slice(0, 1500));
      console.log('[weave] Full context (truncated):', JSON.stringify(rawCtx).slice(0, 1500));

      if (!shouldSample(config.sampleRate ?? 1.0)) return;

      try {
        const client = getWeaveClient();
        const sessionKey = ctx.sessionKey ?? 'unknown';

        // Start or get existing trace
        let trace = client.getTrace(sessionKey);
        if (!trace) {
          trace = client.startTrace(sessionKey, {
            agentId: ctx.agentId,
            provider: ctx.messageProvider,
          });
        }

        // Start agent run span
        const span = client.startSpan(
          sessionKey,
          'agent_run',
          {
            prompt: event.prompt,
            messageCount: event.messages?.length ?? 0,
          },
          {
            agentId: ctx.agentId,
            workspaceDir: ctx.workspaceDir,
          }
        );

        console.log(`[weave] Agent run started: ${span.id}`);
        logger.debug?.(`[weave] Agent run started: ${span.id}`);
      } catch (error) {
        console.error(`[weave] Failed to start agent trace: ${error}`);
        logger.error(`[weave] Failed to start agent trace: ${error}`);
      }

      // Return nothing - we don't modify the prompt
      return;
    });

    console.log('[weave] Registering agent_end hook');
    api.on('agent_end', async (rawEvent, rawCtx) => {
      console.log('[weave] HOOK FIRED: agent_end');
      const event = rawEvent as AgentEndEvent;
      const ctx = rawCtx as AgentContext;

      try {
        const client = getWeaveClient();
        const sessionKey = ctx.sessionKey ?? 'unknown';
        const trace = client.getTrace(sessionKey);

        if (trace?.activeSpan) {
          // Debug: log raw event to understand ALL available data
          console.log(`[weave] agent_end event keys:`, Object.keys(event));
          console.log(`[weave] agent_end full event (truncated):`, JSON.stringify(event).slice(0, 1000));
          console.log(`[weave] messages type:`, typeof event.messages, Array.isArray(event.messages) ? `array[${event.messages.length}]` : '');

          // Log ALL unique roles in messages
          if (event.messages && Array.isArray(event.messages)) {
            const roles = new Set<string>();
            for (const msg of event.messages as Array<{ role?: string }>) {
              if (msg.role) roles.add(msg.role);
            }
            console.log(`[weave] Message roles found:`, Array.from(roles).join(', '));

            // Log first message of each role type for debugging
            const seenRoles = new Set<string>();
            for (const msg of event.messages as Array<{ role?: string }>) {
              if (msg.role && !seenRoles.has(msg.role)) {
                seenRoles.add(msg.role);
                console.log(`[weave] Sample ${msg.role} message:`, JSON.stringify(msg).slice(0, 400));
              }
            }
          }

          // Type definitions for message parsing
          type ToolUseBlock = { type: 'tool_use'; id?: string; name: string; input: Record<string, unknown> };
          type ToolResultBlock = { type: 'tool_result'; tool_use_id?: string; content?: string };
          type ContentBlock = { type?: string; text?: string; thinking?: string } | ToolUseBlock | ToolResultBlock;
          type Message = { role?: string; content?: string | ContentBlock[] };
          const messages = event.messages as Message[] | undefined;

          // Helper to extract text from content (string or array of blocks)
          const extractText = (content: string | ContentBlock[] | undefined): string => {
            if (!content) return '';
            if (typeof content === 'string') return content;
            return content
              .filter((block): block is ContentBlock & { text: string } => block.type === 'text' && typeof block.text === 'string')
              .map(block => block.text)
              .join('');
          };

          // Extended message type for Clawdbot-specific roles
          type ExtendedMessage = Message & {
            summary?: string;
            toolCallId?: string;
            toolName?: string;
          };
          const extMessages = messages as ExtendedMessage[] | undefined;

          // Extract the COMPLETE conversation by role
          const compactionSummaries: string[] = [];
          const userMessages: string[] = [];
          const assistantMessages: string[] = [];
          const toolCalls: Array<{ name: string; input: Record<string, unknown>; result?: string }> = [];
          const toolResults: Array<{ toolName: string; toolCallId: string; result: string }> = [];

          if (extMessages) {
            for (const msg of extMessages) {
              // Capture compaction summaries (session context)
              if (msg.role === 'compactionSummary' && msg.summary) {
                compactionSummaries.push(msg.summary);
              }

              // Capture all user messages
              if (msg.role === 'user') {
                const text = extractText(msg.content);
                if (text) userMessages.push(text);
              }

              // Capture all assistant messages
              if (msg.role === 'assistant') {
                const text = extractText(msg.content);
                if (text) assistantMessages.push(text);
              }

              // Capture tool results (Clawdbot uses role: "toolResult")
              if (msg.role === 'toolResult' && msg.toolName && msg.toolCallId) {
                const resultText = extractText(msg.content);
                toolResults.push({
                  toolName: msg.toolName,
                  toolCallId: msg.toolCallId,
                  result: resultText.slice(0, 2000),
                });
              }

              // Extract tool calls from content blocks (tool_use)
              if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                  if (block.type === 'tool_use' && 'name' in block) {
                    toolCalls.push({
                      name: block.name,
                      input: block.input,
                    });
                  }
                }
              }
            }

            // Match tool results to tool calls by toolCallId
            for (const result of toolResults) {
              const matchingCall = toolCalls.find(tc => !tc.result);
              if (matchingCall) {
                matchingCall.result = result.result;
              }
            }
          }

          console.log(`[weave] Extracted - Summaries: ${compactionSummaries.length}, User: ${userMessages.length}, Assistant: ${assistantMessages.length}, ToolCalls: ${toolCalls.length}, ToolResults: ${toolResults.length}`);
          if (compactionSummaries.length > 0) {
            console.log(`[weave] Compaction summary length: ${compactionSummaries.join('').length} chars`);
          }
          if (toolCalls.length > 0) {
            console.log(`[weave] Tool calls:`, toolCalls.map(tc => tc.name).join(', '));
          }
          if (toolResults.length > 0) {
            console.log(`[weave] Tool results:`, toolResults.map(tr => tr.toolName).join(', '));
          }

          // Get the final response (last assistant message)
          const response = assistantMessages[assistantMessages.length - 1] ?? '';
          console.log(`[weave] Final response length: ${response.length} chars`);

          // Include system prompt and all LLM requests from llm_request hook
          const systemPrompt = trace.metadata.systemPrompt as string | undefined;
          const systemPromptChanges = trace.metadata.systemPromptChanges as number | undefined;
          const llmRequest = trace.metadata.llmRequest as Record<string, unknown> | undefined;
          const llmRequests = trace.metadata.llmRequests as unknown[] | undefined;
          const llmTools = trace.metadata.llmTools as unknown[] | undefined;

          console.log(`[weave] LLM Requests captured: ${llmRequests?.length ?? 0}, System prompt changes: ${systemPromptChanges ?? 0}`);

          client.endSpan(
            trace.activeSpan,
            {
              // FULL SYSTEM PROMPT - captured from llm_request hook (latest version)
              systemPrompt: systemPrompt ?? undefined,
              systemPromptChanges: systemPromptChanges ?? 0,
              // ALL LLM Requests (for multi-turn conversations)
              llmRequests: llmRequests ?? undefined,
              llmRequestCount: llmRequests?.length ?? 0,
              // First LLM Request metadata (backward compatible)
              llmRequest: llmRequest ?? undefined,
              // Available tools/functions
              llmTools: llmTools ?? undefined,
              // Session context (compaction summaries contain read files, etc.)
              sessionContext: compactionSummaries.length > 0 ? compactionSummaries.join('\n\n---\n\n') : undefined,
              // Full conversation
              userMessages: userMessages.length > 0 ? userMessages : undefined,
              assistantMessages: assistantMessages.length > 0 ? assistantMessages : undefined,
              // Final response for quick access
              response,
              // Tool calls with results
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              toolResults: toolResults.length > 0 ? toolResults : undefined,
              toolCallCount: toolCalls.length + toolResults.length,
              // Metadata
              success: event.success,
              messageCount: event.messages?.length ?? 0,
              durationMs: event.durationMs,
            },
            event.success,
            event.error
          );

          trace.metadata.durationMs = event.durationMs;
          trace.metadata.success = event.success;
          if (event.error) {
            trace.metadata.error = event.error;
          }

          console.log(`[weave] Agent run ended: ${trace.activeSpan.id}`);
          logger.debug?.(`[weave] Agent run ended: ${trace.activeSpan.id}`);
        }

        // Always end trace after agent run to ensure it's logged to Weave
        // Even with session tracking, we want per-run traces
        console.log(`[weave] Ending trace for sessionKey: ${sessionKey}`);
        await client.endTrace(sessionKey);
        console.log(`[weave] Trace ended and logged to Weave`);
      } catch (error) {
        console.error(`[weave] Failed to end agent trace: ${error}`);
        logger.error(`[weave] Failed to end agent trace: ${error}`);
      }
    });

    // LLM Request hook - captures the FULL payload sent to the LLM API
    // NOTE: This hook requires Clawdbot core support!
    try {
      console.log('[weave] Registering llm_request hook');
      api.on('llm_request', async (rawEvent, rawCtx) => {
      console.log('[weave] HOOK FIRED: llm_request');
      const event = rawEvent as LlmRequestEvent;
      const ctx = rawCtx as LlmRequestContext;

      try {
        const client = getWeaveClient();
        const sessionKey = ctx.sessionKey ?? 'unknown';
        const trace = client.getTrace(sessionKey);

        // Extract system prompt from payload
        const systemPrompt = event.payload.system;
        const systemPromptStr = typeof systemPrompt === 'string'
          ? systemPrompt
          : JSON.stringify(systemPrompt);

        // Build request record with FULL system prompt for complete observability
        const requestRecord = {
          timestamp: event.timestamp,
          payloadDigest: event.payloadDigest,
          model: event.payload.model,
          maxTokens: event.payload.max_tokens,
          temperature: event.payload.temperature,
          // Include FULL system prompt for this specific request
          systemPrompt: systemPromptStr ?? undefined,
          systemPromptLength: systemPromptStr?.length ?? 0,
          messagesCount: event.payload.messages?.length ?? 0,
          toolsCount: event.payload.tools?.length ?? 0,
          // Include messages for this specific request
          messages: event.payload.messages,
        };

        if (trace) {
          // Initialize arrays if needed
          if (!trace.metadata.llmRequests) {
            trace.metadata.llmRequests = [];
          }

          // Add this request to the array (complete multi-request tracing)
          (trace.metadata.llmRequests as unknown[]).push(requestRecord);

          const requestIndex = (trace.metadata.llmRequests as unknown[]).length;
          console.log(`[weave] LLM Request #${requestIndex} captured - System prompt: ${systemPromptStr?.length ?? 0} chars, Messages: ${event.payload.messages?.length ?? 0}`);

          // Track system prompt changes - store latest version (most relevant for final response)
          if (systemPromptStr) {
            const currentLength = (trace.metadata.systemPrompt as string | undefined)?.length ?? 0;
            const newLength = systemPromptStr.length;

            if (!trace.metadata.systemPrompt) {
              // First system prompt
              trace.metadata.systemPrompt = systemPromptStr;
              trace.metadata.systemPromptChanges = 0;
              console.log(`[weave] System prompt stored (first request, ${newLength} chars)`);
            } else if (newLength !== currentLength) {
              // System prompt changed - update to latest version
              trace.metadata.systemPrompt = systemPromptStr;
              trace.metadata.systemPromptChanges = ((trace.metadata.systemPromptChanges as number) ?? 0) + 1;
              console.log(`[weave] System prompt CHANGED (${currentLength} -> ${newLength} chars, change #${trace.metadata.systemPromptChanges})`);
            }
          }

          // Store tools only on first request (they don't change either)
          if (!trace.metadata.llmTools && event.payload.tools) {
            trace.metadata.llmTools = event.payload.tools;
          }

          // Keep backward-compatible single llmRequest field (points to first request)
          if (!trace.metadata.llmRequest) {
            trace.metadata.llmRequest = requestRecord;
          }

          logger.debug?.(`[weave] LLM request #${requestIndex} captured for session: ${sessionKey}`);
        } else {
          // No active trace - log as orphaned request (happens after agent_end)
          console.log(`[weave] Orphaned LLM request (no active trace) - sessionKey: ${sessionKey}, messages: ${event.payload.messages?.length ?? 0}`);

          // Log orphaned requests to Weave as standalone traces
          try {
            const { op } = await import('weave');
            const orphanedRequestFn = op(
              async (input: { sessionKey: string; request: typeof requestRecord; systemPromptLength: number }) => {
                return {
                  type: 'orphaned_llm_request',
                  sessionKey: input.sessionKey,
                  messagesCount: input.request.messagesCount,
                  model: input.request.model,
                };
              },
              { name: 'orphaned_llm_request' }
            );
            await orphanedRequestFn({
              sessionKey,
              request: requestRecord,
              systemPromptLength: systemPromptStr?.length ?? 0,
            });
            console.log(`[weave] Orphaned request logged as standalone trace`);
          } catch (orphanError) {
            console.error(`[weave] Failed to log orphaned request: ${orphanError}`);
          }
        }
      } catch (error) {
        console.error(`[weave] Failed to capture llm_request: ${error}`);
        logger.error(`[weave] Failed to capture llm_request: ${error}`);
      }
    });
    } catch (error) {
      // llm_request hook not available in this Clawdbot version - graceful degradation
      console.log('[weave] llm_request hook not available (requires Clawdbot core update) - system prompt capture disabled');
      logger.info('[weave] llm_request hook not available - running without system prompt capture');
    }
  }

  // Tool call tracing hooks
  if (config.traceToolCalls) {
    console.log('[weave] Registering before_tool_call hook');
    api.on('before_tool_call', async (rawEvent, rawCtx) => {
      console.log('[weave] HOOK FIRED: before_tool_call');
      const event = rawEvent as ToolCallEvent;
      const ctx = rawCtx as ToolContext;
      console.log(`[weave] Tool call: ${event.toolName}`);

      try {
        const client = getWeaveClient();
        const sessionKey = ctx.sessionKey ?? 'unknown';
        const trace = client.getTrace(sessionKey);

        if (trace) {
          const span = client.startSpan(
            sessionKey,
            `tool:${event.toolName}`,
            { params: event.params },
            { toolName: event.toolName }
          );

          // Track span for this session
          const spans = toolSpans.get(sessionKey) ?? [];
          spans.push(span.id);
          toolSpans.set(sessionKey, spans);

          console.log(`[weave] Tool span started: ${span.id}`);
          logger.debug?.(`[weave] Tool call started: ${event.toolName}`);
        } else {
          console.log(`[weave] No trace found for tool call, sessionKey: ${sessionKey}`);
        }
      } catch (error) {
        console.error(`[weave] Failed to trace tool call: ${error}`);
        logger.error(`[weave] Failed to trace tool call: ${error}`);
      }

      // Return nothing - we don't block or modify
      return;
    });

    console.log('[weave] Registering after_tool_call hook');
    api.on('after_tool_call', async (rawEvent, rawCtx) => {
      console.log('[weave] HOOK FIRED: after_tool_call');
      const event = rawEvent as ToolCallEndEvent;
      const ctx = rawCtx as ToolContext;
      console.log(`[weave] Tool call ended: ${event.toolName} (${event.durationMs}ms)`);

      try {
        const client = getWeaveClient();
        const sessionKey = ctx.sessionKey ?? 'unknown';
        const trace = client.getTrace(sessionKey);

        if (trace?.activeSpan && trace.activeSpan.name === `tool:${event.toolName}`) {
          client.endSpan(
            trace.activeSpan,
            {
              result: event.result,
              durationMs: event.durationMs,
            },
            !event.error,
            event.error
          );

          // Pop span from stack
          const spans = toolSpans.get(sessionKey) ?? [];
          spans.pop();
          toolSpans.set(sessionKey, spans);

          console.log(`[weave] Tool span ended: ${event.toolName}`);
          logger.debug?.(`[weave] Tool call ended: ${event.toolName} (${event.durationMs}ms)`);
        } else {
          console.log(`[weave] No matching span for tool: ${event.toolName}`);
        }
      } catch (error) {
        console.error(`[weave] Failed to end tool trace: ${error}`);
        logger.error(`[weave] Failed to end tool trace: ${error}`);
      }
    });
  }

  // Message hooks for additional context
  api.on('message_received', async (rawEvent, _rawCtx) => {
    const event = rawEvent as MessageReceivedEvent;

    try {
      logger.debug?.(`[weave] Message received from: ${event.from}`);
    } catch (_error) {
      // Silently fail - message logging is optional
    }
  });

  api.on('message_sent', async (rawEvent, _rawCtx) => {
    const event = rawEvent as MessageSentEvent;

    try {
      logger.debug?.(`[weave] Message sent to: ${event.to}`);
    } catch (_error) {
      // Silently fail - message logging is optional
    }
  });
}
