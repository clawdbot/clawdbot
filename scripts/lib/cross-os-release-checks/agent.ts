import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { AgentOutputOptions } from "./config.ts";
import { CROSS_OS_AGENT_TURN_OPTIONAL, CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS } from "./config.ts";
import { readLogTextTail } from "./logs.ts";

export function maybeBuildOptionalAgentTurnSkipResult(
  error: unknown,
  logPath: string,
  options: { attempt?: number; maxAttempts?: number; optional?: boolean } = {},
) {
  const attempt = options.attempt ?? 1;
  const maxAttempts = options.maxAttempts ?? 2;
  const optional = options.optional ?? CROSS_OS_AGENT_TURN_OPTIONAL;
  if (
    attempt < maxAttempts ||
    !optional ||
    !shouldSkipOptionalCrossOsAgentTurnError(error, logPath)
  ) {
    return null;
  }
  const message = error instanceof Error ? error.message : String(error);
  appendFileSync(
    logPath,
    `\n[release-checks] skipping optional cross-OS live agent turn after retryable failure: ${message}\n`,
  );
  return {
    status: 0,
    stdout: JSON.stringify({
      status: "skipped",
      reason: "cross-os live agent turn unavailable after retry",
    }),
    stderr: "",
  };
}

export function shouldSkipOptionalCrossOsAgentTurnError(error: unknown, logPath: string) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /model idle timeout|did not produce a response before the model idle timeout|gateway request timeout for agent|Command timed out|timed out and could not be terminated cleanly/u.test(
      message,
    )
  ) {
    return true;
  }
  if (!/Agent output did not contain the expected OK marker/u.test(message)) {
    return false;
  }
  const log = readLogTextTail(logPath);
  return /"status"\s*:\s*"timeout"|Request timed out before a response was generated/u.test(log);
}

export function buildCrossOsReleaseAgentSessionId(label: string, attempt: number) {
  return `cross-os-release-check-${label}-${randomUUID()}-${attempt}`;
}

export function buildReleaseAgentTurnArgs(sessionId: string) {
  return [
    "agent",
    "--agent",
    "main",
    "--session-id",
    sessionId,
    "--message",
    "Reply with exact ASCII text OK only.",
    "--thinking",
    "off",
    "--timeout",
    String(CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS),
    "--json",
  ];
}

export function shouldRetryCrossOsAgentTurnError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Agent output did not contain the expected OK marker|model idle timeout|did not produce a response before the model idle timeout|gateway request timeout for agent|Command timed out|timed out and could not be terminated cleanly|rate limit reached|rate_limit_exceeded|HTTP 429|HTTP 503|upstream connect error|disconnect\/reset before headers|connection timeout/u.test(
    message,
  );
}

export function agentOutputHasExpectedOkMarker(stdout: string, options: AgentOutputOptions = {}) {
  const payloadTexts = parseAgentPayloadTexts(stdout);
  if (payloadTexts.some((text) => text.trim() === "OK")) {
    return true;
  }
  if (typeof options.logText === "string") {
    const logTexts = parseAgentPayloadTexts(options.logText);
    return logTexts.some((text) => text.trim() === "OK");
  }
  if (typeof options.logPath !== "string") {
    return false;
  }
  const logTexts = parseAgentPayloadTexts(readLogTextTail(options.logPath));
  return logTexts.some((text) => text.trim() === "OK");
}

function parseAgentPayloadTexts(stdout: string) {
  try {
    type AgentPayload = {
      text?: string;
      finalAssistantVisibleText?: string;
      finalAssistantRawText?: string;
      meta?: AgentPayload;
      result?: AgentPayload;
      payloads?: AgentPayload[];
    };
    const payload = JSON.parse(stdout) as AgentPayload;
    const directTexts = [
      payload?.finalAssistantVisibleText,
      payload?.finalAssistantRawText,
      payload?.meta?.finalAssistantVisibleText,
      payload?.meta?.finalAssistantRawText,
      payload?.result?.finalAssistantVisibleText,
      payload?.result?.finalAssistantRawText,
      payload?.result?.meta?.finalAssistantVisibleText,
      payload?.result?.meta?.finalAssistantRawText,
    ].filter((text): text is string => typeof text === "string");
    const entries = Array.isArray(payload?.payloads)
      ? payload.payloads
      : Array.isArray(payload?.result?.payloads)
        ? payload.result.payloads
        : [];
    const payloadTexts = entries.flatMap((entry) =>
      typeof entry?.text === "string" ? [entry.text] : [],
    );
    return [...directTexts, ...payloadTexts];
  } catch {
    const finalTextMatches = [
      ...stdout.matchAll(
        /"(?:finalAssistantVisibleText|finalAssistantRawText|text)"\s*:\s*"([^"]*)"/gu,
      ),
    ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
    return finalTextMatches.length > 0 ? finalTextMatches : stdout.trim() ? [stdout] : [];
  }
}
