// Google Meet plugin entrypoint registers its OpenClaw integration.
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/channel-actions";
import { ErrorCodes, type GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult as json } from "openclaw/plugin-sdk/tool-results";
import { createMeetingTranscriptSourceProvider } from "openclaw/plugin-sdk/transcripts";
import { buildGoogleMeetCalendarDayWindow, listGoogleMeetCalendarEvents } from "./src/calendar.js";
import {
  buildGoogleMeetPreflightReport,
  endGoogleMeetActiveConference,
  fetchGoogleMeetArtifacts,
  fetchGoogleMeetAttendance,
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
    api.registerTranscriptSourceProvider(
      createMeetingTranscriptSourceProvider({
        id: "google-meet",
        aliases: ["googlemeet", "meet"],
        name: "Google Meet",
        runtime: async () => (await ensureRuntime()).transcriptSourceRuntime(),
      }),
    );

    api.registerGatewayMethod(
      "googlemeet.join",
      async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
        try {
          const trustedParams = keepTrustedToolAgentId(asParamRecord(params), client);
          const rt = await ensureRuntime();
          const result = await rt.join({
            url: resolveMeetingInput(config, trustedParams.url),
            transport: normalizeTransport(trustedParams.transport),
            mode: normalizeMode(trustedParams.mode),
            dialInNumber: normalizeOptionalString(trustedParams.dialInNumber),
            pin: normalizeOptionalString(trustedParams.pin),
            dtmfSequence: normalizeOptionalString(trustedParams.dtmfSequence),
            message: normalizeOptionalString(trustedParams.message),
            requesterSessionKey: normalizeOptionalString(trustedParams.requesterSessionKey),
            agentId: normalizeOptionalString(trustedParams.agentId),
          });
          respond(true, result);
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.create",
      async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
        try {
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
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          respond(true, await rt.status(normalizeOptionalString(params?.sessionId)));
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.transcript",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
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
          const rt = await ensureRuntime();
          respond(
            true,
            await rt.transcript(sessionId, sinceIndex === undefined ? {} : { sinceIndex }),
          );
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.recoverCurrentTab",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          respond(
            true,
            await rt.recoverCurrentTab({
              url: normalizeOptionalString(params?.url),
              transport: normalizeTransport(params?.transport),
            }),
          );
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.setup",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          respond(
            true,
            await rt.setupStatus({
              transport: normalizeTransport(params?.transport),
              mode: normalizeMode(params?.mode),
              dialInNumber: normalizeOptionalString(params?.dialInNumber),
            }),
          );
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.latest",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = asParamRecord(params);
          const token = await resolveGoogleMeetTokenFromParams(config, raw);
          const resolved = await resolveMeetingFromParams({
            config,
            raw,
            accessToken: token.accessToken,
          });
          respond(true, {
            ...(await fetchLatestGoogleMeetConferenceRecord({
              accessToken: token.accessToken,
              meeting: resolved.meeting,
            })),
            ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
          });
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.calendarEvents",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = asParamRecord(params);
          const token = await resolveGoogleMeetTokenFromParams(config, raw);
          const window = raw.today === true ? buildGoogleMeetCalendarDayWindow() : {};
          respond(
            true,
            await listGoogleMeetCalendarEvents({
              accessToken: token.accessToken,
              calendarId: normalizeOptionalString(raw.calendarId),
              eventQuery: normalizeOptionalString(raw.event),
              ...window,
            }),
          );
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.artifacts",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = asParamRecord(params);
          const resolved = await resolveArtifactQueryFromParams(config, raw);
          respond(
            true,
            await fetchGoogleMeetArtifacts({
              accessToken: resolved.token.accessToken,
              meeting: resolved.meeting,
              conferenceRecord: resolved.conferenceRecord,
              pageSize: resolved.pageSize,
              includeTranscriptEntries: resolved.includeTranscriptEntries,
              includeDocumentBodies: resolved.includeDocumentBodies,
              allConferenceRecords: resolved.allConferenceRecords,
            }),
          );
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.attendance",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = asParamRecord(params);
          const resolved = await resolveArtifactQueryFromParams(config, raw);
          respond(
            true,
            await fetchGoogleMeetAttendance({
              accessToken: resolved.token.accessToken,
              meeting: resolved.meeting,
              conferenceRecord: resolved.conferenceRecord,
              pageSize: resolved.pageSize,
              allConferenceRecords: resolved.allConferenceRecords,
              mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
              lateAfterMinutes: resolved.lateAfterMinutes,
              earlyBeforeMinutes: resolved.earlyBeforeMinutes,
            }),
          );
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.export",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          respond(true, await exportGoogleMeetBundleFromParams(config, asParamRecord(params)));
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.leave",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const sessionId = normalizeOptionalString(params?.sessionId);
          if (!sessionId) {
            sendGoogleMeetGatewayError(
              respond,
              new Error("sessionId required"),
              ErrorCodes.INVALID_REQUEST,
            );
            return;
          }
          const rt = await ensureRuntime();
          respond(true, await rt.leave(sessionId));
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.endActiveConference",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = asParamRecord(params);
          const token = await resolveGoogleMeetTokenFromParams(config, raw);
          respond(
            true,
            await endGoogleMeetActiveConference({
              accessToken: token.accessToken,
              meeting: resolveMeetingInput(config, raw.meeting),
            }),
          );
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.speak",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const sessionId = normalizeOptionalString(params?.sessionId);
          if (!sessionId) {
            sendGoogleMeetGatewayError(
              respond,
              new Error("sessionId required"),
              ErrorCodes.INVALID_REQUEST,
            );
            return;
          }
          const rt = await ensureRuntime();
          respond(true, await rt.speak(sessionId, normalizeOptionalString(params?.message)));
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.testSpeech",
      async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
        try {
          const trustedParams = keepTrustedToolAgentId(asParamRecord(params), client);
          const rt = await ensureRuntime();
          const result = await rt.testSpeech({
            url: resolveMeetingInput(config, trustedParams.url),
            transport: normalizeTransport(trustedParams.transport),
            mode: normalizeMode(trustedParams.mode),
            dialInNumber: normalizeOptionalString(trustedParams.dialInNumber),
            pin: normalizeOptionalString(trustedParams.pin),
            dtmfSequence: normalizeOptionalString(trustedParams.dtmfSequence),
            message: normalizeOptionalString(trustedParams.message),
            requesterSessionKey: normalizeOptionalString(trustedParams.requesterSessionKey),
            agentId: normalizeOptionalString(trustedParams.agentId),
          });
          respond(true, result);
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.testListen",
      async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
        try {
          const trustedParams = keepTrustedToolAgentId(asParamRecord(params), client);
          const rt = await ensureRuntime();
          const result = await rt.testListen({
            url: resolveMeetingInput(config, trustedParams.url),
            transport: normalizeTransport(trustedParams.transport),
            mode: normalizeMode(trustedParams.mode),
            agentId: normalizeOptionalString(trustedParams.agentId),
            timeoutMs: readPositiveIntegerParam(trustedParams, "timeoutMs"),
          });
          respond(true, result);
        } catch (err) {
          sendGoogleMeetGatewayError(respond, err);
        }
      },
    );

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
              case "join": {
                return json(
                  await callGoogleMeetGatewayFromTool({
                    config,
                    action: "join",
                    raw: rawWithRequester,
                    runtime: useTrustedRuntime ? api.runtime : undefined,
                  }),
                );
              }
              case "create": {
                return json(
                  await callGoogleMeetGatewayFromTool({
                    config,
                    action: "create",
                    raw: rawWithRequester,
                    runtime: useTrustedRuntime ? api.runtime : undefined,
                  }),
                );
              }
              case "test_speech": {
                return json(
                  await callGoogleMeetGatewayFromTool({
                    config,
                    action: "test_speech",
                    raw: rawWithRequester,
                    runtime: useTrustedRuntime ? api.runtime : undefined,
                  }),
                );
              }
              case "test_listen": {
                return json(
                  await callGoogleMeetGatewayFromTool({
                    config,
                    action: "test_listen",
                    raw: rawWithRequester,
                    runtime: useTrustedRuntime ? api.runtime : undefined,
                  }),
                );
              }
              case "status": {
                return json(await callGoogleMeetGatewayFromTool({ config, action: "status", raw }));
              }
              case "transcript": {
                return json(
                  await callGoogleMeetGatewayFromTool({ config, action: "transcript", raw }),
                );
              }
              case "recover_current_tab": {
                return json(
                  await callGoogleMeetGatewayFromTool({
                    config,
                    action: "recover_current_tab",
                    raw,
                  }),
                );
              }
              case "setup_status": {
                return json(
                  await callGoogleMeetGatewayFromTool({ config, action: "setup_status", raw }),
                );
              }
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
              case "latest": {
                const token = await resolveGoogleMeetTokenFromParams(config, raw);
                const resolved = await resolveMeetingFromParams({
                  config,
                  raw,
                  accessToken: token.accessToken,
                });
                return json({
                  ...(await fetchLatestGoogleMeetConferenceRecord({
                    accessToken: token.accessToken,
                    meeting: resolved.meeting,
                  })),
                  ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
                });
              }
              case "calendar_events": {
                const token = await resolveGoogleMeetTokenFromParams(config, raw);
                const window = raw.today === true ? buildGoogleMeetCalendarDayWindow() : {};
                return json(
                  await listGoogleMeetCalendarEvents({
                    accessToken: token.accessToken,
                    calendarId: normalizeOptionalString(raw.calendarId),
                    eventQuery: normalizeOptionalString(raw.event),
                    ...window,
                  }),
                );
              }
              case "artifacts": {
                const resolved = await resolveArtifactQueryFromParams(config, raw);
                return json(
                  await fetchGoogleMeetArtifacts({
                    accessToken: resolved.token.accessToken,
                    meeting: resolved.meeting,
                    conferenceRecord: resolved.conferenceRecord,
                    pageSize: resolved.pageSize,
                    includeTranscriptEntries: resolved.includeTranscriptEntries,
                    includeDocumentBodies: resolved.includeDocumentBodies,
                    allConferenceRecords: resolved.allConferenceRecords,
                  }),
                );
              }
              case "attendance": {
                const resolved = await resolveArtifactQueryFromParams(config, raw);
                return json(
                  await fetchGoogleMeetAttendance({
                    accessToken: resolved.token.accessToken,
                    meeting: resolved.meeting,
                    conferenceRecord: resolved.conferenceRecord,
                    pageSize: resolved.pageSize,
                    allConferenceRecords: resolved.allConferenceRecords,
                    mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
                    lateAfterMinutes: resolved.lateAfterMinutes,
                    earlyBeforeMinutes: resolved.earlyBeforeMinutes,
                  }),
                );
              }
              case "export": {
                return json(await exportGoogleMeetBundleFromParams(config, raw));
              }
              case "leave": {
                const sessionId = normalizeOptionalString(raw.sessionId);
                if (!sessionId) {
                  throw new Error("sessionId required");
                }
                return json(await callGoogleMeetGatewayFromTool({ config, action: "leave", raw }));
              }
              case "end_active_conference": {
                return json(
                  await callGoogleMeetGatewayFromTool({
                    config,
                    action: "end_active_conference",
                    raw,
                  }),
                );
              }
              case "speak": {
                const sessionId = normalizeOptionalString(raw.sessionId);
                if (!sessionId) {
                  throw new Error("sessionId required");
                }
                return json(await callGoogleMeetGatewayFromTool({ config, action: "speak", raw }));
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
        descriptors: [
          {
            name: "googlemeet",
            description: "Join and manage Google Meet calls",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
