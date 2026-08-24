// Talk client methods create browser-owned realtime voice sessions and route
// client tool calls back into OpenClaw agent consult/control flows.
import { randomUUID } from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkClientCloseParams,
  validateTalkClientCreateParams,
  validateTalkClientSteerParams,
  validateTalkClientToolCallParams,
  validateTalkClientTranscriptParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { buildAgentMainSessionKey } from "../../routing/session-key.js";
import { assertSecretOwnerAvailable } from "../../secrets/runtime-degraded-state.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  parseRealtimeVoiceAgentConsultArgs,
} from "../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../../talk/agent-run-control-shared.js";
import { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import {
  authorizeClientVoiceConfirmation,
  bindAuthorizedClientVoiceConfirmation,
  type ClientVoiceConfirmationGrant,
} from "../../talk/client-voice-confirmation.js";
import {
  appendClientVoiceTranscript,
  assertClientVoiceSessionOpen,
  closeClientVoiceSession,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
  flushClientVoiceSessionWrites,
  registerClientVoiceConsultRun,
  resolveClientVoiceAgentSessionId,
  resolveClientVoiceSessionOrigin,
  resolveOpenClientVoiceSessionId,
} from "../../talk/client-voice-session.js";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL } from "../../talk/describe-view-tool.js";
import {
  cancelInternalRealtimeVoiceBrowserSession,
  type InternalRealtimeVoiceBrowserSessionCreateRequest,
} from "../../talk/provider-internal.js";
import {
  resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceProviderCapabilities,
} from "../../talk/provider-resolver.js";
import { readSessionPreviewItemsFromTranscript } from "../session-transcript-readers.js";
import { startTalkRealtimeAgentConsult } from "../talk-agent-consult.js";
import {
  boundTalkClientRealtimeInitialItems,
  closeTalkClientGatewayControlSession,
  createTalkClientAgentConsultRunner,
  createTalkClientGatewayControlOwner,
  resolveTalkAgentConsultAuthority,
} from "../talk-client-gateway-control.js";
import {
  ensureTalkRealtimeRelayVoiceSession,
  flushTalkRealtimeRelayVoiceWrites,
} from "../talk-realtime-relay.js";
import { formatForLog } from "../ws-log.js";
import { hasOwnedActiveTalkClientRun } from "./talk-client-run-ownership.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  isUnsupportedBrowserWebRtcSession,
  resolveTalkRealtimeProviderInstructions,
} from "./talk-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const LEGACY_VOICE_BINDING_TTL_MS = 6 * 60 * 60_000;
const REALTIME_VOICE_CONTEXT_MAX_ITEMS = 16;
const REALTIME_VOICE_CONTEXT_MAX_ITEM_CHARS = 800;
const REALTIME_VOICE_CLIENT_SESSION_MIN_TTL_MS = 5_000;
const legacyVoiceSessionByClient = new Map<string, { voiceSessionId: string; expiresAt: number }>();

function legacyVoiceBindingKey(connId: string, sessionKey: string): string {
  return `${connId}\0${sessionKey}`;
}

function pruneLegacyVoiceBindings(now = Date.now()): void {
  for (const [key, binding] of legacyVoiceSessionByClient) {
    if (binding.expiresAt <= now) {
      legacyVoiceSessionByClient.delete(key);
    }
  }
}

/**
 * Gateway methods for browser-owned realtime Talk sessions.
 *
 * These handlers create provider browser sessions and bridge client-owned tool
 * calls back into OpenClaw agent consult runs.
 */
export const talkClientHandlers: GatewayRequestHandlers = {
  "talk.client.create": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateTalkClientCreateParams, "talk.client.create", respond)) {
      return;
    }
    const typedParams = params as {
      sessionKey?: string;
      voiceSessionId?: string;
      provider?: string;
      model?: string;
      voice?: string;
      vadThreshold?: number;
      silenceDurationMs?: number;
      prefixPaddingMs?: number;
      reasoningEffort?: string;
      mode?: string;
      transport?: string;
      brain?: string;
      capabilities?: string[];
    };
    try {
      const runtimeConfig = context.getRuntimeConfig();
      const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, typedParams.provider);
      const mode =
        normalizeOptionalLowercaseString(typedParams.mode) ?? realtimeConfig.mode ?? "realtime";
      if (mode !== "realtime") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.client.create only supports mode="realtime"; use talk.catalog for ${mode} provider discovery`,
          ),
        );
        return;
      }
      const brain =
        normalizeOptionalLowercaseString(typedParams.brain) ??
        realtimeConfig.brain ??
        "agent-consult";
      if (brain !== "agent-consult") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.client.create only supports brain="agent-consult"`,
          ),
        );
        return;
      }
      const transport =
        normalizeOptionalLowercaseString(typedParams.transport) ?? realtimeConfig.transport;
      const wantsCameraFrames = typedParams.capabilities?.includes("camera-frame") === true;
      const wantsGatewayControl = typedParams.capabilities?.includes("gateway-control-v1") === true;
      if (wantsGatewayControl && wantsCameraFrames) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "gateway-control-v1 supports audio-only WebRTC sessions",
          ),
        );
        return;
      }
      if (transport === "managed-room") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "managed-room realtime Talk sessions are not available in the browser UI yet",
          ),
        );
        return;
      }
      if (transport === "gateway-relay") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            wantsCameraFrames
              ? "gateway-relay does not support browser video frames"
              : `talk.client.create is client-owned; use talk.session.create for gateway-relay`,
          ),
        );
        return;
      }
      const launchOptions = buildRealtimeVoiceLaunchOptions({
        requested: typedParams,
        defaults: realtimeConfig,
      });
      const requestedAgentId = resolveTalkSessionAgentId(runtimeConfig, typedParams.sessionKey);
      assertSecretOwnerAvailable("capability", "talk:realtime");
      const resolution = resolveConfiguredRealtimeVoiceProvider({
        configuredProviderId: realtimeConfig.provider,
        providerConfigs: realtimeConfig.providers,
        ...(launchOptions.model ? { providerConfigOverrides: { model: launchOptions.model } } : {}),
        cfg: runtimeConfig,
        agentId: requestedAgentId,
        defaultModel: realtimeConfig.model,
        surface: "browser-session",
      });
      const providerCapabilities = resolveRealtimeVoiceProviderCapabilities({
        provider: resolution.provider,
        providerConfig: resolution.providerConfig,
        cfg: runtimeConfig,
        agentId: requestedAgentId,
        model: launchOptions.model,
        surface: "browser-session",
      });
      if (wantsGatewayControl && providerCapabilities?.supportsGatewayControl !== true) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `Realtime provider "${resolution.provider.id}" does not support gateway-control-v1 with its configured authentication`,
          ),
        );
        return;
      }
      if (wantsCameraFrames && providerCapabilities?.supportsVideoFrames !== true) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Realtime provider ${resolution.provider.id} does not support browser video frames`,
          ),
        );
        return;
      }
      const realtimeContext = await resolveTalkRealtimeProviderInstructions({
        config: runtimeConfig,
        agentId: requestedAgentId,
        configuredInstructions: realtimeConfig.instructions,
        sessionKey: typedParams.sessionKey,
        // Legacy creates can drift to another agent's session at toolCall time, so
        // the default agent's profile must not leak into the provider session.
        requireSessionKeyForProfile: true,
        warn: (message) => context.logGateway.warn(`talk realtime context: ${message}`),
      });
      const { agentId, requestedSessionKey } = realtimeContext;
      const sessionKey = requestedSessionKey ?? buildAgentMainSessionKey({ agentId });
      if (resolution.provider.createBrowserSession && transport !== "gateway-relay") {
        const agentSessionId = resolveClientVoiceAgentSessionId({ agentId, sessionKey });
        const initialItems = agentSessionId
          ? boundTalkClientRealtimeInitialItems(
              readSessionPreviewItemsFromTranscript(
                {
                  agentId,
                  sessionId: agentSessionId,
                  sessionKey,
                },
                REALTIME_VOICE_CONTEXT_MAX_ITEMS,
                REALTIME_VOICE_CONTEXT_MAX_ITEM_CHARS,
              ).filter(
                (
                  item,
                ): item is {
                  role: "user" | "assistant";
                  text: string;
                } => item.role === "user" || item.role === "assistant",
              ),
            )
          : [];
        const tools =
          providerCapabilities?.supportsToolCalls === false
            ? []
            : [REALTIME_VOICE_AGENT_CONSULT_TOOL, REALTIME_VOICE_AGENT_CONTROL_TOOL];
        if (wantsCameraFrames && tools.length > 0) {
          tools.push(REALTIME_VOICE_DESCRIBE_VIEW_TOOL);
        }
        const instructions =
          providerCapabilities?.handlesAgentConsult === true
            ? normalizeOptionalString(realtimeContext.instructions)
            : buildRealtimeInstructions(realtimeContext.instructions);
        const requestedVoiceSessionId = normalizeOptionalString(typedParams.voiceSessionId);
        let activeVoiceSessionId = wantsGatewayControl
          ? (requestedVoiceSessionId ?? randomUUID())
          : undefined;
        const ownerConnId = normalizeOptionalString(client?.connId);
        if (wantsGatewayControl && !ownerConnId) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "gateway-control-v1 requires a connected client"),
          );
          return;
        }
        const consultRunner = createTalkClientAgentConsultRunner({
          config: runtimeConfig,
          context,
          agentId,
          sessionKey,
          ...(ownerConnId ? { ownerConnId } : {}),
          authority: resolveTalkAgentConsultAuthority(client?.connect?.scopes),
          getVoiceSessionId: () => activeVoiceSessionId,
          initialItems,
        });
        const runAgentConsult: NonNullable<
          InternalRealtimeVoiceBrowserSessionCreateRequest["runAgentConsult"]
        > = consultRunner.runPrompt;
        const gatewayControlOwner = wantsGatewayControl
          ? createTalkClientGatewayControlOwner({
              voiceSessionId: activeVoiceSessionId!,
              providerId: resolution.provider.id,
              sessionKey,
              connId: ownerConnId!,
              context,
              runAgentConsult: consultRunner.runArgs,
              appendTranscript: ({ entryId, role, text }) =>
                appendClientVoiceTranscript({
                  agentId,
                  sessionKey,
                  voiceSessionId: activeVoiceSessionId!,
                  entryId,
                  role,
                  text,
                  config: runtimeConfig,
                }),
              flushTranscript: () =>
                flushClientVoiceSessionWrites({
                  agentId,
                  voiceSessionId: activeVoiceSessionId!,
                }),
              closeLogicalSession: async () => {
                await closeClientVoiceSession({
                  agentId,
                  sessionKey,
                  voiceSessionId: activeVoiceSessionId!,
                  config: runtimeConfig,
                });
              },
            })
          : undefined;
        const browserSessionRequest: InternalRealtimeVoiceBrowserSessionCreateRequest = {
          cfg: runtimeConfig,
          agentId,
          ...(ownerConnId ? { ownerConnId } : {}),
          workspaceDir: resolveAgentWorkspaceDir(runtimeConfig, agentId),
          providerConfig: resolution.providerConfig,
          instructions,
          initialItems,
          runAgentConsult,
          ...(gatewayControlOwner ? { gatewayControl: gatewayControlOwner.control } : {}),
          ...(tools.length > 0 ? { tools } : {}),
          ...launchOptions,
        };
        const session = await resolution.provider.createBrowserSession(browserSessionRequest);
        // Client-owned voice records are minted only for client-owned transports;
        // relay sessions are created via talk.session.create and keyed by relaySessionId.
        // Widening this guard would hand relay calls a mismatched voiceSessionId.
        if (
          (session.transport === "webrtc" || session.transport === "provider-websocket") &&
          !isUnsupportedBrowserWebRtcSession(session) &&
          (!transport || session.transport === transport)
        ) {
          try {
            const sessionEntryDeadlineAt =
              session.expiresAt === undefined
                ? undefined
                : session.expiresAt - REALTIME_VOICE_CLIENT_SESSION_MIN_TTL_MS;
            if (sessionEntryDeadlineAt !== undefined && Date.now() >= sessionEntryDeadlineAt) {
              throw new Error("Realtime browser session expired during startup; try again");
            }
            // Defer persistent session creation until the provider has returned a
            // usable client transport. The write boundary rechecks the credential
            // deadline so queued storage work cannot leave a phantom chat.
            await ensureClientVoiceAgentSessionEntry({
              agentId,
              sessionKey,
              ...(sessionEntryDeadlineAt !== undefined
                ? { deadlineAt: sessionEntryDeadlineAt }
                : {}),
            });
          } catch (error) {
            try {
              await cancelInternalRealtimeVoiceBrowserSession({
                provider: resolution.provider,
                request: browserSessionRequest,
                session,
              });
            } catch (cancelError) {
              context.logGateway.warn(
                `talk browser session cleanup failed: ${formatForLog(cancelError)}`,
              );
            }
            throw error;
          }
          // Recovering 6h-abandoned calls (and retrying their digests) is not on the
          // start path; running it inline would delay use of time-sensitive provider
          // credentials behind slow channel sends. Fire it off the response path.
          void closeStaleClientVoiceSessions({
            agentId,
            config: runtimeConfig,
            excludeVoiceSessionId: normalizeOptionalString(typedParams.voiceSessionId),
            warn: (message) => context.logGateway.warn(`talk voice session recovery: ${message}`),
          }).catch((error: unknown) =>
            context.logGateway.warn(`talk voice session recovery failed: ${formatForLog(error)}`),
          );
          const voiceSessionId = createOrResumeClientVoiceSession({
            agentId,
            sessionKey,
            provider: resolution.provider.id,
            origin: "client",
            // Deployed clients sent sessionKey before transcripts existed, so capability
            // must be negotiated explicitly; declaring it turns the confirmation gate on.
            transcriptCapable:
              wantsGatewayControl ||
              typedParams.capabilities?.includes("voice-transcript") === true,
            voiceSessionId: activeVoiceSessionId ?? requestedVoiceSessionId,
          });
          activeVoiceSessionId = voiceSessionId;
          const connId = ownerConnId;
          if (connId) {
            const now = Date.now();
            pruneLegacyVoiceBindings(now);
            legacyVoiceSessionByClient.set(
              legacyVoiceBindingKey(connId, typedParams.sessionKey?.trim() || sessionKey),
              { voiceSessionId, expiresAt: now + LEGACY_VOICE_BINDING_TTL_MS },
            );
          }
          gatewayControlOwner?.activate(() =>
            cancelInternalRealtimeVoiceBrowserSession({
              provider: resolution.provider,
              request: browserSessionRequest,
              session,
            }),
          );
          respond(
            true,
            {
              ...session,
              voiceSessionId,
              ...(wantsGatewayControl ? { clientControl: { owner: "gateway" as const } } : {}),
            },
            undefined,
          );
          return;
        }
        try {
          await cancelInternalRealtimeVoiceBrowserSession({
            provider: resolution.provider,
            request: browserSessionRequest,
            session,
          });
        } catch (cancelError) {
          context.logGateway.warn(
            `talk browser session cleanup failed: ${formatForLog(cancelError)}`,
          );
        }
        if (transport) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              `Realtime provider "${resolution.provider.id}" does not support requested browser transport "${transport}"`,
            ),
          );
          return;
        }
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Realtime provider "${resolution.provider.id}" does not support client-owned realtime sessions`,
        ),
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          err instanceof AgentSelectionRequiredError
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          formatForLog(err),
        ),
      );
    }
  },
  "talk.client.toolCall": async (request) => {
    const { params, respond } = request;
    if (
      !assertValidParams(params, validateTalkClientToolCallParams, "talk.client.toolCall", respond)
    ) {
      return;
    }
    if (params.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported realtime Talk tool: ${params.name}`),
      );
      return;
    }

    const config = request.context.getRuntimeConfig();
    const agentId = resolveTalkSessionAgentId(config, params.sessionKey);
    const relaySessionId = normalizeOptionalString(params.relaySessionId);
    const connId = normalizeOptionalString(request.client?.connId);
    pruneLegacyVoiceBindings();
    const explicitVoiceSessionId = normalizeOptionalString(params.voiceSessionId);
    if (relaySessionId && explicitVoiceSessionId && explicitVoiceSessionId !== relaySessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "relaySessionId and voiceSessionId must match"),
      );
      return;
    }
    let confirmationGrant: ClientVoiceConfirmationGrant | undefined;
    let voiceSessionId: string;
    try {
      // Shipped clients may consult without ever creating a voice session (old app,
      // restarted gateway, ambiguous open records). Implicitly create one instead of
      // erroring so confirmation and mutation evidence stay always-on.
      voiceSessionId =
        explicitVoiceSessionId ??
        relaySessionId ??
        (connId
          ? legacyVoiceSessionByClient.get(legacyVoiceBindingKey(connId, params.sessionKey))
              ?.voiceSessionId
          : undefined) ??
        resolveOpenClientVoiceSessionId({ agentId, sessionKey: params.sessionKey }) ??
        createOrResumeClientVoiceSession({
          agentId,
          sessionKey: params.sessionKey,
          origin: "client",
        });
      // Pin the resolved id to this connection so a legacy client's later consults
      // reuse one record instead of forking a new never-closed session each time.
      if (connId && !relaySessionId) {
        const now = Date.now();
        pruneLegacyVoiceBindings(now);
        legacyVoiceSessionByClient.set(legacyVoiceBindingKey(connId, params.sessionKey), {
          voiceSessionId,
          expiresAt: now + LEGACY_VOICE_BINDING_TTL_MS,
        });
      }
      if (relaySessionId && connId) {
        // Initialize the canonical session row BEFORE binding: the bind drains the
        // relay's buffered finals into transcript appends, which fail without it.
        await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey: params.sessionKey });
        ensureTalkRealtimeRelayVoiceSession({
          relaySessionId,
          connId,
          sessionKey: params.sessionKey,
        });
        await flushTalkRealtimeRelayVoiceWrites({ relaySessionId, connId });
      }
      const parsedArgs = parseRealtimeVoiceAgentConsultArgs(params.args ?? {});
      const origin = assertClientVoiceSessionOpen({
        agentId,
        sessionKey: params.sessionKey,
        voiceSessionId,
      });
      if (origin === "relay" && (!relaySessionId || !connId)) {
        throw new Error(
          "relay-owned voice sessions require relaySessionId and connection ownership",
        );
      }
      if (parsedArgs.confirmationId) {
        confirmationGrant = authorizeClientVoiceConfirmation({
          agentId,
          voiceSessionId,
          confirmationId: parsedArgs.confirmationId,
        });
      }
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
      return;
    }

    const result = await startTalkRealtimeAgentConsult({
      context: request.context,
      client: request.client,
      isWebchatConnect: request.isWebchatConnect,
      requestId: request.req.id,
      sessionKey: params.sessionKey,
      callId: params.callId,
      args: params.args ?? {},
      relaySessionId: normalizeOptionalString(params.relaySessionId),
      connId,
      onRunStarted: (runId) => {
        registerClientVoiceConsultRun({
          agentId,
          sessionKey: params.sessionKey,
          voiceSessionId,
          runId,
          config: request.context.getRuntimeConfig(),
        });
        if (confirmationGrant) {
          bindAuthorizedClientVoiceConfirmation({ grant: confirmationGrant, runId });
        }
      },
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(
      true,
      {
        runId: result.runId,
        idempotencyKey: result.idempotencyKey,
      },
      undefined,
    );
  },
  "talk.client.transcript": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateTalkClientTranscriptParams,
        "talk.client.transcript",
        respond,
      )
    ) {
      return;
    }
    try {
      const config = context.getRuntimeConfig();
      await appendClientVoiceTranscript({
        agentId: resolveTalkSessionAgentId(config, params.sessionKey),
        sessionKey: params.sessionKey,
        voiceSessionId: params.voiceSessionId,
        entryId: params.entryId,
        role: params.role,
        text: params.text,
        ...(params.timestamp !== undefined ? { timestamp: params.timestamp } : {}),
        config,
      });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    }
  },
  "talk.client.close": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateTalkClientCloseParams, "talk.client.close", respond)) {
      return;
    }
    try {
      if (
        await closeTalkClientGatewayControlSession({
          voiceSessionId: params.voiceSessionId,
          sessionKey: params.sessionKey,
          connId: normalizeOptionalString(client?.connId),
        })
      ) {
        respond(true, { ok: true }, undefined);
        return;
      }
      const config = context.getRuntimeConfig();
      const agentId = resolveTalkSessionAgentId(config, params.sessionKey);
      const origin = resolveClientVoiceSessionOrigin({
        agentId,
        sessionKey: params.sessionKey,
        voiceSessionId: params.voiceSessionId,
      });
      if (origin === "relay") {
        throw new Error("relay-owned voice sessions close through talk.session.close");
      }
      await closeClientVoiceSession({
        agentId,
        sessionKey: params.sessionKey,
        voiceSessionId: params.voiceSessionId,
        config,
      });
      const connId = normalizeOptionalString(client?.connId);
      if (connId) {
        const key = legacyVoiceBindingKey(connId, params.sessionKey);
        if (legacyVoiceSessionByClient.get(key)?.voiceSessionId === params.voiceSessionId) {
          legacyVoiceSessionByClient.delete(key);
        }
      }
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    }
  },
  "talk.client.steer": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateTalkClientSteerParams, "talk.client.steer", respond)) {
      return;
    }
    if (
      !hasOwnedActiveTalkClientRun({
        context,
        clientConnId: client?.connId,
        sessionKey: params.sessionKey,
      })
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "talk.client.steer requires an active browser-owned Talk run",
        ),
      );
      return;
    }
    try {
      const result = await controlRealtimeVoiceAgentRun({
        sessionKey: params.sessionKey,
        text: params.text,
        mode: params.mode,
      });
      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          err instanceof AgentSelectionRequiredError
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          formatForLog(err),
        ),
      );
    }
  },
};
