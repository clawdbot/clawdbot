// Google Meet plugin entrypoint registers its OpenClaw integration.
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult as json } from "openclaw/plugin-sdk/tool-results";
import { GOOGLE_MEET_CLI_DESCRIPTOR } from "./src/cli-output-mode.js";
import {
  asParamRecord,
  assertGoogleMeetAgentToolActionSupported,
  callGoogleMeetGatewayFromTool,
  createGoogleMeetRuntimeAccessor,
  createLazyGoogleMeetNodeInvokePolicy,
  formatGoogleMeetGatewayError,
  keepTrustedToolAgentId,
  loadGoogleMeetCliModule,
  loadGoogleMeetNodeHostModule,
  loadGoogleMeetPluginHelpers,
  normalizeMode,
  normalizeTransport,
  resolveMeetingInput,
  sendGoogleMeetGatewayError,
  shouldJoinCreatedMeet,
} from "./src/plugin-registration.js";
import { googleMeetConfigSchema, GoogleMeetToolSchema } from "./src/plugin-schema.js";
import { GOOGLE_MEET_NODE_COMMAND } from "./src/transports/google-meet-platform-constants.js";

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
        const helpers = await loadGoogleMeetPluginHelpers();
        const token = await helpers.resolveGoogleMeetTokenFromParams(config, raw);
        const resolved = await helpers.resolveMeetingFromParams({
          config,
          raw,
          accessToken: token.accessToken,
        });
        return {
          ...(await helpers.fetchLatestGoogleMeetConferenceRecord({
            accessToken: token.accessToken,
            meeting: resolved.meeting,
          })),
          ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
        };
      },
      calendar_events: async (raw: Record<string, unknown>) => {
        const helpers = await loadGoogleMeetPluginHelpers();
        const token = await helpers.resolveGoogleMeetTokenFromParams(config, raw);
        const window = raw.today === true ? helpers.buildGoogleMeetCalendarDayWindow() : {};
        return helpers.listGoogleMeetCalendarEvents({
          accessToken: token.accessToken,
          calendarId: normalizeOptionalString(raw.calendarId),
          eventQuery: normalizeOptionalString(raw.event),
          ...window,
        });
      },
      artifacts: async (raw: Record<string, unknown>) => {
        const helpers = await loadGoogleMeetPluginHelpers();
        return helpers.fetchResolvedGoogleMeetArtifacts(
          await helpers.resolveArtifactQueryFromParams(config, raw),
        );
      },
      attendance: async (raw: Record<string, unknown>) => {
        const helpers = await loadGoogleMeetPluginHelpers();
        return helpers.fetchResolvedGoogleMeetAttendance(
          await helpers.resolveArtifactQueryFromParams(config, raw),
        );
      },
    };
    const transcriptSourceRuntime = async () => (await ensureRuntime()).transcriptSourceRuntime();
    api.registerTranscriptSourceProvider({
      id: "google-meet",
      aliases: ["googlemeet", "meet"],
      name: "Google Meet",
      sourceKinds: ["live-caption"],
      start: async (request) =>
        await (await transcriptSourceRuntime()).startTranscriptSource(request),
      stop: async (request) =>
        await (await transcriptSourceRuntime()).stopTranscriptSource(request),
    });

    registerGatewayMethod("googlemeet.join", async (options) => {
      const runtime = await ensureRuntime();
      options.respond(true, await runtime.join(resolveTrustedJoinParams(options)));
    });

    registerGatewayMethod("googlemeet.create", async ({ params, client, respond }) => {
      const raw = keepTrustedToolAgentId(asParamRecord(params), client);
      const helpers = await loadGoogleMeetPluginHelpers();
      respond(
        true,
        shouldJoinCreatedMeet(raw)
          ? await helpers.createAndJoinMeetFromParams({
              config,
              runtime: api.runtime,
              raw,
              ensureRuntime,
            })
          : await helpers.createMeetFromParams({ config, runtime: api.runtime, raw }),
      );
    });

    registerGatewayMethod("googlemeet.status", async ({ params, respond }) => {
      const runtime = await ensureRuntime();
      respond(true, await runtime.status(normalizeOptionalString(params?.sessionId)));
    });

    registerGatewayMethod("googlemeet.transcript", async ({ params, respond }) => {
      const sessionId = normalizeOptionalString(params?.sessionId);
      if (!sessionId) {
        sendGoogleMeetGatewayError(respond, new Error("sessionId required"), "INVALID_REQUEST");
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
          "INVALID_REQUEST",
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
      const helpers = await loadGoogleMeetPluginHelpers();
      respond(true, await helpers.exportGoogleMeetBundleFromParams(config, asParamRecord(params)));
    });

    registerGatewayMethod("googlemeet.leave", async ({ params, respond }) => {
      const sessionId = normalizeOptionalString(params?.sessionId);
      if (!sessionId) {
        sendGoogleMeetGatewayError(respond, new Error("sessionId required"), "INVALID_REQUEST");
        return;
      }
      const runtime = await ensureRuntime();
      respond(true, await runtime.leave(sessionId));
    });

    registerGatewayMethod("googlemeet.endActiveConference", async ({ params, respond }) => {
      const raw = asParamRecord(params);
      const helpers = await loadGoogleMeetPluginHelpers();
      const token = await helpers.resolveGoogleMeetTokenFromParams(config, raw);
      respond(
        true,
        await helpers.endGoogleMeetActiveConference({
          accessToken: token.accessToken,
          meeting: resolveMeetingInput(config, raw.meeting),
        }),
      );
    });

    registerGatewayMethod("googlemeet.speak", async ({ params, respond }) => {
      const sessionId = normalizeOptionalString(params?.sessionId);
      if (!sessionId) {
        sendGoogleMeetGatewayError(respond, new Error("sessionId required"), "INVALID_REQUEST");
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
      const { readPositiveIntegerParam } = await import("openclaw/plugin-sdk/param-readers");
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
          "Join and track Google Meet sessions through Chrome or Twilio. Call setup_status before join/create/test_listen/test_speech; if it reports a Chrome node offline, local audio missing, or missing Twilio dial plan, surface that blocker instead of retrying or switching transports. Twilio cannot dial a Meet URL directly: provide dialInNumber plus optional pin/dtmfSequence, or configure twilio.defaultDialInNumber. Offline nodes are diagnostics only, not usable candidates. Local Chrome talk-back needs macOS with BlackHole 2ch or Linux with PipeWire-Pulse; otherwise use mode=transcribe, transport=twilio, or a supported chrome-node. If a Meet tab is already open after a timeout, call recover_current_tab before retrying join to report login, permission, or admission blockers without opening another tab.",
        parameters: GoogleMeetToolSchema,
        async execute(_toolCallId, params) {
          const raw = asParamRecord(params);
          const requesterSessionKey = normalizeOptionalString(toolContext.sessionKey);
          try {
            const { normalizeAgentId, parseAgentSessionKey } =
              await import("openclaw/plugin-sdk/routing");
            // Agent ownership comes from trusted tool context, never model-supplied params.
            // Some harnesses omit agentId but still provide its canonical session key.
            const contextAgentId =
              toolContext.agentId ?? parseAgentSessionKey(requesterSessionKey)?.agentId;
            const agentId = contextAgentId ? normalizeAgentId(contextAgentId) : undefined;
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
                const helpers = await loadGoogleMeetPluginHelpers();
                const { token: _token, ...result } = await helpers.resolveSpaceFromParams(
                  config,
                  raw,
                );
                return json(result);
              }
              case "preflight": {
                const helpers = await loadGoogleMeetPluginHelpers();
                const { meeting, token, space } = await helpers.resolveSpaceFromParams(config, raw);
                return json(
                  helpers.buildGoogleMeetPreflightReport({
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
                const helpers = await loadGoogleMeetPluginHelpers();
                return json(await helpers.exportGoogleMeetBundleFromParams(config, raw));
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
      command: GOOGLE_MEET_NODE_COMMAND,
      cap: "google-meet",
      dangerous: true,
      handle: async (paramsJSON) =>
        await (await loadGoogleMeetNodeHostModule()).handleGoogleMeetNodeHostCommand(paramsJSON),
    });
    api.registerNodeInvokePolicy(createLazyGoogleMeetNodeInvokePolicy(config));

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
