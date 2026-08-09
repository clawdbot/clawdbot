// Resolves recent Gateway sessions and attaches the existing TUI to the selected key.
import { cancel, isCancel } from "@clack/prompts";
import { selectStyled } from "../../packages/terminal-core/src/prompt-select-styled.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import type { TuiSessionList } from "../tui/tui-backend.js";
import {
  buildSessionChoices,
  loadRecentSessions,
  resolveResumeSession,
  type ResumeResolution,
  type SessionPickerChoice,
} from "../tui/tui-session-picker.js";
import type { ResumeCliOptions } from "./resume-cli.js";

const RESUME_INTERACTIVE_TERMINAL_GUIDANCE =
  "Attaching to a session requires an interactive terminal. Re-run `openclaw resume [query]` from an interactive terminal.";

function requireInteractiveResumeTerminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(RESUME_INTERACTIVE_TERMINAL_GUIDANCE);
  }
}

async function fetchResumeSessions(
  opts: ResumeCliOptions,
  options: { agentId?: string; includeGlobal?: boolean } = {},
) {
  const { GatewayChatClient } = await import("../tui/gateway-chat.js");
  const client = await GatewayChatClient.connect(opts);
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
    return await loadRecentSessions(client, options);
  } catch (error) {
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
    throw new Error(
      [
        state.connectionStatus,
        state.remediation ??
          "Ensure the Gateway is running and your --url/--token/--password are correct.",
      ].join("\n"),
      { cause: error },
    );
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
  requireInteractiveResumeTerminal();
  const trimmedQuery = query?.trim();
  const explicitGlobalSession = resolveExplicitGlobalSessionKey(trimmedQuery);
  const sessions = await fetchResumeSessions(
    opts,
    explicitGlobalSession
      ? { agentId: explicitGlobalSession.agentId, includeGlobal: true }
      : undefined,
  );
  let sessionKey: string | null;
  if (explicitGlobalSession) {
    sessionKey = explicitGlobalSession.key;
  } else if (trimmedQuery) {
    const resolution = resolveResumeSession(sessions, trimmedQuery);
    if (resolution.kind !== "match") {
      reportResumeFailure(trimmedQuery, resolution);
      defaultRuntime.exit(1);
      return;
    }
    sessionKey = resolution.session.value;
  } else {
    sessionKey = await promptResumeSession(sessions);
  }
  if (!sessionKey) {
    return;
  }
  const { runTui } = await import("../tui/tui.js");
  await runTui({
    url: opts.url,
    token: opts.token,
    password: opts.password,
    tlsFingerprint: opts.tlsFingerprint,
    session: sessionKey,
    forceProcessExitOnReturn: true,
  });
}
