// Resolves recent Gateway sessions and attaches the existing TUI to the selected key.
import { cancel, isCancel } from "@clack/prompts";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ErrorShape } from "../../packages/gateway-protocol/src/frame-guards.js";
import { selectStyled } from "../../packages/terminal-core/src/prompt-select-styled.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { decodeResumeHandoff } from "../shared/resume-handoff.js";
import type { TuiSessionList } from "../tui/tui-backend.js";
import {
  buildSessionChoices,
  loadRecentSessions,
  resolveResumeSession,
  type ResumeResolution,
  type SessionPickerChoice,
} from "../tui/tui-session-picker.js";
import type { ResumeCliOptions } from "./resume-cli.js";
import { isTerminalInteractive } from "./terminal-interactivity.js";

const RESUME_INTERACTIVE_TERMINAL_GUIDANCE =
  "Attaching to a session requires an interactive terminal. Re-run `openclaw resume [query]` from an interactive terminal.";
const RESUME_HANDOFF_MISSING =
  "This session is no longer available. Copy a fresh command from the Control UI.";
const RESUME_HANDOFF_UNRESOLVED =
  "Could not resolve the session handoff. Copy a fresh command from the Control UI.";

type ParsedHandoffSessionResolveResult =
  | { kind: "success"; key: string; agentId: string }
  | { kind: "missing" }
  | {
      kind: "ambiguous";
      candidates: Array<{ key: string; agentId: string; displayName?: string }>;
    }
  | { kind: "error"; error: ErrorShape }
  | { kind: "malformed" };

function hasExactKeys(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => requiredKeys.includes(key) || optionalKeys.includes(key))
  );
}

function isHandoffSessionCandidate(
  value: unknown,
): value is { key: string; agentId: string; displayName?: string } {
  return (
    hasExactKeys(value, ["key", "agentId"], ["displayName"]) &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    typeof value.agentId === "string" &&
    value.agentId.length > 0 &&
    (!Object.hasOwn(value, "displayName") || typeof value.displayName === "string")
  );
}

function isHandoffErrorShape(value: unknown): value is ErrorShape {
  if (
    !hasExactKeys(value, ["code", "message"], ["details", "retryable", "retryAfterMs"]) ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    (Object.hasOwn(value, "retryable") && typeof value.retryable !== "boolean")
  ) {
    return false;
  }
  return (
    !Object.hasOwn(value, "retryAfterMs") ||
    (typeof value.retryAfterMs === "number" &&
      Number.isInteger(value.retryAfterMs) &&
      value.retryAfterMs >= 0)
  );
}

function parseHandoffSessionResolveResult(value: unknown): ParsedHandoffSessionResolveResult {
  if (
    hasExactKeys(value, ["ok", "key", "agentId"]) &&
    value.ok === true &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    typeof value.agentId === "string" &&
    value.agentId.length > 0
  ) {
    return { kind: "success", key: value.key, agentId: value.agentId };
  }
  if (hasExactKeys(value, ["ok", "missing"]) && value.ok === true && value.missing === true) {
    return { kind: "missing" };
  }
  if (
    hasExactKeys(value, ["ok", "ambiguous", "candidates"]) &&
    value.ok === true &&
    value.ambiguous === true &&
    Array.isArray(value.candidates) &&
    value.candidates.every(isHandoffSessionCandidate)
  ) {
    return { kind: "ambiguous", candidates: value.candidates };
  }
  if (
    hasExactKeys(value, ["ok", "error"]) &&
    value.ok === false &&
    isHandoffErrorShape(value.error)
  ) {
    return { kind: "error", error: value.error };
  }
  return { kind: "malformed" };
}

function requireInteractiveResumeTerminal() {
  if (!isTerminalInteractive()) {
    throw new Error(RESUME_INTERACTIVE_TERMINAL_GUIDANCE);
  }
}

async function formatResumeConnectionError(error: unknown): Promise<Error> {
  const [{ formatTuiErrorMessage }, { resolveGatewayDisconnectState }] = await Promise.all([
    import("../tui/tui-formatters.js"),
    import("../tui/tui.js"),
  ]);
  const details =
    error && typeof error === "object" && "details" in error ? error.details : undefined;
  const state = resolveGatewayDisconnectState({
    reason: formatTuiErrorMessage(error),
    details,
  });
  return new Error(
    [
      state.connectionStatus,
      state.remediation ??
        "Ensure the Gateway is running and your --url/--token/--password are correct.",
    ].join("\n"),
    { cause: error },
  );
}

async function connectResumeGateway(opts: ResumeCliOptions, handoffTarget: boolean) {
  const { GatewayChatClient } = await import("../tui/gateway-chat.js");
  const client = await GatewayChatClient.connect({
    ...opts,
    ...(handoffTarget
      ? { allowConfiguredAuthForExactTarget: true, suppressEnvAuthFallback: true }
      : {}),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        complete();
      };
      client.onConnected = () => finish(resolve);
      client.onConnectError = (error) => finish(() => reject(error));
      client.onDisconnected = (reason) =>
        finish(() => reject(new Error(reason || "Gateway connection closed")));
      client.start();
    });
    return client;
  } catch (error) {
    await client.stop();
    throw await formatResumeConnectionError(error);
  }
}

async function resolveHandoffConnection(
  opts: ResumeCliOptions,
  handoff: { sessionKey: string; agentId: string },
) {
  const client = await connectResumeGateway(opts, true);
  try {
    let result: unknown;
    try {
      result = await client.resolveSession({
        key: handoff.sessionKey,
        agentId: handoff.agentId,
        includeGlobal: true,
        allowMissing: true,
      });
    } catch {
      throw new Error(RESUME_HANDOFF_UNRESOLVED);
    }
    const parsed = parseHandoffSessionResolveResult(result);
    if (parsed.kind === "success") {
      const canonicalKeyOwner = parseAgentSessionKey(parsed.key)?.agentId;
      if (parsed.agentId !== handoff.agentId || canonicalKeyOwner !== parsed.agentId) {
        throw new Error(RESUME_HANDOFF_UNRESOLVED);
      }
      return { connection: client.connection, sessionKey: parsed.key };
    }
    if (parsed.kind === "missing") {
      throw new Error(RESUME_HANDOFF_MISSING);
    }
    throw new Error(RESUME_HANDOFF_UNRESOLVED);
  } finally {
    await client.stop();
  }
}

async function fetchResumeSessions(
  opts: ResumeCliOptions,
  options: { agentId?: string; includeGlobal?: boolean } = {},
) {
  const client = await connectResumeGateway(opts, false);
  try {
    return {
      connection: client.connection,
      sessions: await loadRecentSessions(client, options),
    };
  } catch (error) {
    throw await formatResumeConnectionError(error);
  } finally {
    await client.stop();
  }
}

async function promptResumeSession(
  sessions: readonly TuiSessionList["sessions"][number][],
): Promise<string | null> {
  const choices = buildSessionChoices(sessions);
  if (choices.length === 0) {
    throw new Error(
      "No recent sessions found. Run `openclaw sessions` to inspect sessions or `openclaw tui` to start one.",
    );
  }
  const selected = await selectStyled({
    message: "Resume a session",
    options: choices.map((choice) => ({
      value: choice.value,
      label: formatResumeCandidate(choice),
      hint: choice.description ? sanitizeTerminalText(choice.description) : undefined,
    })),
  });
  if (isCancel(selected)) {
    cancel("Cancelled.");
    return null;
  }
  return selected;
}

function reportResumeFailure(
  query: string,
  resolution: Exclude<ResumeResolution, { kind: "match" }>,
) {
  if (resolution.kind === "ambiguous") {
    defaultRuntime.error(`Session query ${JSON.stringify(query)} is ambiguous. Candidates:`);
    for (const candidate of resolution.candidates) {
      defaultRuntime.error(`  ${formatResumeCandidate(candidate)}`);
    }
    defaultRuntime.error("Use a longer name or the exact session key.");
    return;
  }
  defaultRuntime.error(`No recent session matched ${JSON.stringify(query)}.`);
  defaultRuntime.error(
    "Run `openclaw resume` to choose from recent sessions or `openclaw sessions` to inspect all sessions.",
  );
}

function formatResumeCandidate(candidate: SessionPickerChoice): string {
  const label = sanitizeTerminalText(candidate.label);
  const key = sanitizeTerminalText(candidate.value);
  return label === key ? key : `${label} [${key}]`;
}

function resolveExplicitGlobalSessionKey(
  query: string | undefined,
): { agentId: string; key: string } | undefined {
  const parsed = parseAgentSessionKey(query);
  return parsed?.rest === "global"
    ? { agentId: parsed.agentId, key: `agent:${parsed.agentId}:global` }
    : undefined;
}

/** Resolve or select one session and run the existing Gateway-backed TUI. */
export async function runResumeCommand(query: string | undefined, opts: ResumeCliOptions) {
  const { handoff: encodedHandoff, ...connectionOptions } = opts;
  if (encodedHandoff !== undefined && (query !== undefined || opts.url !== undefined)) {
    throw new Error("--handoff cannot be combined with a positional query or --url.");
  }
  const handoff = encodedHandoff === undefined ? undefined : decodeResumeHandoff(encodedHandoff);
  requireInteractiveResumeTerminal();
  const resolvedQuery = query?.trim();
  const explicitGlobalSession = resolveExplicitGlobalSessionKey(resolvedQuery);
  let connection: Awaited<ReturnType<typeof connectResumeGateway>>["connection"];
  let sessionKey: string | null;
  if (handoff) {
    const parsed = parseAgentSessionKey(handoff.sessionKey)!;
    const resolved = await resolveHandoffConnection(
      {
        ...connectionOptions,
        url: handoff.gatewayUrl,
      },
      { sessionKey: handoff.sessionKey, agentId: parsed.agentId },
    );
    connection = resolved.connection;
    sessionKey = resolved.sessionKey;
  } else {
    const discovery = await fetchResumeSessions(
      connectionOptions,
      explicitGlobalSession
        ? { agentId: explicitGlobalSession.agentId, includeGlobal: true }
        : undefined,
    );
    connection = discovery.connection;
    if (explicitGlobalSession) {
      sessionKey = explicitGlobalSession.key;
    } else if (resolvedQuery) {
      const resolution = resolveResumeSession(discovery.sessions, resolvedQuery);
      if (resolution.kind !== "match") {
        reportResumeFailure(resolvedQuery, resolution);
        defaultRuntime.exit(1);
        return;
      }
      sessionKey = resolution.session.value;
    } else {
      sessionKey = await promptResumeSession(discovery.sessions);
    }
  }
  if (!sessionKey) {
    return;
  }
  const { runTui } = await import("../tui/tui.js");
  await runTui({
    boundGateway: {
      url: handoff?.gatewayUrl ?? connection.url,
      ...(connection.token ? { token: connection.token } : {}),
      ...(connection.password ? { password: connection.password } : {}),
      ...(connection.tlsFingerprint ? { tlsFingerprint: connection.tlsFingerprint } : {}),
    },
    session: sessionKey,
    forceProcessExitOnReturn: true,
  });
}
