import { randomUUID } from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateTalkClientCreateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { buildAgentMainSessionKey } from "../../routing/session-key.js";
import { assertSecretOwnerAvailable } from "../../secrets/runtime-degraded-state.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL } from "../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL } from "../../talk/agent-run-control-shared.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import {
  appendClientVoiceTranscript,
  closeClientVoiceSession,
  closeStaleClientVoiceSessions,
  createOrResumeClientVoiceSession,
  ensureClientVoiceAgentSessionEntry,
  flushClientVoiceSessionWrites,
  resolveClientVoiceAgentSessionId,
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
import {
  authorizeGatewaySessionCreation,
  resolveSandboxedSessionCreation,
} from "../operator-role-policy.js";
import { readSessionPreviewItemsFromTranscript } from "../session-transcript-readers.js";
import {
  boundTalkClientRealtimeInitialItems,
  createTalkClientAgentConsultRunner,
  createTalkClientGatewayControlOwner,
  resolveTalkAgentConsultAuthority,
} from "../talk-client-gateway-control.js";
import { formatForLog } from "../ws-log.js";
import { rememberLegacyVoiceBinding } from "./talk-client-legacy-voice-bindings.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  isUnsupportedBrowserWebRtcSession,
  resolveTalkRealtimeProviderInstructions,
} from "./talk-shared.js";
import type { GatewayRequestHandler, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const REALTIME_VOICE_CONTEXT_MAX_ITEMS = 16;
const REALTIME_VOICE_CONTEXT_MAX_ITEM_CHARS = 800;
const REALTIME_VOICE_CLIENT_SESSION_MIN_TTL_MS = 5_000;
function rejectTalkClientRequest(
  respond: RespondFn,
  code: Parameters<typeof errorShape>[0],
  message: string,
): void {
  respond(false, undefined, errorShape(code, message));
}

export const createTalkClient: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
}) => {
  if (!assertValidParams(params, validateTalkClientCreateParams, "talk.client.create", respond)) {
    return;
  }
  try {
    const runtimeConfig = context.getRuntimeConfig();
    const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, params.provider);
    const mode = normalizeOptionalLowercaseString(params.mode) ?? realtimeConfig.mode ?? "realtime";
    if (mode !== "realtime") {
      rejectTalkClientRequest(
        respond,
        ErrorCodes.INVALID_REQUEST,
        `talk.client.create only supports mode="realtime"; use talk.catalog for ${mode} provider discovery`,
      );
      return;
    }
    const brain =
      normalizeOptionalLowercaseString(params.brain) ?? realtimeConfig.brain ?? "agent-consult";
    if (brain !== "agent-consult") {
      rejectTalkClientRequest(
        respond,
        ErrorCodes.INVALID_REQUEST,
        `talk.client.create only supports brain="agent-consult"`,
      );
      return;
    }
    const transport =
      normalizeOptionalLowercaseString(params.transport) ?? realtimeConfig.transport;
    const wantsCameraFrames = params.capabilities?.includes("camera-frame") === true;
    const wantsGatewayControl = params.capabilities?.includes("gateway-control-v1") === true;
    if (wantsGatewayControl && wantsCameraFrames) {
      rejectTalkClientRequest(
        respond,
        ErrorCodes.INVALID_REQUEST,
        "gateway-control-v1 supports audio-only WebRTC sessions",
      );
      return;
    }
    if (transport === "managed-room") {
      rejectTalkClientRequest(
        respond,
        ErrorCodes.UNAVAILABLE,
        "managed-room realtime Talk sessions are not available in the browser UI yet",
      );
      return;
    }
    if (transport === "gateway-relay") {
      rejectTalkClientRequest(
        respond,
        ErrorCodes.INVALID_REQUEST,
        wantsCameraFrames
          ? "gateway-relay does not support browser video frames"
          : `talk.client.create is client-owned; use talk.session.create for gateway-relay`,
      );
      return;
    }
    const launchOptions = buildRealtimeVoiceLaunchOptions({
      requested: params,
      defaults: realtimeConfig,
    });
    const requestedAgentId = resolveTalkSessionAgentId(runtimeConfig, params.sessionKey);
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
      rejectTalkClientRequest(
        respond,
        ErrorCodes.UNAVAILABLE,
        `Realtime provider "${resolution.provider.id}" does not support gateway-control-v1 with its configured authentication`,
      );
      return;
    }
    if (wantsCameraFrames && providerCapabilities?.supportsVideoFrames !== true) {
      rejectTalkClientRequest(
        respond,
        ErrorCodes.INVALID_REQUEST,
        `Realtime provider ${resolution.provider.id} does not support browser video frames`,
      );
      return;
    }
    const realtimeContext = await resolveTalkRealtimeProviderInstructions({
      config: runtimeConfig,
      agentId: requestedAgentId,
      configuredInstructions: realtimeConfig.instructions,
      sessionKey: params.sessionKey,
      // Legacy creates can drift to another agent's session at toolCall time, so
      // the default agent's profile must not leak into the provider session.
      requireSessionKeyForProfile: true,
      warn: (message) => context.logGateway.warn(`talk realtime context: ${message}`),
    });
    const { agentId, requestedSessionKey } = realtimeContext;
    const sessionKey = requestedSessionKey ?? buildAgentMainSessionKey({ agentId });
    const creationError = authorizeGatewaySessionCreation({
      cfg: runtimeConfig,
      client,
      agentId,
    });
    if (creationError) {
      respond(false, undefined, creationError);
      return;
    }
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
      const requestedVoiceSessionId = normalizeOptionalString(params.voiceSessionId);
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
            creation: resolveSandboxedSessionCreation(client, runtimeConfig),
            deadlineAt: sessionEntryDeadlineAt,
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
          excludeVoiceSessionId: normalizeOptionalString(params.voiceSessionId),
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
            wantsGatewayControl || params.capabilities?.includes("voice-transcript") === true,
          voiceSessionId: activeVoiceSessionId ?? requestedVoiceSessionId,
        });
        activeVoiceSessionId = voiceSessionId;
        const connId = ownerConnId;
        if (connId) {
          rememberLegacyVoiceBinding({
            connId,
            sessionKey: params.sessionKey?.trim() || sessionKey,
            voiceSessionId,
          });
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
        rejectTalkClientRequest(
          respond,
          ErrorCodes.UNAVAILABLE,
          `Realtime provider "${resolution.provider.id}" does not support requested browser transport "${transport}"`,
        );
        return;
      }
    }
    rejectTalkClientRequest(
      respond,
      ErrorCodes.UNAVAILABLE,
      `Realtime provider "${resolution.provider.id}" does not support client-owned realtime sessions`,
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
};
