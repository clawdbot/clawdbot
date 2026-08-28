import type { MsgContext } from "../auto-reply/templating.js";
import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import { recordSessionParticipantBestEffort } from "./session-participant-recording.js";

// Core and SDK chunks share one private key; context spreads retain the same consumed fact.
const participantInput = Symbol.for("openclaw.sessionParticipantInput");
type ParticipantInputContext = MsgContext & {
  [participantInput]?: Array<{
    identity: SessionParticipantIdentity;
    promptedAt: number;
    recorded: boolean;
  }>;
};

/** Trusted ingress prepares once; context spreads carry the same consumed fact through retargeting. */
export function prepareSessionParticipantInput(
  ctx: ParticipantInputContext,
  identity: SessionParticipantIdentity,
  promptedAt = Date.now(),
): void {
  (ctx[participantInput] ??= []).push({ identity, promptedAt, recorded: false });
}

export function readSessionInputProfileId(ctx: ParticipantInputContext): string | undefined {
  const identity = ctx[participantInput]?.find(
    (input) => input.identity.type === "profile",
  )?.identity;
  return identity?.type === "profile" ? identity.id : undefined;
}

/** An unqualified transport sender remains an observation, never a Gateway profile. */
export function prepareChannelParticipantObservation(ctx: ParticipantInputContext): void {
  const channel = ctx.Provider ?? ctx.Surface;
  if (
    ctx[participantInput] ||
    !ctx.SenderId ||
    (channel !== undefined &&
      ["webchat", "heartbeat", "cron-event", "exec-event"].includes(channel)) ||
    (ctx.InputProvenance && ctx.InputProvenance.kind !== "external_user")
  ) {
    return;
  }
  prepareSessionParticipantInput(ctx, {
    type: "observation",
    pluginId: channel ?? null,
    accountId: ctx.AccountId ?? null,
    senderKind: ctx.SenderIsBot === true ? "bot" : ctx.SenderIsBot === false ? "human" : "unknown",
    id: ctx.SenderId,
  });
}

/** Call only after admission and final target selection; never creates a session to count input. */
export function recordAcceptedSessionParticipantInput(
  ctx: ParticipantInputContext,
  target: Omit<Parameters<typeof recordSessionParticipantBestEffort>[0], "identity" | "promptedAt">,
): void {
  for (const input of ctx[participantInput] ?? []) {
    if (!input.recorded) {
      input.recorded = true;
      recordSessionParticipantBestEffort({
        ...target,
        identity: input.identity,
        promptedAt: input.promptedAt,
      });
    }
  }
}
