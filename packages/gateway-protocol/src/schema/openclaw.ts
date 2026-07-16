// Gateway Protocol schema module defines OpenClaw chat payloads.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { WizardStartResultSchema } from "./wizard.js";

/**
 * OpenClaw chat lets clients (macOS app onboarding, future UIs) hold the
 * setup/repair conversation over the gateway. The gateway live-tests the
 * configured inference route before creating a session. Omitting `message`
 * returns the welcome/greeting for a verified fresh session without input.
 */
export const SystemAgentChatParamsSchema = closedObject({
  sessionId: NonEmptyString,
  message: Type.Optional(Type.String()),
  /** "onboarding" seeds the first-run setup proposal in the greeting. */
  welcomeVariant: Type.Optional(Type.Union([Type.Literal("onboarding")])),
  /** Drop any in-flight approval/wizard state and start the session over. */
  reset: Type.Optional(Type.Boolean()),
  /** Host-only regular-agent delegation context. Never model-authored. */
  delegation: Type.Optional(
    closedObject({
      agentId: Type.Optional(NonEmptyString),
      sessionKey: Type.Optional(NonEmptyString),
      turnSourceChannel: Type.Optional(NonEmptyString),
      turnSourceTo: Type.Optional(NonEmptyString),
      turnSourceAccountId: Type.Optional(NonEmptyString),
      turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    }),
  ),
});

/** One OpenClaw reply; `action` tells clients about conversation handoffs. */
export const SystemAgentChatResultSchema = closedObject({
  sessionId: NonEmptyString,
  reply: NonEmptyString,
  /** The next reply is a hosted-wizard secret and clients must mask its input/echo. */
  sensitive: Type.Optional(Type.Boolean()),
  action: Type.Union([
    Type.Literal("none"),
    // The user asked to talk to their agent; clients should move to their
    // normal agent chat surface.
    Type.Literal("open-agent"),
    Type.Literal("exit"),
  ]),
  needsApproval: Type.Optional(Type.Boolean()),
  proposalId: Type.Optional(NonEmptyString),
});

/**
 * Structured first-run inference setup for GUI clients: detect reusable AI
 * access (CLI logins, env keys, existing config), then activate one choice.
 * Activation live-tests the candidate and persists it only on success, so a
 * client can walk the ladder candidate-by-candidate without ever leaving a
 * broken default model behind.
 */
export const SystemAgentSetupDetectParamsSchema = closedObject({});

const ProviderAutoSetupInferenceKind = Type.TemplateLiteral("provider-auto:${string}", {
  pattern: "^provider-auto:.+$",
});

const SetupInferenceKind = Type.Union([
  Type.Literal("existing-model"),
  Type.Literal("openai-api-key"),
  Type.Literal("anthropic-api-key"),
  Type.Literal("claude-cli"),
  Type.Literal("codex-cli"),
  Type.Literal("gemini-cli"),
  ProviderAutoSetupInferenceKind,
]);

const SetupInferenceStatus = Type.Union([
  Type.Literal("ok"),
  Type.Literal("auth"),
  Type.Literal("rate_limit"),
  Type.Literal("billing"),
  Type.Literal("timeout"),
  Type.Literal("format"),
  Type.Literal("unavailable"),
  Type.Literal("unknown"),
]);

const SetupInferenceFailureStatus = Type.Union([
  Type.Literal("auth"),
  Type.Literal("rate_limit"),
  Type.Literal("billing"),
  Type.Literal("timeout"),
  Type.Literal("format"),
  Type.Literal("unavailable"),
  Type.Literal("unknown"),
]);

export const SystemAgentSetupDetectResultSchema = closedObject({
  candidates: Type.Array(
    closedObject({
      kind: SetupInferenceKind,
      label: NonEmptyString,
      detail: Type.String(),
      modelRef: NonEmptyString,
      recommended: Type.Boolean(),
      /** true: verified; false: definitively logged out; absent: unknown. */
      credentials: Type.Optional(Type.Boolean()),
    }),
  ),
  unavailableCandidates: Type.Optional(
    Type.Array(
      closedObject({
        id: NonEmptyString,
        label: NonEmptyString,
        detail: Type.String(),
        reason: NonEmptyString,
      }),
    ),
  ),
  /** Text-inference key/token methods exposed by the Gateway provider registry. */
  manualProviders: Type.Array(
    closedObject({
      /** Opaque provider-auth choice sent back during activation. */
      id: NonEmptyString,
      label: NonEmptyString,
      hint: Type.Optional(Type.String()),
    }),
  ),
  /** Provider-owned browser and device-code login methods. */
  authOptions: Type.Optional(
    Type.Array(
      closedObject({
        id: NonEmptyString,
        label: NonEmptyString,
        hint: Type.Optional(Type.String()),
        groupLabel: Type.Optional(Type.String()),
        kind: Type.Union([Type.Literal("oauth"), Type.Literal("device-code")]),
        featured: Type.Boolean(),
      }),
    ),
  ),
  workspace: NonEmptyString,
  codexAppServerDetected: Type.Optional(Type.Boolean()),
  configuredModel: Type.Optional(Type.String()),
  setupComplete: Type.Boolean(),
});

/** Live verification of the Gateway's current default-agent inference route. */
export const SystemAgentSetupVerifyParamsSchema = closedObject({});

export const SystemAgentSetupVerifyResultSchema = Type.Union([
  closedObject({
    ok: Type.Literal(true),
    modelRef: NonEmptyString,
    latencyMs: Type.Number(),
  }),
  closedObject({
    ok: Type.Literal(false),
    status: SetupInferenceFailureStatus,
    error: NonEmptyString,
  }),
]);

export const SystemAgentSetupActivateParamsSchema = closedObject({
  kind: Type.Union([
    Type.Literal("existing-model"),
    Type.Literal("openai-api-key"),
    Type.Literal("anthropic-api-key"),
    Type.Literal("claude-cli"),
    Type.Literal("codex-cli"),
    Type.Literal("gemini-cli"),
    ProviderAutoSetupInferenceKind,
    Type.Literal("api-key"),
  ]),
  /** Exact detected model for this route; prevents detect/activate drift. */
  modelRef: Type.Optional(NonEmptyString),
  /** Manual step only: opaque provider-auth choice returned by detection. */
  authChoice: Type.Optional(Type.String()),
  /** Manual step only: the pasted API key or token; masked by clients, never echoed. */
  apiKey: Type.Optional(Type.String()),
  workspace: Type.Optional(Type.String()),
});

export const SystemAgentSetupActivateResultSchema = closedObject({
  ok: Type.Boolean(),
  /** Present on success: the model ref that answered the live test. */
  modelRef: Type.Optional(Type.String()),
  latencyMs: Type.Optional(Type.Number()),
  /** Human-readable setup summary lines (workspace, model, gateway). */
  lines: Type.Optional(Type.Array(Type.String())),
  /** Present on failure: coarse bucket for client copy + docs links. */
  status: Type.Optional(SetupInferenceStatus),
  error: Type.Optional(Type.String()),
});

/** Starts one provider-owned interactive login as a gateway wizard session. */
export const SystemAgentSetupAuthStartParamsSchema = closedObject({
  /** Client-generated so cancellation remains possible if the start reply is lost. */
  sessionId: NonEmptyString,
  authChoice: NonEmptyString,
  workspace: Type.Optional(Type.String()),
});

export const SystemAgentSetupAuthStartResultSchema = WizardStartResultSchema;

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type SystemAgentChatParams = Static<typeof SystemAgentChatParamsSchema>;
export type SystemAgentChatResult = Static<typeof SystemAgentChatResultSchema>;
export type SystemAgentSetupDetectParams = Static<typeof SystemAgentSetupDetectParamsSchema>;
export type SystemAgentSetupDetectResult = Static<typeof SystemAgentSetupDetectResultSchema>;
export type SystemAgentSetupActivateParams = Static<typeof SystemAgentSetupActivateParamsSchema>;
export type SystemAgentSetupActivateResult = Static<typeof SystemAgentSetupActivateResultSchema>;
export type SystemAgentSetupVerifyParams = Static<typeof SystemAgentSetupVerifyParamsSchema>;
export type SystemAgentSetupVerifyResult = Static<typeof SystemAgentSetupVerifyResultSchema>;
export type SystemAgentSetupAuthStartParams = Static<typeof SystemAgentSetupAuthStartParamsSchema>;
export type SystemAgentSetupAuthStartResult = Static<typeof SystemAgentSetupAuthStartResultSchema>;
