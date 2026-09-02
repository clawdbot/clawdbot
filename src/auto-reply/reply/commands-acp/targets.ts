// Resolves ACP command target sessions from user text and active state.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AcpSessionTarget } from "../../../acp/control-plane/manager.types.js";
import { resolveAcpSessionTarget } from "../../../acp/control-plane/manager.utils.js";
import { callGateway } from "../../../gateway/call.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { SESSION_ID_RE } from "../../../sessions/session-id.js";
import { resolveEffectiveResetTargetSessionKey } from "../acp-reset-target.js";
import { resolveRequesterSessionKey } from "../commands-subagents/shared.js";
import type { HandleCommandsParams } from "../commands-types.js";
import { resolveAcpCommandBindingContext } from "./context.js";

async function resolveSessionKeyByToken(
  token: string,
  commandParams: HandleCommandsParams,
): Promise<AcpSessionTarget | null> {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  const attempts: Array<Record<string, string>> = [{ key: trimmed }];
  if (SESSION_ID_RE.test(trimmed)) {
    attempts.push({ sessionId: trimmed });
  }
  attempts.push({ label: trimmed });

  for (const params of attempts) {
    const resolved = await callGateway({
      method: "sessions.resolve",
      params: {
        ...params,
        allowMissing: true,
        agentId: parseAgentSessionKey(trimmed)?.agentId ?? commandParams.agentId,
      },
      timeoutMs: 8_000,
    });
    const key = normalizeOptionalString(resolved?.key);
    if (key) {
      return resolveAcpSessionTarget({
        cfg: commandParams.cfg,
        sessionKey: key,
        agentId: normalizeOptionalString(resolved?.agentId),
      });
    }
    if (Array.isArray(resolved?.candidates) && resolved.candidates.length) {
      throw new Error(`Ambiguous ACP session target: ${trimmed}. Use an agent-qualified key.`);
    }
  }
  return null;
}

export function resolveBoundAcpThreadSessionKey(params: HandleCommandsParams): string | undefined {
  const commandTargetSessionKey = normalizeOptionalString(params.ctx.CommandTargetSessionKey) ?? "";
  const activeSessionKey =
    commandTargetSessionKey || (normalizeOptionalString(params.sessionKey) ?? "");
  const bindingContext = resolveAcpCommandBindingContext(params);
  return resolveEffectiveResetTargetSessionKey({
    cfg: params.cfg,
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    parentConversationId: bindingContext.parentConversationId,
    activeSessionKey,
    allowNonAcpBindingSessionKey: true,
    skipConfiguredFallbackWhenActiveSessionNonAcp: false,
  });
}

export async function resolveAcpTargetSessionKey(params: {
  commandParams: HandleCommandsParams;
  token?: string;
}): Promise<({ ok: true } & AcpSessionTarget) | { ok: false; error: string }> {
  const token = normalizeOptionalString(params.token) ?? "";
  if (token) {
    try {
      const resolved = await resolveSessionKeyByToken(token, params.commandParams);
      if (resolved) {
        return { ok: true, ...resolved };
      }
    } catch (error) {
      return { ok: false, error: formatErrorMessage(error) };
    }
    // Token was supplied but could not be resolved as a session key/id/label.
    // Fall through to thread-bound resolution so that callers that auto-fill
    // the current thread ID as the token (e.g. Discord slash commands) still
    // reach the correct session via the binding context.
  }

  const threadBound = resolveBoundAcpThreadSessionKey(params.commandParams);
  if (threadBound) {
    return {
      ok: true,
      ...resolveAcpSessionTarget({
        cfg: params.commandParams.cfg,
        sessionKey: threadBound,
        agentId:
          threadBound === params.commandParams.sessionKey
            ? params.commandParams.agentId
            : undefined,
      }),
    };
  }

  if (token) {
    return {
      ok: false,
      error: `Unable to resolve session target: ${token}`,
    };
  }

  const fallback = resolveRequesterSessionKey(params.commandParams, {
    preferCommandTarget: true,
  });
  if (!fallback) {
    return {
      ok: false,
      error: "Missing session key.",
    };
  }
  return {
    ok: true,
    ...resolveAcpSessionTarget({
      cfg: params.commandParams.cfg,
      sessionKey: fallback,
      agentId: params.commandParams.agentId,
    }),
  };
}
