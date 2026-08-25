import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import type {
  Options as ClaudeAgentSdkOptions,
  PermissionResult as ClaudeAgentSdkPermissionResult,
  Query as ClaudeAgentSdkQuery,
  SpawnOptions as ClaudeAgentSdkSpawnOptions,
  SpawnedProcess as ClaudeAgentSdkSpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionCloseReason,
  CliBackendLiveSessionHandle,
} from "openclaw/plugin-sdk/cli-backend";
import { killProcessTree } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createClaudeAgentSdkUserMessage,
  splitClaudeToolNames,
} from "./agent-sdk-runtime-helpers.js";
import { createClaudeAgentSdkUserInputAuthorizer } from "./agent-sdk-user-input.js";

const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] satisfies NonNullable<
  ClaudeAgentSdkOptions["effort"]
>[];
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
  "--add-dir",
  "--permission-mode",
  "--effort",
  "--mcp-config",
  "--resume-session-at",
  "--max-turns",
  "--plugin-dir",
  "--plugin-dir-no-mcp",
]);
const CLAUDE_VARIADIC_VALUE_FLAGS = new Set([
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--tools",
  "--add-dir",
]);
const CLAUDE_LIVE_IDLE_TIMEOUT_MS = 10 * 60 * 1_000;
const RESULT_HOLDING_BACKGROUND_TASK_TYPES = new Set(["local_agent", "local_workflow"]);

type ClaudeAgentSdkSecretInput = {
  fd: 3;
  createData: () => Buffer;
};

type ClaudeAgentSdkTurn = {
  context: CliBackendExecuteContext;
  controller: AbortController;
  userInput: ReturnType<typeof createClaudeAgentSdkUserInputAuthorizer>;
};

type ClaudeAgentSdkLiveTurn = ClaudeAgentSdkTurn & {
  events: PassThrough;
  sawTerminalResult: boolean;
  error?: Error;
};

type ClaudeAgentSdkSession = {
  handle: CliBackendLiveSessionHandle;
  capability: CliBackendLiveSessionCapability;
  controller: AbortController;
  prompts: PassThrough;
  currentTurn?: ClaudeAgentSdkLiveTurn;
  query?: ClaudeAgentSdkQuery;
  idleTimer?: ReturnType<typeof setTimeout>;
  hasResultHoldingBackgroundTasks: boolean;
  closed: boolean;
  resolveExit: () => void;
  exited: Promise<void>;
};

const claudeAgentSdkSessions = new WeakMap<CliBackendLiveSessionHandle, ClaudeAgentSdkSession>();

function spawnClaudeAgentSdkProcess(
  options: ClaudeAgentSdkSpawnOptions,
  secretInput?: ClaudeAgentSdkSecretInput,
): ClaudeAgentSdkSpawnedProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.env,
    signal: options.signal,
    stdio: secretInput
      ? ["pipe", "pipe", "pipe", process.platform === "win32" ? "overlapped" : "pipe"]
      : ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // The SDK only drains stderr for its built-in spawner; unread custom pipes
  // fill at 64 KiB and deadlock credential-backed Claude processes.
  child.stderr.resume();
  const killChild = child.kill.bind(child);
  child.kill = (signal?: NodeJS.Signals | number) => {
    if (!child.pid || (signal !== undefined && signal !== "SIGTERM" && signal !== "SIGKILL")) {
      return killChild(signal);
    }
    // Windows must enumerate descendants before the root disappears; POSIX
    // children own a detached group so cancellation never reaches the host.
    killProcessTree(child.pid, {
      detached: process.platform !== "win32",
      ...(signal === "SIGKILL" ? { force: true } : {}),
    });
    return true;
  };
  if (!secretInput) {
    return child;
  }
  let credential: Buffer | undefined;
  try {
    const descriptor = child.stdio[secretInput.fd];
    if (!(descriptor instanceof Writable)) {
      throw new Error(`Claude Agent SDK secret descriptor ${secretInput.fd} is unavailable.`);
    }
    credential = secretInput.createData();
    const rejectDelivery = () => {
      credential?.fill(0);
      child.kill();
    };
    descriptor.on("error", rejectDelivery);
    descriptor.once("close", () => descriptor.off("error", rejectDelivery));
    descriptor.end(credential, (error?: Error | null) => {
      credential?.fill(0);
      if (error) {
        child.kill();
      }
    });
    return child;
  } catch (error) {
    credential?.fill(0);
    child.kill();
    throw error;
  }
}

async function authorizeClaudeAgentSdkTool(params: {
  currentTurn: () => ClaudeAgentSdkTurn | undefined;
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  toolUseId?: string;
}): Promise<ClaudeAgentSdkPermissionResult> {
  const turn = params.currentTurn();
  if (!turn || params.signal.aborted || turn.controller.signal.aborted) {
    return { behavior: "deny", message: "The OpenClaw run is no longer active." };
  }
  try {
    const decision =
      params.toolName === "AskUserQuestion"
        ? await turn.userInput.authorize({
            input: params.input,
            signal: params.signal,
            ...(params.toolUseId ? { toolUseId: params.toolUseId } : {}),
          })
        : await turn.context.requestToolPermission({
            toolName: params.toolName,
            toolInput: params.input,
            ...(params.toolUseId ? { toolCallId: params.toolUseId } : {}),
            abortSignal: params.signal,
          });
    if (params.currentTurn() !== turn || params.signal.aborted || turn.controller.signal.aborted) {
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
  currentTurn: () => ClaudeAgentSdkTurn | undefined,
  secretInput?: ClaudeAgentSdkSecretInput,
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
    spawnClaudeCodeProcess: (spawnOptions) => spawnClaudeAgentSdkProcess(spawnOptions, secretInput),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: context.systemPrompt,
    },
    canUseTool: (toolName, input, request) =>
      authorizeClaudeAgentSdkTool({
        currentTurn,
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
                currentTurn,
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
    let value = inlineValue ?? "";
    if (CLAUDE_VALUE_FLAGS.has(argument) && inlineValue === undefined) {
      const next = context.args[index + 1];
      if (next === undefined) {
        throw new Error(`Claude Agent SDK cannot preserve ${argument} without its value`);
      }
      value = next;
      index += 1;
    }
    const values = [value];
    if (CLAUDE_VARIADIC_VALUE_FLAGS.has(argument) && inlineValue === undefined) {
      while (index + 1 < context.args.length && !context.args[index + 1]?.startsWith("-")) {
        values.push(context.args[index + 1] ?? "");
        index += 1;
      }
    }
    if (CLAUDE_STREAM_PROTOCOL_VALUE_FLAGS.has(argument)) {
      continue;
    }

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
          ...values
            .flatMap(splitClaudeToolNames)
            .filter((toolName) => toolName.startsWith("mcp__openclaw__")),
        );
        break;
      }
      case "--disallowedTools":
      case "--disallowed-tools": {
        disallowedTools.push(...values.flatMap(splitClaudeToolNames));
        break;
      }
      case "--tools": {
        options.tools = values.flatMap(splitClaudeToolNames);
        break;
      }
      case "--add-dir": {
        options.additionalDirectories ??= [];
        options.additionalDirectories.push(...values);
        break;
      }
      case "--permission-mode": {
        // Global argv can request bypass, auto, or accepted edits while the
        // admitted session narrows authority. Only the host callback decides.
        break;
      }
      case "--effort": {
        const effort = CLAUDE_EFFORT_LEVELS.find((level) => level === value);
        if (!effort) {
          throw new Error(`Unsupported Claude Agent SDK effort: ${value}`);
        }
        options.effort = effort;
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

function closeClaudeAgentSdkSession(
  session: ClaudeAgentSdkSession,
  _reason: CliBackendLiveSessionCloseReason,
  error?: unknown,
): void {
  if (session.closed) {
    return;
  }
  session.closed = true;
  clearTimeout(session.idleTimer);
  session.capability.remove(session.handle);

  const turn = session.currentTurn;
  session.currentTurn = undefined;
  if (turn) {
    turn.error =
      error instanceof Error ? error : new Error("Claude Agent SDK live session closed.");
    turn.controller.abort();
    turn.events.end();
  }
  session.controller.abort();
  session.prompts.end();
  session.query?.close();
  if (!session.query) {
    session.resolveExit();
  }
}

function completeClaudeAgentSdkTurn(session: ClaudeAgentSdkSession): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  session.currentTurn = undefined;
  turn.controller.abort();
  turn.events.end();
  session.idleTimer = setTimeout(() => {
    session.handle.close("idle");
  }, CLAUDE_LIVE_IDLE_TIMEOUT_MS);
  session.idleTimer.unref();
}

function acceptClaudeAgentSdkMessage(
  session: ClaudeAgentSdkSession,
  message: Record<string, unknown>,
): void {
  const turn = session.currentTurn;
  if (!turn) {
    return;
  }
  if (message.type === "system" && message.subtype === "background_tasks_changed") {
    session.hasResultHoldingBackgroundTasks = (
      Array.isArray(message.tasks) ? message.tasks : []
    ).some(
      (task) =>
        isRecord(task) &&
        typeof task.task_type === "string" &&
        RESULT_HOLDING_BACKGROUND_TASK_TYPES.has(task.task_type) &&
        typeof task.task_id === "string" &&
        task.task_id.length > 0,
    );
  }
  turn.events.write(message);
  if (message.type === "result") {
    turn.sawTerminalResult = true;
    // Local agents/workflows emit an interim result before their final
    // answer; keep the turn and capture grant alive until its final result.
    if (!session.hasResultHoldingBackgroundTasks) {
      completeClaudeAgentSdkTurn(session);
    }
  }
}

async function consumeClaudeAgentSdkSession(
  session: ClaudeAgentSdkSession,
  query: ClaudeAgentSdkQuery,
): Promise<void> {
  try {
    for await (const message of query) {
      acceptClaudeAgentSdkMessage(session, { ...message });
    }
    if (!session.closed) {
      const error = new Error("Claude Agent SDK live session exited unexpectedly.");
      session.handle.close("abort", error);
    }
  } catch (error) {
    if (!session.closed) {
      session.handle.close("abort", error);
    }
  } finally {
    session.resolveExit();
  }
}

function createClaudeAgentSdkSession(
  capability: CliBackendLiveSessionCapability,
): ClaudeAgentSdkSession {
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const session: ClaudeAgentSdkSession = {
    capability,
    controller: new AbortController(),
    prompts: new PassThrough({ objectMode: true }),
    hasResultHoldingBackgroundTasks: false,
    closed: false,
    resolveExit,
    exited,
    handle: {
      generation: randomUUID(),
      fingerprint: capability.fingerprint,
      isIdle: () => !session.closed && !session.currentTurn,
      close: (reason, error) => closeClaudeAgentSdkSession(session, reason, error),
      waitForExit: () => session.exited,
    },
  };
  claudeAgentSdkSessions.set(session.handle, session);
  capability.register(session.handle);
  return session;
}

async function* executeClaudeAgentSdkLiveTurn(
  context: CliBackendExecuteContext,
  capability: CliBackendLiveSessionCapability,
  secretInput?: ClaudeAgentSdkSecretInput,
): AsyncIterable<Record<string, unknown>> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  let existingHandle = capability.current();
  if (existingHandle && existingHandle.fingerprint !== capability.fingerprint) {
    existingHandle.close("restart");
    await existingHandle.waitForExit();
    existingHandle = capability.current();
  }

  let session = existingHandle ? claudeAgentSdkSessions.get(existingHandle) : undefined;
  if (existingHandle && (!session || session.closed)) {
    existingHandle.close("restart");
    await existingHandle.waitForExit();
    session = undefined;
  }
  session ??= createClaudeAgentSdkSession(capability);
  session.capability = capability;
  if (session.currentTurn) {
    throw new Error("Claude Agent SDK live session is already handling another turn.");
  }
  clearTimeout(session.idleTimer);

  const turn: ClaudeAgentSdkLiveTurn = {
    context,
    controller: new AbortController(),
    userInput: createClaudeAgentSdkUserInputAuthorizer(context),
    events: new PassThrough({ objectMode: true }),
    sawTerminalResult: false,
  };
  session.currentTurn = turn;
  const abort = () => session.handle.close("abort", context.abortSignal?.reason);
  context.abortSignal?.addEventListener("abort", abort, { once: true });

  try {
    if (context.abortSignal?.aborted) {
      abort();
      throw context.abortSignal.reason ?? new Error("Claude Agent SDK live turn was aborted.");
    }
    // Capture activation adopts this admitted turn onto the exact registered
    // process bearer before either its prompt or any tool call can execute.
    capability.activate(session.handle);

    if (!session.query) {
      const options = resolveClaudeAgentSdkOptions(
        context,
        session.controller,
        () => session.currentTurn,
        secretInput,
      );
      session.query = query({ prompt: session.prompts, options });
      void consumeClaudeAgentSdkSession(session, session.query);
    }
    if (session.closed || session.currentTurn !== turn) {
      throw new Error("Claude Agent SDK live session closed before its prompt was accepted.");
    }
    session.prompts.write(createClaudeAgentSdkUserMessage(context));

    for await (const record of turn.events) {
      yield record;
    }
    if (turn.error) {
      throw turn.error;
    }
    if (!turn.sawTerminalResult) {
      throw new Error("Claude Agent SDK live turn exited without a terminal result.");
    }
  } catch (error) {
    if (!session.closed) {
      session.handle.close("abort", error);
    }
    throw error;
  } finally {
    turn.controller.abort();
    context.abortSignal?.removeEventListener("abort", abort);
  }
}

export async function* executeClaudeAgentSdk(
  context: CliBackendExecuteContext,
  secretInput?: ClaudeAgentSdkSecretInput,
): AsyncIterable<Record<string, unknown>> {
  if (context.liveSession) {
    yield* executeClaudeAgentSdkLiveTurn(context, context.liveSession, secretInput);
    return;
  }

  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const controller = new AbortController();
  let activeTurn: ClaudeAgentSdkTurn | undefined = {
    context,
    controller,
    userInput: createClaudeAgentSdkUserInputAuthorizer(context),
  };
  let sawTerminalResult = false;
  const abort = () => controller.abort();
  context.abortSignal?.addEventListener("abort", abort, { once: true });

  try {
    context.abortSignal?.throwIfAborted();
    const options = resolveClaudeAgentSdkOptions(
      context,
      controller,
      () => activeTurn,
      secretInput,
    );
    for await (const message of query({ prompt: context.prompt, options })) {
      if (message.type === "result") {
        sawTerminalResult = true;
      }
      yield { ...message };
    }
    if (!sawTerminalResult && !controller.signal.aborted) {
      throw new Error("Claude Agent SDK exited without a terminal result.");
    }
  } finally {
    activeTurn = undefined;
    if (!controller.signal.aborted) {
      controller.abort();
    }
    context.abortSignal?.removeEventListener("abort", abort);
  }
}
