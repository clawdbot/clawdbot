import { extractShellWrapperInlineCommand } from "../infra/shell-wrapper-resolution.js";
import { splitShellArgs } from "../utils/shell-argv.js";

// Codex 0.144.6 retains at most 1 MiB per exec stream. Leave headroom so this
// soak measures compaction behavior instead of the dependency's output boundary.
export const CODEX_HARNESS_MAX_LARGE_OUTPUT_BYTES = 800_000;

/**
 * Text matchers shared by live Codex harness tests.
 *
 * The live CLI can answer with model lists, status cards, or sandbox fallback
 * text depending on the host, so tests assert accepted response families here.
 */
export const EXPECTED_CODEX_MODELS_COMMAND_TEXT = [
  "Codex models:",
  "Available Codex models",
  "Available Codex agent model",
  "Available Codex agent models",
  "Available models:",
  "Available models, local cache:",
  "Available agent target:",
  "Available agent targets:",
  "Available agent IDs in this session:",
  "opened an interactive trust prompt",
  "opened an interactive model-selection prompt",
  "running as Codex on `openai/",
  "running as Codex on `codex/",
  "currently running on `openai/",
  "currently running on `codex/",
  "stdin is not a terminal",
  "The local `codex models` entrypoint is interactive in this environment",
  "`codex models` did not run in this environment.",
  "`codex models` failed in this sandbox",
  "`codex models` could not be run in this sandbox.",
  "`codex models` is not runnable in this sandboxed session.",
  "`codex` is not installed on the shell PATH in this environment.",
  "`codex` is not installed in the shell environment",
  "`codex models` didn’t return a plain list in this environment",
  "I couldn’t get a direct `codex models` CLI listing because the local sandbox blocked that command.",
  "I couldn’t get `/codex models` from the shell here.",
  "I couldn’t list all installed/available Codex models from the local CLI because the sandboxed `codex` command failed to start in this environment.",
  "I couldn’t get `codex models` from the CLI because the sandbox blocks the namespace setup it needs",
  "I can only see the current session model from this environment",
  "Available in this session:",
  "Available here:",
  "Available models in this session:",
  "Available models in this environment:",
  "Available models in this Codex environment:",
  "Available models in this Codex install",
  "Available model overrides:",
  "Available model overrides exposed in this session",
  "Available model overrides here:",
  "Available model overrides listed for this session:",
  "Available model overrides listed in this session:",
  "Available model overrides shown in this session:",
  "Available model overrides in this session:",
  "Available agent models:",
  "Visible options in this session:",
  "Current: `openai/",
  "Current: `codex/",
  "Current model:",
  "Current model: `openai/",
  "Current model: `codex/",
  "Current model is `openai/",
  "Current model is `codex/",
  "Current session model: `openai/",
  "Current session model: `codex/",
  "Current session model is `openai/",
  "Current session model is `codex/",
  "Visible session model:",
  "The current session is using `openai/",
  "The current session is using `codex/",
  "current session is using `openai/",
  "current session is using `codex/",
  "Configured model from `~/.codex/config.toml`:",
  "Configured models in this session:",
  "Default model:",
  "This harness is configured with a single Codex model: `openai/",
  "This harness is configured with a single Codex model: `codex/",
  "Primary model: `openai/",
  "Primary model: `codex/",
  "Registered models: `openai/",
  "Registered models: `codex/",
  "Active model: `openai/",
  "Active model: `codex/",
  "Current active model is `openai/",
  "Current active model is `codex/",
  "Current OpenClaw session status reports the active model as:",
] as const;

export function shouldUseCodexHarnessSubagentOnlyFastPath(params: {
  chatImageProbe: boolean;
  codeModeOnly: boolean;
  compactionStress: boolean;
  explicitOptOut: boolean;
  guardianProbe: boolean;
  imageProbe: boolean;
  mcpProbe: boolean;
  resumeStress: boolean;
  subagentProbe: boolean;
}): boolean {
  return (
    params.subagentProbe &&
    !params.chatImageProbe &&
    !params.codeModeOnly &&
    !params.compactionStress &&
    !params.guardianProbe &&
    !params.imageProbe &&
    !params.mcpProbe &&
    !params.resumeStress &&
    !params.explicitOptOut
  );
}

type CodexHarnessToolEventData = {
  args?: unknown;
  isError?: unknown;
  itemId?: unknown;
  name?: unknown;
  phase?: unknown;
  result?: unknown;
  status?: unknown;
};

function readCodexHarnessToolEventData(event: unknown): CodexHarnessToolEventData | undefined {
  if (!event || typeof event !== "object" || (event as { stream?: unknown }).stream !== "tool") {
    return undefined;
  }
  const data = (event as { data?: unknown }).data;
  return data && typeof data === "object" ? (data as CodexHarnessToolEventData) : undefined;
}

function summarizeNativeCommandResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    return { type: result === null ? "null" : typeof result };
  }
  const record = result as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["exitCode", "durationMs", "status"] as const) {
    const value = record[key];
    if (typeof value === "number" || typeof value === "boolean") {
      summary[key] = value;
    }
  }
  for (const key of ["stdout", "stderr", "output", "aggregatedOutput"] as const) {
    const value = record[key];
    if (typeof value === "string") {
      summary[`${key}Chars`] = value.length;
    }
  }
  return summary;
}

function shellArgvMatches(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((arg, index) => arg === expected[index]);
}

export function isExpectedNativeCommand(command: string, expectedCommand: string): boolean {
  const commandArgv = splitShellArgs(command);
  const expectedArgv = splitShellArgs(expectedCommand);
  if (!commandArgv || !expectedArgv) {
    return false;
  }
  if (shellArgvMatches(commandArgv, expectedArgv)) {
    return true;
  }
  const wrappedCommand = extractShellWrapperInlineCommand(commandArgv);
  const wrappedArgv = wrappedCommand ? splitShellArgs(wrappedCommand) : null;
  return wrappedArgv ? shellArgvMatches(wrappedArgv, expectedArgv) : false;
}

export function buildCodexHarnessAppServerArgs(overrides: readonly string[]): string[] {
  return ["app-server", "--listen", "stdio://", ...overrides.flatMap((value) => ["-c", value])];
}

export function buildCodexHarnessLargeOutputCommand(params: {
  commandMarker: string;
  outputBytes: number;
}): string {
  if (!/^[A-Z0-9-]+$/u.test(params.commandMarker)) {
    throw new Error(
      "large-output command marker must contain only uppercase letters, digits, and hyphens",
    );
  }
  if (!Number.isSafeInteger(params.outputBytes) || params.outputBytes <= 0) {
    throw new Error("large-output byte count must be a positive safe integer");
  }
  const filler = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  return `node -e 'const p="${filler}";process.stdout.write(("${params.commandMarker}|"+p.repeat(Math.ceil(${params.outputBytes}/p.length))).slice(0,${params.outputBytes}))'`;
}

/** Requires one successful native bash execution carrying the per-turn command marker. */
export function requireSuccessfulNativeCommandExecution(
  events: readonly unknown[],
  params: { commandMarker: string; expectedCommand: string },
): { itemId: string; resultIndex: number; startIndex: number } {
  const starts = events.flatMap((event, startIndex) => {
    const data = readCodexHarnessToolEventData(event);
    if (data?.phase !== "start" || data.name !== "bash" || !data.args) {
      return [];
    }
    const command = (data.args as { command?: unknown }).command;
    const matches =
      typeof command === "string" &&
      command.includes(params.commandMarker) &&
      isExpectedNativeCommand(command, params.expectedCommand);
    return matches ? [{ itemId: data.itemId, startIndex }] : [];
  });
  if (starts.length === 0) {
    throw new Error(`missing native bash command start for marker ${params.commandMarker}`);
  }

  const validStarts = starts.filter(
    (start): start is { itemId: string; startIndex: number } =>
      typeof start.itemId === "string" && start.itemId.length > 0,
  );
  if (validStarts.length === 0) {
    throw new Error(`native bash command start for marker ${params.commandMarker} has no itemId`);
  }

  for (const { itemId, startIndex } of validStarts) {
    const resultIndex = events.findIndex((event, index) => {
      const data = readCodexHarnessToolEventData(event);
      const result = data?.result;
      return (
        index > startIndex &&
        data?.phase === "result" &&
        data.itemId === itemId &&
        data.status === "completed" &&
        data.isError === false &&
        result !== null &&
        typeof result === "object" &&
        // App-server commandExecution.exitCode is optional and nullable. Completed +
        // !isError is authoritative when Codex omits it; a present nonzero code still fails.
        ((result as { exitCode?: unknown }).exitCode === undefined ||
          (result as { exitCode?: unknown }).exitCode === null ||
          (result as { exitCode?: unknown }).exitCode === 0)
      );
    });
    if (resultIndex >= 0) {
      return { itemId, resultIndex, startIndex };
    }
  }

  const startByItemId = new Map(validStarts.map((start) => [start.itemId, start.startIndex]));
  const observedResults = events.flatMap((event, index) => {
    const data = readCodexHarnessToolEventData(event);
    const startIndex =
      typeof data?.itemId === "string" ? startByItemId.get(data.itemId) : undefined;
    if (
      startIndex === undefined ||
      index <= startIndex ||
      data?.phase !== "result" ||
      typeof data.itemId !== "string"
    ) {
      return [];
    }
    return [
      {
        index,
        phase: data.phase,
        itemId: data.itemId,
        status: data.status,
        isError: data.isError,
        result: summarizeNativeCommandResult(data.result),
      },
    ];
  });
  throw new Error(
    `native bash command ${validStarts.map((start) => start.itemId).join(",")} for marker ${params.commandMarker} has no successful result; observed=${JSON.stringify(observedResults)}`,
  );
}

const HEALTHY_CODEX_MODELS_COMMAND_TEXT = [
  "Codex models:",
  "Available Codex models",
  "Available models:",
  "Available models, local cache:",
  "Available agent target:",
  "Available agent targets:",
  "Available agent IDs in this session:",
  "running as Codex on `openai/",
  "running as Codex on `codex/",
  "currently running on `openai/",
  "currently running on `codex/",
  "I can only see the current session model from this environment",
  "Available in this session:",
  "Available here:",
  "Available models in this session:",
  "Available models in this environment:",
  "Available models in this Codex environment:",
  "Available models in this Codex install",
  "Available model overrides:",
  "Available model overrides exposed in this session",
  "Available model overrides here:",
  "Available model overrides listed for this session:",
  "Available model overrides listed in this session:",
  "Available model overrides shown in this session:",
  "Available model overrides in this session:",
  "Available agent models:",
  "Visible options in this session:",
  "Current: `openai/",
  "Current: `codex/",
  "Current model:",
  "Current model: `openai/",
  "Current model: `codex/",
  "Current model is `openai/",
  "Current model is `codex/",
  "Current session model: `openai/",
  "Current session model: `codex/",
  "Current session model is `openai/",
  "Current session model is `codex/",
  "Visible session model:",
  "The current session is using `openai/",
  "The current session is using `codex/",
  "current session is using `openai/",
  "current session is using `codex/",
  "Configured model from `~/.codex/config.toml`:",
  "Configured models in this session:",
  "Default model:",
  "This harness is configured with a single Codex model: `openai/",
  "This harness is configured with a single Codex model: `codex/",
  "Primary model: `openai/",
  "Primary model: `codex/",
  "Registered models: `openai/",
  "Registered models: `codex/",
  "Active model: `openai/",
  "Active model: `codex/",
  "Current active model is `openai/",
  "Current active model is `codex/",
  "Current OpenClaw session status reports the active model as:",
] as const;

/** Accepted `/codex status` response fragments for live harness probes. */
export const EXPECTED_CODEX_STATUS_COMMAND_TEXT = [
  "Codex app-server:",
  "Model: `codex/",
  "Model: codex/",
  "Session: `agent:dev:live-codex-harness`",
  "Session: agent:dev:live-codex-harness",
  "OpenClaw `",
  "OpenClaw status:",
  "Status: running on",
  "model `codex/",
  "session `agent:dev:live-codex-harness`",
  "Model/status card shown above",
  "OpenClaw status shown above.",
  "Status shown above.",
  "No active task is running.",
  "No active work is running.",
  "Working normally.",
  "Idle and ready.",
  "Ready.",
] as const;

/** Returns true when text matches a known healthy Codex status response shape. */
export function isExpectedCodexStatusCommandText(text: string): boolean {
  const normalized = text.toLowerCase();
  const mentionsOpenClawStatus =
    normalized.includes("openclaw is running on") ||
    /openclaw\s+\S+\s+is running on/u.test(normalized) ||
    normalized.includes("openclaw status:") ||
    normalized.includes("status: running on") ||
    normalized.includes("session status: running on");
  const mentionsHarnessSession =
    normalized.includes("session: `agent:dev:live-codex-harness`") ||
    normalized.includes("session: agent:dev:live-codex-harness") ||
    normalized.includes("session is `agent:dev:live-codex-harness`") ||
    normalized.includes("session is agent:dev:live-codex-harness") ||
    normalized.includes("session `agent:dev:live-codex-harness`") ||
    normalized.includes("current session is `agent:dev:live-codex-harness`") ||
    normalized.includes("current session is agent:dev:live-codex-harness") ||
    normalized.includes("session context is healthy") ||
    normalized.includes("session is healthy:") ||
    ((normalized.includes("session context") || normalized.includes("context is at")) &&
      normalized.includes("active task: `/codex status`"));
  const mentionsModel =
    normalized.includes("`openai/") ||
    normalized.includes(" openai/") ||
    normalized.includes("`codex/") ||
    normalized.includes(" codex/");
  const isCurrentSessionStatus =
    normalized.includes("current session status:") &&
    normalized.includes("runtime: `openai codex`") &&
    mentionsModel;
  const isCompactSessionStatus =
    normalized.includes("session status: running on") &&
    normalized.includes("context at") &&
    mentionsModel;
  const isRunningSessionStatus =
    normalized.includes("session is running on") &&
    (normalized.includes("context used") ||
      normalized.includes("context is about") ||
      normalized.includes("context is at")) &&
    normalized.includes("no compactions") &&
    (normalized.includes("current session is") || normalized.includes("cache hit")) &&
    mentionsModel;
  const isWorkspaceOnlyHealthyStatus =
    normalized.includes("working normally.") && normalized.includes("current workspace:");
  const isIdleReadyStatus = normalized.includes("idle and ready");
  const isReadyStatus = normalized.trim() === "ready.";
  const isOnlineIdleStatus =
    normalized.includes("online") && normalized.includes("no active task is running");

  return (
    isCurrentSessionStatus ||
    isCompactSessionStatus ||
    isRunningSessionStatus ||
    isWorkspaceOnlyHealthyStatus ||
    isIdleReadyStatus ||
    isReadyStatus ||
    isOnlineIdleStatus ||
    (mentionsOpenClawStatus && mentionsHarnessSession && mentionsModel)
  );
}

/** Returns true when text matches a known Codex model-list or fallback shape. */
export function isExpectedCodexModelsCommandText(text: string): boolean {
  const normalized = text.toLowerCase();
  const mentionsCodexModelsCommand =
    text.includes("`codex models`") || text.includes("`/codex models`");
  const mentionsModelIdentifier =
    /(?:^|[\s`])(?:openai|codex)\/[a-z0-9][a-z0-9._-]*/iu.test(text) ||
    /\b(?:gpt|o[0-9]+|claude|sonnet)-[a-z0-9][a-z0-9._-]*/iu.test(text);
  const isHealthyExpectedModelEvidence =
    mentionsModelIdentifier &&
    HEALTHY_CODEX_MODELS_COMMAND_TEXT.some((expectedText) => text.includes(expectedText));
  const isSandboxFallback =
    mentionsCodexModelsCommand &&
    (normalized.includes("did not run") ||
      normalized.includes("could not run") ||
      normalized.includes("could not be run") ||
      normalized.includes("failed in this sandbox") ||
      normalized.includes("failed because") ||
      normalized.includes("failed with:") ||
      normalized.includes("fails to start") ||
      normalized.includes("repo-local fallback") ||
      normalized.includes("sandbox blocks") ||
      normalized.includes("sandbox blocked") ||
      normalized.includes("approval review failed") ||
      normalized.includes("failed before it could be approved") ||
      ((normalized.includes("rejected") || normalized.includes("not approved")) &&
        (normalized.includes("sandbox") ||
          normalized.includes("permission") ||
          normalized.includes("permissions") ||
          normalized.includes("escalation") ||
          normalized.includes("elevated execution"))) ||
      normalized.includes("interactive in this environment") ||
      normalized.includes("dropped into the interactive ui") ||
      normalized.includes("does not provide a separate non-interactive") ||
      (normalized.includes("not installed") &&
        normalized.includes("path") &&
        (normalized.includes("codex cli") || normalized.includes("`codex`"))) ||
      normalized.includes("not installed on the shell path") ||
      normalized.includes("sandboxed session") ||
      normalized.includes("command not found") ||
      normalized.includes("not installed") ||
      normalized.includes("required user namespace") ||
      normalized.includes("unprivileged user namespaces") ||
      normalized.includes("user-namespace restriction") ||
      normalized.includes("bwrap: no permissions to create a new namespace"));

  const mentionsConfiguredModels =
    normalized.includes("configured model") ||
    normalized.includes("configured codex model") ||
    normalized.includes("configured models");
  const mentionsSessionModel =
    normalized.includes("current session is using") ||
    normalized.includes("current session model") ||
    normalized.includes("current session model from openclaw status") ||
    normalized.includes("visible session model") ||
    normalized.includes("the current session is using");
  const mentionsConfigSummary =
    normalized.includes("default model") ||
    normalized.includes("primary model") ||
    normalized.includes("registered models") ||
    normalized.includes("only listed model") ||
    normalized.includes("single codex model") ||
    normalized.includes("live openclaw config shows") ||
    normalized.includes("current gateway config");
  const isSessionConfigFallback =
    mentionsModelIdentifier &&
    ((mentionsConfiguredModels && mentionsSessionModel) ||
      (mentionsConfigSummary && (mentionsConfiguredModels || mentionsSessionModel)));

  const mentionsInteractiveSelection =
    normalized.includes("interactive model-selection prompt") ||
    normalized.includes("interactive model selection prompt") ||
    normalized.includes("interactive tui");
  const mentionsVisibleOptions =
    normalized.includes("visible options in this session:") ||
    normalized.includes("visible options:") ||
    normalized.includes("available codex agent model:") ||
    normalized.includes("available codex agent models:") ||
    normalized.includes("available model overrides listed for this session:") ||
    normalized.includes("available model overrides listed in this session:") ||
    normalized.includes("available model overrides shown in this session:") ||
    normalized.includes("available here:") ||
    normalized.includes("available agent ids in this session:");
  const mentionsCurrentActiveModel =
    normalized.includes("current active model is `openai/") ||
    normalized.includes("current active model is openai/") ||
    normalized.includes("current active model is `codex/") ||
    normalized.includes("current active model is codex/");
  const mentionsCurrentSelectedModel =
    normalized.includes("current selected model:") ||
    normalized.includes("currently selected model:");
  const isInteractiveSelectionSummary =
    text.includes("`/codex models`") &&
    mentionsInteractiveSelection &&
    mentionsVisibleOptions &&
    mentionsCurrentActiveModel;
  const isAgentIdModelSummary =
    normalized.includes("available agent ids in this session:") && mentionsModelIdentifier;
  const isCodexAgentModelSummary =
    (normalized.includes("available codex agent model:") ||
      normalized.includes("available codex agent models:")) &&
    mentionsModelIdentifier;
  const isAvailableHereModelSummary =
    normalized.includes("available here:") &&
    normalized.includes("current session model") &&
    mentionsModelIdentifier;
  const isInteractiveTuiSummary =
    mentionsCodexModelsCommand &&
    mentionsInteractiveSelection &&
    normalized.includes("plain list") &&
    mentionsCurrentSelectedModel;
  const isLiteralModelList =
    mentionsModelIdentifier &&
    (normalized.includes("codex models:") ||
      normalized.includes("available codex models") ||
      normalized.includes("available models:") ||
      normalized.includes("available models, local cache:") ||
      normalized.includes("available agent target:") ||
      normalized.includes("available agent targets:"));
  const isCurrentModelSummary =
    mentionsModelIdentifier &&
    (normalized.includes("current:") ||
      normalized.includes("current model:") ||
      normalized.includes("current model is") ||
      normalized.includes("active model:") ||
      normalized.includes("current active model is") ||
      normalized.includes("visible session model:"));

  return (
    isSandboxFallback ||
    isHealthyExpectedModelEvidence ||
    isLiteralModelList ||
    isCurrentModelSummary ||
    isSessionConfigFallback ||
    isInteractiveSelectionSummary ||
    isAgentIdModelSummary ||
    isCodexAgentModelSummary ||
    isAvailableHereModelSummary ||
    isInteractiveTuiSummary
  );
}

function isUnavailableCodexModelsCommandText(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("did not run") ||
    normalized.includes("could not run") ||
    normalized.includes("could not be run") ||
    normalized.includes("couldn't run") ||
    normalized.includes("couldn’t run") ||
    normalized.includes("couldn't get") ||
    normalized.includes("couldn’t get") ||
    normalized.includes("couldn't list") ||
    normalized.includes("couldn’t list") ||
    normalized.includes("couldn't inspect") ||
    normalized.includes("couldn’t inspect") ||
    normalized.includes("didn't return a plain list") ||
    normalized.includes("didn’t return a plain list") ||
    normalized.includes("failed in this sandbox") ||
    normalized.includes("failed because") ||
    normalized.includes("failed with:") ||
    normalized.includes("fails to start") ||
    normalized.includes("sandbox blocks") ||
    normalized.includes("sandbox blocked") ||
    normalized.includes("approval review failed") ||
    normalized.includes("failed before it could be approved") ||
    normalized.includes("not approved") ||
    normalized.includes("rejected") ||
    normalized.includes("interactive in this environment") ||
    normalized.includes("dropped into the interactive ui") ||
    normalized.includes("dropped into the interactive tui") ||
    normalized.includes("does not provide a separate non-interactive") ||
    normalized.includes("not runnable in this sandboxed session") ||
    normalized.includes("not installed") ||
    normalized.includes("not installed on the shell path") ||
    normalized.includes("command not found") ||
    normalized.includes("required user namespace") ||
    normalized.includes("unprivileged user namespaces") ||
    normalized.includes("user-namespace restriction") ||
    normalized.includes("bwrap: no permissions to create a new namespace")
  );
}

/** Returns true only for live `/codex models` proof that produced usable model evidence. */
export function isStrictExpectedCodexModelsCommandText(text: string): boolean {
  return isExpectedCodexModelsCommandText(text) && !isUnavailableCodexModelsCommandText(text);
}

/** Identifies transient live harness errors that are worth retrying, not skipping. */
export function isRetryableCodexHarnessLiveError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("gateway request timeout for sessions.list");
}

/** Matches the terminal snapshot emitted when a native subagent parent yields for delivery. */
export function isExpectedYieldedAgentTimeout(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const result = (payload as { result?: unknown; status?: unknown }).result;
  if (!result || typeof result !== "object") {
    return false;
  }
  const meta = (result as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object") {
    return false;
  }
  const record = meta as { livenessState?: unknown; yielded?: unknown };
  return (
    (payload as { status?: unknown }).status === "timeout" &&
    record.yielded === true &&
    record.livenessState === "paused"
  );
}
