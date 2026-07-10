// Crestodian gateway methods host the setup/repair conversation for clients.
import {
  ErrorCodes,
  errorShape,
  validateCrestodianChatParams,
  validateCrestodianSetupActivateParams,
  validateCrestodianSetupDetectParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { CrestodianChatEngine } from "../../crestodian/chat-engine.js";
import { buildOnboardingWelcome } from "../../crestodian/onboarding-welcome.js";
import { formatCrestodianStartupMessage } from "../../crestodian/overview.js";
import { defaultRuntime } from "../../runtime.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/**
 * `crestodian.chat` lets clients (macOS app onboarding, future UIs) run the
 * same conversational setup as `openclaw crestodian`. It is configless-safe:
 * the engine answers deterministically before any model is configured, so the
 * app can onboard a fresh machine entirely through this one method.
 *
 * Sessions are process-local by design — Crestodian state is an in-flight
 * conversation, not persisted data. The map is bounded; the oldest session is
 * evicted first, and `reset: true` starts a session over explicitly.
 */
export type CrestodianChatSession = {
  engine: CrestodianChatEngine;
  welcome: string;
  lastUsedAt: number;
};

const MAX_CRESTODIAN_SESSIONS = 8;

let crestodianSetupActivationInProgress = false;

class CrestodianSetupActivationBusyError extends Error {}

/** Admit one setup mutation without queueing work past a caller timeout. */
export async function runExclusiveCrestodianSetupActivation<T>(task: () => Promise<T>): Promise<T> {
  if (crestodianSetupActivationInProgress) {
    throw new CrestodianSetupActivationBusyError(
      "Crestodian setup is already in progress; try again when it finishes.",
    );
  }
  crestodianSetupActivationInProgress = true;
  try {
    return await task();
  } finally {
    crestodianSetupActivationInProgress = false;
  }
}

async function evictOldestSession(sessions: Map<string, CrestodianChatSession>): Promise<void> {
  if (sessions.size < MAX_CRESTODIAN_SESSIONS) {
    return;
  }
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, session] of sessions) {
    if (session.lastUsedAt < oldestAt) {
      oldestAt = session.lastUsedAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) {
    await sessions.get(oldestKey)?.engine.dispose();
    sessions.delete(oldestKey);
  }
}

export const crestodianHandlers: GatewayRequestHandlers = {
  /** Structured onboarding: list reusable AI access on this host. */
  "crestodian.setup.detect": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateCrestodianSetupDetectParams,
        "crestodian.setup.detect",
        respond,
      )
    ) {
      return;
    }
    const { detectSetupInference } = await import("../../crestodian/setup-inference.js");
    respond(true, await detectSetupInference(), undefined);
  },
  /**
   * Structured onboarding: live-test one candidate and persist it on success.
   * Single-flight per gateway process because testing and persistence span
   * multiple config/plugin mutations. Concurrent callers fail fast instead of
   * queueing work that could outlive their RPC timeout. A failed attempt never
   * persists a broken model or setup state (Codex may still record a managed
   * plugin install; see setup-inference.ts).
   */
  "crestodian.setup.activate": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateCrestodianSetupActivateParams,
        "crestodian.setup.activate",
        respond,
      )
    ) {
      return;
    }
    try {
      await runExclusiveCrestodianSetupActivation(async () => {
        const { activateSetupInference } = await import("../../crestodian/setup-inference.js");
        const runtime = {
          ...defaultRuntime,
          // Setup runs inside the gateway process; a failing sub-step must reject
          // the RPC, never exit the daemon.
          exit: (code: number | undefined): never => {
            throw new Error(`setup step exited with code ${String(code)}`);
          },
        };
        const result = await activateSetupInference({
          kind: params.kind,
          ...(params.modelRef !== undefined ? { modelRef: params.modelRef } : {}),
          ...(params.authChoice !== undefined ? { authChoice: params.authChoice } : {}),
          ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
          ...(params.workspace !== undefined ? { workspace: params.workspace } : {}),
          surface: "gateway",
          runtime,
        });
        respond(true, result, undefined);
      });
    } catch (error) {
      if (!(error instanceof CrestodianSetupActivationBusyError)) {
        throw error;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, error.message, { retryable: true }),
      );
    }
  },
  "crestodian.chat": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateCrestodianChatParams, "crestodian.chat", respond)) {
      return;
    }
    const sessions = context.crestodianSessions;
    const sessionId = params.sessionId;
    if (params.reset) {
      await sessions.get(sessionId)?.engine.dispose();
      sessions.delete(sessionId);
    }
    let session = sessions.get(sessionId);
    if (!session) {
      // The gateway surface must never install/restart its own daemon; the
      // engine's setup path honors this via surface: "gateway".
      const engine = new CrestodianChatEngine({ surface: "gateway" });
      let welcome: string;
      if (params.welcomeVariant === "onboarding") {
        welcome = await buildOnboardingWelcome({ engine });
      } else {
        welcome = formatCrestodianStartupMessage(await engine.loadOverview());
        engine.noteAssistantMessage(welcome);
      }
      await evictOldestSession(sessions);
      session = { engine, welcome, lastUsedAt: Date.now() };
      sessions.set(sessionId, session);
      if (params.message === undefined || !params.message.trim()) {
        respond(true, { sessionId, reply: session.welcome, action: "none" }, undefined);
        return;
      }
    }
    session.lastUsedAt = Date.now();
    if (params.message === undefined || !params.message.trim()) {
      respond(true, { sessionId, reply: session.welcome, action: "none" }, undefined);
      return;
    }
    const reply = await session.engine.handle(params.message);
    // The TUI-only "open-tui" handoff becomes a client-visible "open-agent"
    // signal: the app should move the user to their normal agent chat.
    const action =
      reply.action === "open-tui"
        ? "open-agent"
        : reply.action === "open-setup"
          ? "none"
          : reply.action;
    respond(
      true,
      {
        sessionId,
        reply:
          reply.text ||
          (action === "open-agent"
            ? "Setup here is done — continue with your agent."
            : "Nothing to change."),
        action,
        ...(reply.sensitive === true ? { sensitive: true } : {}),
      },
      undefined,
    );
  },
};
