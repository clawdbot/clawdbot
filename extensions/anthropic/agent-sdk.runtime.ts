import type {
  Options as ClaudeAgentSdkOptions,
  PermissionMode as ClaudeAgentSdkPermissionMode,
  PermissionResult as ClaudeAgentSdkPermissionResult,
  SDKUserMessage as ClaudeAgentSdkUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { CliBackendExecute, CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const CLAUDE_PERMISSION_MODES = new Set<ClaudeAgentSdkPermissionMode>([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);
const CLAUDE_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CLAUDE_STREAM_PROTOCOL_FLAGS = new Set([
  "-p",
  "--print",
  "--verbose",
  "--include-partial-messages",
]);
const CLAUDE_STREAM_PROTOCOL_VALUE_FLAGS = new Set([
  "--output-format",
  "--input-format",
  "--model",
  "--session-id",
  "--resume",
  "-r",
  "--append-system-prompt-file",
  "--append-system-prompt",
  "--system-prompt-file",
  "--system-prompt",
]);
const CLAUDE_VALUE_FLAGS = new Set([
  ...CLAUDE_STREAM_PROTOCOL_VALUE_FLAGS,
  "--setting-sources",
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--tools",
  "--permission-mode",
  "--effort",
  "--mcp-config",
  "--resume-session-at",
  "--max-turns",
  "--plugin-dir",
  "--plugin-dir-no-mcp",
]);

function splitClaudeToolNames(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function consumeClaudeOptionValue(params: {
  args: readonly string[];
  index: number;
  inlineValue: string | undefined;
  name: string;
}): { value: string; index: number } {
  if (params.inlineValue !== undefined) {
    return { value: params.inlineValue, index: params.index };
  }
  const value = params.args[params.index + 1];
  if (value === undefined) {
    throw new Error(`Claude Agent SDK cannot preserve ${params.name} without its value`);
  }
  return { value, index: params.index + 1 };
}

async function authorizeClaudeAgentSdkTool(params: {
  context: CliBackendExecuteContext;
  controller: AbortController;
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  toolUseId?: string;
}): Promise<ClaudeAgentSdkPermissionResult> {
  if (params.signal.aborted || params.controller.signal.aborted) {
    return { behavior: "deny", message: "The OpenClaw run is no longer active." };
  }
  try {
    const decision = await params.context.requestToolPermission({
      toolName: params.toolName,
      toolInput: params.input,
      ...(params.toolUseId ? { toolCallId: params.toolUseId } : {}),
      abortSignal: params.signal,
    });
    if (params.signal.aborted || params.controller.signal.aborted) {
      return { behavior: "deny", message: "The OpenClaw run is no longer active." };
    }
    return decision.behavior === "allow"
      ? { behavior: "allow", updatedInput: decision.updatedInput }
      : decision;
  } catch {
    return { behavior: "deny", message: "OpenClaw could not authorize this tool call." };
  }
}

function resolveClaudeAgentSdkOptions(
  context: CliBackendExecuteContext,
  abortController: AbortController,
): ClaudeAgentSdkOptions {
  const options: ClaudeAgentSdkOptions = {
    abortController,
    cwd: context.cwd,
    env: context.env,
    includePartialMessages: true,
    model: context.modelId,
    pathToClaudeCodeExecutable: context.command,
    permissionMode: "default",
    settingSources: ["user"],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: context.systemPrompt,
    },
    canUseTool: (toolName, input, request) =>
      authorizeClaudeAgentSdkTool({
        context,
        controller: abortController,
        toolName,
        input,
        signal: request.signal,
        toolUseId: request.toolUseID,
      }),
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input, toolUseId, request) => {
              if (input.hook_event_name !== "PreToolUse") {
                return {};
              }
              if (input.tool_name.startsWith("mcp__openclaw__")) {
                return { continue: true };
              }
              if (!isRecord(input.tool_input)) {
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: "OpenClaw rejected malformed native tool input.",
                  },
                };
              }
              // Settings-level allow rules run before canUseTool. A native
              // pre-tool hook keeps every action under its admitted run owner.
              const decision = await authorizeClaudeAgentSdkTool({
                context,
                controller: abortController,
                toolName: input.tool_name,
                input: input.tool_input,
                signal: request.signal,
                toolUseId: toolUseId ?? input.tool_use_id,
              });
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: decision.behavior,
                  ...(decision.behavior === "allow"
                    ? { updatedInput: decision.updatedInput }
                    : { permissionDecisionReason: decision.message }),
                },
              };
            },
          ],
        },
      ],
    },
  };

  if (context.useResume && context.sessionId) {
    options.resume = context.sessionId;
  } else if (context.sessionId) {
    options.sessionId = context.sessionId;
  }

  const allowedTools: string[] = [];
  const disallowedTools: string[] = [];
  const extraArgs: NonNullable<ClaudeAgentSdkOptions["extraArgs"]> = {};
  let excludeDynamicSystemPromptSections = false;

  for (let index = 0; index < context.args.length; index += 1) {
    const rawArgument = context.args[index] ?? "";
    const equalsIndex = rawArgument.indexOf("=");
    const argument = equalsIndex === -1 ? rawArgument : rawArgument.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : rawArgument.slice(equalsIndex + 1);

    if (CLAUDE_STREAM_PROTOCOL_FLAGS.has(argument)) {
      continue;
    }
    const consumed = CLAUDE_VALUE_FLAGS.has(argument)
      ? consumeClaudeOptionValue({
          args: context.args,
          index,
          inlineValue,
          name: argument,
        })
      : undefined;
    if (consumed) {
      index = consumed.index;
    }
    if (CLAUDE_STREAM_PROTOCOL_VALUE_FLAGS.has(argument)) {
      continue;
    }
    const value = consumed?.value ?? "";

    switch (argument) {
      case "--setting-sources": {
        if (value !== "" && value !== "user") {
          throw new Error("Claude Agent SDK settings must be limited to user settings.");
        }
        options.settingSources = value === "" ? [] : ["user"];
        break;
      }
      case "--allowedTools":
      case "--allowed-tools": {
        // SDK allowedTools grants automatic approval; native tools must always
        // remain behind the closure-bound OpenClaw permission callback.
        allowedTools.push(
          ...splitClaudeToolNames(value).filter((toolName) =>
            toolName.startsWith("mcp__openclaw__"),
          ),
        );
        break;
      }
      case "--disallowedTools":
      case "--disallowed-tools": {
        disallowedTools.push(...splitClaudeToolNames(value));
        break;
      }
      case "--tools": {
        options.tools = splitClaudeToolNames(value);
        break;
      }
      case "--permission-mode": {
        const permissionMode = value as ClaudeAgentSdkPermissionMode;
        if (!CLAUDE_PERMISSION_MODES.has(permissionMode)) {
          throw new Error(`Unsupported Claude Agent SDK permission mode: ${value}`);
        }
        // Global argv can request bypass, auto, or accepted edits while the
        // admitted session narrows authority. Only the host callback decides.
        break;
      }
      case "--effort": {
        if (!CLAUDE_EFFORT_LEVELS.has(value)) {
          throw new Error(`Unsupported Claude Agent SDK effort: ${value}`);
        }
        options.effort = value as NonNullable<ClaudeAgentSdkOptions["effort"]>;
        break;
      }
      case "--mcp-config": {
        // The generated config contains a private gateway bearer. Keep its
        // existing file boundary; SDK mcpServers would expose it in argv.
        extraArgs["mcp-config"] = value;
        break;
      }
      case "--strict-mcp-config":
        options.strictMcpConfig = true;
        break;
      case "--fork-session":
        options.forkSession = true;
        break;
      case "--resume-session-at": {
        options.resumeSessionAt = value;
        break;
      }
      case "--no-session-persistence":
        options.persistSession = false;
        break;
      case "--max-turns": {
        const maxTurns = Number(value);
        if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
          throw new Error(`Unsupported Claude Agent SDK max-turns value: ${value}`);
        }
        options.maxTurns = maxTurns;
        break;
      }
      case "--plugin-dir":
      case "--plugin-dir-no-mcp": {
        options.plugins ??= [];
        options.plugins.push({
          type: "local",
          path: value,
          ...(argument === "--plugin-dir-no-mcp" ? { skipMcpDiscovery: true } : {}),
        });
        break;
      }
      case "--exclude-dynamic-system-prompt-sections":
        excludeDynamicSystemPromptSections = true;
        break;
      default: {
        if (!argument.startsWith("--")) {
          throw new Error(`Claude Agent SDK cannot preserve positional argument: ${argument}`);
        }
        const name = argument.slice(2);
        if (inlineValue !== undefined) {
          extraArgs[name] = inlineValue;
          break;
        }
        const next = context.args[index + 1];
        if (next !== undefined && !next.startsWith("-")) {
          extraArgs[name] = next;
          index += 1;
        } else {
          extraArgs[name] = null;
        }
      }
    }
  }

  if (context.toolAvailability) {
    options.tools = [...context.toolAvailability.native];
    const approvedOpenClawTools = context.toolAvailability.openClaw.map(
      (toolName) => `mcp__openclaw__${toolName}`,
    );
    const authorizedOpenClawTools = new Set(allowedTools);
    options.allowedTools = approvedOpenClawTools.filter(
      (toolName) =>
        authorizedOpenClawTools.has(toolName) || authorizedOpenClawTools.has("mcp__openclaw__*"),
    );
  } else if (allowedTools.length > 0) {
    options.allowedTools = [...new Set(allowedTools)];
  }
  if (disallowedTools.length > 0) {
    options.disallowedTools = [...new Set(disallowedTools)];
  }
  if (Object.keys(extraArgs).length > 0) {
    options.extraArgs = extraArgs;
  }
  if (excludeDynamicSystemPromptSections) {
    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: context.systemPrompt,
      excludeDynamicSections: true,
    };
  }
  return options;
}

/** Execute an ambient Claude Code login through Anthropic's maintained SDK transport. */
export const executeClaudeAgentSdk: CliBackendExecute = async function* (context) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  context.abortSignal?.addEventListener("abort", abort, { once: true });
  if (context.abortSignal?.aborted) {
    abort();
  }

  let sawTerminalResult = false;
  try {
    const options = resolveClaudeAgentSdkOptions(context, abortController);
    const prompt = (async function* (): AsyncIterable<ClaudeAgentSdkUserMessage> {
      yield {
        type: "user",
        message: { role: "user", content: context.prompt },
        parent_tool_use_id: null,
        ...(context.sessionId ? { session_id: context.sessionId } : {}),
      };
    })();
    for await (const message of query({ prompt, options })) {
      if (message.type === "result") {
        sawTerminalResult = true;
      }
      yield { ...message };
    }
    if (!sawTerminalResult && !abortController.signal.aborted) {
      throw new Error("Claude Agent SDK exited without a terminal result.");
    }
  } finally {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
    context.abortSignal?.removeEventListener("abort", abort);
  }
};
