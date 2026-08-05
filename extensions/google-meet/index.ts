// Google Meet plugin entrypoint registers its OpenClaw integration.
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/channel-actions";
import { ErrorCodes, type GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult as json } from "openclaw/plugin-sdk/tool-results";
import { createMeetingTranscriptSourceProvider } from "openclaw/plugin-sdk/transcripts";
import { buildGoogleMeetCalendarDayWindow, listGoogleMeetCalendarEvents } from "./src/calendar.js";
import { GOOGLE_MEET_CLI_DESCRIPTOR } from "./src/cli-output-mode.js";
import {
  buildGoogleMeetPreflightReport,
  endGoogleMeetActiveConference,
  fetchLatestGoogleMeetConferenceRecord,
} from "./src/meet.js";
import { handleGoogleMeetNodeHostCommand } from "./src/node-host.js";
import {
  createGoogleMeetChromeNodeInvokePolicy,
  GOOGLE_MEET_CHROME_NODE_COMMAND,
} from "./src/node-invoke-policy.js";
import {
  asParamRecord,
  assertGoogleMeetAgentToolActionSupported,
  callGoogleMeetGatewayFromTool,
  createAndJoinMeetFromParams,
  createGoogleMeetRuntimeAccessor,
  createMeetFromParams,
  exportGoogleMeetBundleFromParams,
  fetchResolvedGoogleMeetArtifacts,
  fetchResolvedGoogleMeetAttendance,
  formatGoogleMeetGatewayError,
  keepTrustedToolAgentId,
  loadGoogleMeetCliModule,
  normalizeMode,
  normalizeTransport,
  resolveArtifactQueryFromParams,
  resolveGoogleMeetTokenFromParams,
  resolveMeetingFromParams,
  resolveMeetingInput,
  resolveSpaceFromParams,
  sendGoogleMeetGatewayError,
  shouldJoinCreatedMeet,
  testing,
} from "./src/plugin-helpers.js";
import { googleMeetConfigSchema, GoogleMeetToolSchema } from "./src/plugin-schema.js";

export { testing };

/** @deprecated Use `testing`. */
export { testing as __testing };

export default definePluginEntry({
  id: "google-meet",
  name: "Google Meet",
  description: "Join Google Meet calls through Chrome or Twilio transports",
  configSchema: googleMeetConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = googleMeetConfigSchema.parse(api.pluginConfig);
    const ensureRuntime = createGoogleMeetRuntimeAccessor({ api, config });
    const registerGatewayMethod = (
      method: string,
      handler: (options: GatewayRequestHandlerOptions) => Promise<void>,
    ) => {
      api.registerGatewayMethod(method, async (options) => {
        try {
          await handler(options);
        } catch (err) {
          sendGoogleMeetGatewayError(options.respond, err);
        }
      });
    };
    const resolveTrustedJoinParams = ({ params, client }: GatewayRequestHandlerOptions) => {
      const trustedParams = keepTrustedToolAgentId(asParamRecord(params), client);
      return {
        url: resolveMeetingInput(config, trustedParams.url),
        transport: normalizeTransport(trustedParams.transport),
        mode: normalizeMode(trustedParams.mode),
        dialInNumber: normalizeOptionalString(trustedParams.dialInNumber),
        pin: normalizeOptionalString(trustedParams.pin),
        dtmfSequence: normalizeOptionalString(trustedParams.dtmfSequence),
        message: normalizeOptionalString(trustedParams.message),
        requesterSessionKey: normalizeOptionalString(trustedParams.requesterSessionKey),
        agentId: normalizeOptionalString(trustedParams.agentId),
      };
    };
    const queryActions = {
      latest: async (raw: Record<string, unknown>) => {
        const token = await resolveGoogleMeetTokenFromParams(config, raw);
        const resolved = await resolveMeetingFromParams({
          config,
          raw,
          accessToken: token.accessToken,
        });
        return {
          ...(await fetchLatestGoogleMeetConferenceRecord({
            accessToken: token.accessToken,
            meeting: resolved.meeting,
          })),
          ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
        };
      },
      calendar_events: async (raw: Record<string, unknown>) => {
        const token = await resolveGoogleMeetTokenFromParams(config, raw);
        const window = raw.today === true ? buildGoogleMeetCalendarDayWindow() : {};
        return listGoogleMeetCalendarEvents({
          accessToken: token.accessToken,
          calendarId: normalizeOptionalString(raw.calendarId),
          eventQuery: normalizeOptionalString(raw.event),
          ...window,
        });
      },
      artifacts: async (raw: Record<string, unknown>) =>
        fetchResolvedGoogleMeetArtifacts(await resolveArtifactQueryFromParams(config, raw)),
      attendance: async (raw: Record<string, unknown>) =>
        fetchResolvedGoogleMeetAttendance(await resolveArtifactQueryFromParams(config, raw)),
    };
    api.registerTranscriptSourceProvider(
      createMeetingTranscriptSourceProvider({
        id: "google-meet",
        aliases: ["googlemeet", "meet"],
        name: "Google Meet",
        runtime: async () => (await ensureRuntime()).transcriptSourceRuntime(),
      }),
    );

    registerGatewayMethod("googlemeet.join", async (options) => {
      const runtime = await ensureRuntime();
      options.respond(true, await runtime.join(resolveTrustedJoinParams(options)));
    });

    registerGatewayMethod("googlemeet.create", async ({ params, client, respond }) => {
      const raw = keepTrustedToolAgentId(asParamRecord(params), client);
      respond(
        true,
        shouldJoinCreatedMeet(raw)
          ? await createAndJoinMeetFromParams({
              config,
              runtime: api.runtime,
              raw,
              ensureRuntime,
            })
          : await createMeetFromParams({ config, runtime: api.runtime, raw }),
      );
    });

    registerGatewayMethod("googlemeet.status", async ({ params, respond }) => {
      const runtime = await ensureRuntime();
      respond(true, await runtime.status(normalizeOptionalString(params?.sessionId)));
    });

    registerGatewayMethod("googlemeet.transcript", async ({ params, respond }) => {
      const sessionId = normalizeOptionalString(params?.sessionId);
      if (!sessionId) {
        sendGoogleMeetGatewayError(
          respond,
          new Error("sessionId required"),
          ErrorCodes.INVALID_REQUEST,
        );
        return;
      }
      const sinceIndex = (params as { sinceIndex?: unknown } | undefined)?.sinceIndex;
      if (
        sinceIndex !== undefined &&
        (typeof sinceIndex !== "number" || !Number.isSafeInteger(sinceIndex) || sinceIndex < 0)
      ) {
        sendGoogleMeetGatewayError(
          respond,
          new Error("sinceIndex must be a non-negative safe integer"),
          ErrorCodes.INVALID_REQUEST,
        );
        return;
      }
      const runtime = await ensureRuntime();
      respond(
        true,
        await runtime.transcript(sessionId, sinceIndex === undefined ? {} : { sinceIndex }),
      );
    });

    registerGatewayMethod("googlemeet.recoverCurrentTab", async ({ params, respond }) => {
      const runtime = await ensureRuntime();
      respond(
        true,
        await runtime.recoverCurrentTab({
          url: normalizeOptionalString(params?.url),
          transport: normalizeTransport(params?.transport),
        }),
      );
    });

    registerGatewayMethod("googlemeet.setup", async ({ params, respond }) => {
      const runtime = await ensureRuntime();
      respond(
        true,
        await runtime.setupStatus({
          transport: normalizeTransport(params?.transport),
          mode: normalizeMode(params?.mode),
          dialInNumber: normalizeOptionalString(params?.dialInNumber),
        }),
      );
    });

    for (const [method, action] of [
      ["googlemeet.latest", "latest"],
      ["googlemeet.calendarEvents", "calendar_events"],
      ["googlemeet.artifacts", "artifacts"],
      ["googlemeet.attendance", "attendance"],
    ] as const) {
      registerGatewayMethod(method, async ({ params, respond }) => {
        respond(true, await queryActions[action](asParamRecord(params)));
      });
    }

    registerGatewayMethod("googlemeet.export", async ({ params, respond }) => {
      respond(true, await exportGoogleMeetBundleFromParams(config, asParamRecord(params)));
    });

    registerGatewayMethod("googlemeet.leave", async ({ params, respond }) => {
      const sessionId = normalizeOptionalString(params?.sessionId);
      if (!sessionId) {
        sendGoogleMeetGatewayError(
          respond,
          new Error("sessionId required"),
          ErrorCodes.INVALID_REQUEST,
        );
        return;
      }
      const runtime = await ensureRuntime();
      respond(true, await runtime.leave(sessionId));
    });

    registerGatewayMethod("googlemeet.endActiveConference", async ({ params, respond }) => {
      const raw = asParamRecord(params);
      const token = await resolveGoogleMeetTokenFromParams(config, raw);
      respond(
        true,
        await endGoogleMeetActiveConference({
          accessToken: token.accessToken,
          meeting: resolveMeetingInput(config, raw.meeting),
        }),
      );
    });

    registerGatewayMethod("googlemeet.speak", async ({ params, respond }) => {
      const sessionId = normalizeOptionalString(params?.sessionId);
      if (!sessionId) {
        sendGoogleMeetGatewayError(
          respond,
          new Error("sessionId required"),
          ErrorCodes.INVALID_REQUEST,
        );
        return;
      }
      const runtime = await ensureRuntime();
      respond(true, await runtime.speak(sessionId, normalizeOptionalString(params?.message)));
    });

    registerGatewayMethod("googlemeet.testSpeech", async (options) => {
      const runtime = await ensureRuntime();
      options.respond(true, await runtime.testSpeech(resolveTrustedJoinParams(options)));
    });

    registerGatewayMethod("googlemeet.testListen", async ({ params, client, respond }) => {
      const trustedParams = keepTrustedToolAgentId(asParamRecord(params), client);
      const runtime = await ensureRuntime();
      respond(
        true,
        await runtime.testListen({
          url: resolveMeetingInput(config, trustedParams.url),
          transport: normalizeTransport(trustedParams.transport),
          mode: normalizeMode(trustedParams.mode),
          agentId: normalizeOptionalString(trustedParams.agentId),
          timeoutMs: readPositiveIntegerParam(trustedParams, "timeoutMs"),
        }),
      );
    });

    api.registerTool(
      (toolContext) => ({
        name: "google_meet",
        label: "Google Meet",
        description:
          "Join and track Google Meet sessions through Chrome or Twilio. Call setup_status before join/create/test_listen/test_speech; if it reports a Chrome node offline, local audio missing, or missing Twilio dial plan, surface that blocker instead of retrying or switching transports. Twilio cannot dial a Meet URL directly: provide dialInNumber plus optional pin/dtmfSequence, or configure twilio.defaultDialInNumber. Offline nodes are diagnostics only, not usable candidates. If local Chrome talk-back audio is unsupported on this OS, use mode=transcribe, transport=twilio, or a macOS chrome-node for agent/bidi Chrome. If a Meet tab is already open after a timeout, call recover_current_tab before retrying join to report login, permission, or admission blockers without opening another tab.",
        parameters: GoogleMeetToolSchema,
        async execute(_toolCallId, params) {
          const raw = asParamRecord(params);
          const requesterSessionKey = normalizeOptionalString(toolContext.sessionKey);
          // Agent ownership comes from trusted tool context, never model-supplied params.
          // Some harnesses omit agentId but still provide its canonical session key.
          const contextAgentId =
            toolContext.agentId ?? parseAgentSessionKey(requesterSessionKey)?.agentId;
          const agentId = contextAgentId ? normalizeAgentId(contextAgentId) : undefined;
          try {
            // Main-agent sessions belong to the persistent Gateway runtime. Only
            // non-default identities need trusted in-process routing metadata.
            const needsTrustedAgentRouting = Boolean(agentId && agentId !== "main");
            const useTrustedRuntime = needsTrustedAgentRouting
              ? await api.runtime.gateway.isAvailable()
              : false;
            if (needsTrustedAgentRouting && !useTrustedRuntime) {
              throw new Error("Per-agent Google Meet routing requires a Gateway-hosted agent run.");
            }
            const rawWithRequester = {
              ...raw,
              ...(requesterSessionKey ? { requesterSessionKey } : {}),
              ...(useTrustedRuntime ? { agentId } : {}),
            };
            assertGoogleMeetAgentToolActionSupported({ config, raw });
            switch (raw.action) {
              case "join":
              case "create":
              case "test_speech":
              case "test_listen": {
                return json(
                  await callGoogleMeetGatewayFromTool({
                    config,
                    action: raw.action,
                    raw: rawWithRequester,
                    runtime: useTrustedRuntime ? api.runtime : undefined,
                  }),
                );
              }
              case "status":
              case "transcript":
              case "recover_current_tab":
              case "setup_status":
              case "end_active_conference":
                return json(
                  await callGoogleMeetGatewayFromTool({ config, action: raw.action, raw }),
                );
              case "resolve_space": {
                const { token: _token, ...result } = await resolveSpaceFromParams(config, raw);
                return json(result);
              }
              case "preflight": {
                const { meeting, token, space } = await resolveSpaceFromParams(config, raw);
                return json(
                  buildGoogleMeetPreflightReport({
                    input: meeting,
                    space,
                    previewAcknowledged: config.preview.enrollmentAcknowledged,
                    tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
                  }),
                );
              }
              case "latest":
              case "calendar_events":
              case "artifacts":
              case "attendance":
                return json(await queryActions[raw.action](raw));
              case "export": {
                return json(await exportGoogleMeetBundleFromParams(config, raw));
              }
              case "leave":
              case "speak": {
                const sessionId = normalizeOptionalString(raw.sessionId);
                if (!sessionId) {
                  throw new Error("sessionId required");
                }
                return json(
                  await callGoogleMeetGatewayFromTool({ config, action: raw.action, raw }),
                );
              }
              default:
                throw new Error("unknown google_meet action");
            }
          } catch (err) {
            return json(formatGoogleMeetGatewayError(err));
          }
        },
      }),
      { name: "google_meet" },
    );

    api.registerNodeHostCommand({
      command: GOOGLE_MEET_CHROME_NODE_COMMAND,
      cap: "google-meet",
      dangerous: true,
      handle: handleGoogleMeetNodeHostCommand,
    });
    api.registerNodeInvokePolicy(createGoogleMeetChromeNodeInvokePolicy(config));

    api.registerCli(
      async ({ program }) => {
        const { registerGoogleMeetCli } = await loadGoogleMeetCliModule();
        registerGoogleMeetCli({
          program,
          config,
          ensureRuntime,
        });
      },
      {
        commands: ["googlemeet"],
        descriptors: [GOOGLE_MEET_CLI_DESCRIPTOR],
      },
    );
  },
});
