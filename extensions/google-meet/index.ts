import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { Type } from "typebox";
import { registerGoogleMeetCli } from "./src/cli.js";
import {
  resolveGoogleMeetConfig,
  type GoogleMeetConfig,
  type GoogleMeetMode,
  type GoogleMeetTransport,
} from "./src/config.js";
import { buildGoogleMeetPreflightReport, fetchGoogleMeetSpace } from "./src/meet.js";
import { handleGoogleMeetNodeHostCommand } from "./src/node-host.js";
import { resolveGoogleMeetAccessToken } from "./src/oauth.js";
import { GoogleMeetRuntime } from "./src/runtime.js";

const googleMeetConfigSchema = {
  parse(value: unknown) {
    return resolveGoogleMeetConfig(value);
  },
  uiHints: {
    "defaults.meeting": {
      label: "Default Meeting",
      help: "Meet URL, meeting code, or spaces/{id} used when CLI commands omit a meeting.",
    },
    "preview.enrollmentAcknowledged": {
      label: "Preview Acknowledged",
      help: "Confirms you understand the Google Meet Media API is still Developer Preview.",
      advanced: true,
    },
    defaultTransport: {
      label: "Default Transport",
      help: "Chrome uses a signed-in browser profile. Chrome-node runs Chrome on a paired node. Twilio uses Meet dial-in numbers.",
    },
    defaultMode: {
      label: "Default Mode",
      help: "Realtime voice is the default.",
    },
    "chrome.audioBackend": {
      label: "Chrome Audio Backend",
      help: "BlackHole 2ch is required for local duplex audio routing.",
    },
    "chrome.launch": { label: "Launch Chrome" },
    "chrome.browserProfile": { label: "Chrome Profile", advanced: true },
    "chrome.audioInputCommand": {
      label: "Audio Input Command",
      help: "Command that writes 8 kHz G.711 mu-law meeting audio to stdout.",
      advanced: true,
    },
    "chrome.audioOutputCommand": {
      label: "Audio Output Command",
      help: "Command that reads 8 kHz G.711 mu-law assistant audio from stdin.",
      advanced: true,
    },
    "chrome.audioBridgeCommand": { label: "Audio Bridge Command", advanced: true },
    "chrome.audioBridgeHealthCommand": {
      label: "Audio Bridge Health Command",
      advanced: true,
    },
    "chromeNode.node": {
      label: "Chrome Node",
      help: "Node id/name/IP that owns Chrome, BlackHole, and SoX for chrome-node transport.",
      advanced: true,
    },
    "twilio.defaultDialInNumber": {
      label: "Default Dial-In Number",
      placeholder: "+15551234567",
    },
    "twilio.defaultPin": { label: "Default PIN", advanced: true },
    "twilio.defaultDtmfSequence": { label: "Default DTMF Sequence", advanced: true },
    "voiceCall.enabled": { label: "Delegate To Voice Call" },
    "voiceCall.gatewayUrl": { label: "Voice Call Gateway URL", advanced: true },
    "voiceCall.token": {
      label: "Voice Call Gateway Token",
      sensitive: true,
      advanced: true,
    },
    "voiceCall.requestTimeoutMs": {
      label: "Voice Call Request Timeout (ms)",
      advanced: true,
    },
    "voiceCall.dtmfDelayMs": { label: "DTMF Delay (ms)", advanced: true },
    "voiceCall.introMessage": { label: "Voice Call Intro Message", advanced: true },
    "realtime.provider": {
      label: "Realtime Provider",
      help: "Defaults to OpenAI; uses OPENAI_API_KEY when no provider config is set.",
    },
    "realtime.model": { label: "Realtime Model", advanced: true },
    "realtime.instructions": { label: "Realtime Instructions", advanced: true },
    "realtime.introMessage": {
      label: "Realtime Intro Message",
      help: "Spoken once when the realtime bridge is ready. Set to an empty string to join silently.",
    },
    "realtime.toolPolicy": {
      label: "Realtime Tool Policy",
      help: "Safe read-only tools are available by default; owner requests can unlock broader tools.",
      advanced: true,
    },
    "oauth.clientId": { label: "OAuth Client ID" },
    "oauth.clientSecret": { label: "OAuth Client Secret", sensitive: true },
    "oauth.refreshToken": { label: "OAuth Refresh Token", sensitive: true },
    "oauth.accessToken": {
      label: "Cached Access Token",
      sensitive: true,
      advanced: true,
    },
    "oauth.expiresAt": {
      label: "Cached Access Token Expiry",
      help: "Unix epoch milliseconds used only for the cached access-token fast path.",
      advanced: true,
    },
  },
};

const GoogleMeetToolSchema = Type.Object({
  action: Type.String({
    enum: ["join", "status", "setup_status", "resolve_space", "preflight", "leave", "speak"],
    description: "Google Meet action to run",
  }),
  url: Type.Optional(Type.String({ description: "Explicit https://meet.google.com/... URL" })),
  transport: Type.Optional(
    Type.String({ enum: ["chrome", "chrome-node", "twilio"], description: "Join transport" }),
  ),
  mode: Type.Optional(Type.String({ enum: ["realtime", "transcribe"], description: "Join mode" })),
  dialInNumber: Type.Optional(Type.String({ description: "Meet dial-in number for Twilio" })),
  pin: Type.Optional(Type.String({ description: "Meet phone PIN for Twilio" })),
  dtmfSequence: Type.Optional(Type.String({ description: "Explicit DTMF sequence for Twilio" })),
  sessionId: Type.Optional(Type.String({ description: "Meet session ID" })),
  message: Type.Optional(Type.String({ description: "Realtime instructions to speak now" })),
  meeting: Type.Optional(Type.String({ description: "Meet URL, meeting code, or spaces/{id}" })),
  accessToken: Type.Optional(Type.String({ description: "Access token override" })),
  refreshToken: Type.Optional(Type.String({ description: "Refresh token override" })),
  clientId: Type.Optional(Type.String({ description: "OAuth client id override" })),
  clientSecret: Type.Optional(Type.String({ description: "OAuth client secret override" })),
  expiresAt: Type.Optional(Type.Number({ description: "Cached access token expiry ms" })),
});

function asParamRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function json(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function normalizeTransport(value: unknown): GoogleMeetTransport | undefined {
  return value === "chrome" || value === "chrome-node" || value === "twilio" ? value : undefined;
}

function normalizeMode(value: unknown): GoogleMeetMode | undefined {
  return value === "realtime" || value === "transcribe" ? value : undefined;
}

function resolveMeetingInput(config: GoogleMeetConfig, value: unknown): string {
  const meeting = normalizeOptionalString(value) ?? config.defaults.meeting;
  if (!meeting) {
    throw new Error("Meeting input is required");
  }
  return meeting;
}

async function resolveSpaceFromParams(config: GoogleMeetConfig, raw: Record<string, unknown>) {
  const meeting = resolveMeetingInput(config, raw.meeting);
  const token = await resolveGoogleMeetAccessToken({
    clientId: normalizeOptionalString(raw.clientId) ?? config.oauth.clientId,
    clientSecret: normalizeOptionalString(raw.clientSecret) ?? config.oauth.clientSecret,
    refreshToken: normalizeOptionalString(raw.refreshToken) ?? config.oauth.refreshToken,
    accessToken: normalizeOptionalString(raw.accessToken) ?? config.oauth.accessToken,
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : config.oauth.expiresAt,
  });
  const space = await fetchGoogleMeetSpace({
    accessToken: token.accessToken,
    meeting,
  });
  return { meeting, token, space };
}

export default definePluginEntry({
  id: "google-meet",
  name: "Google Meet",
  description: "Join Google Meet calls through Chrome or Twilio transports",
  configSchema: googleMeetConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = googleMeetConfigSchema.parse(api.pluginConfig);
    let runtime: GoogleMeetRuntime | null = null;

    const ensureRuntime = async () => {
      if (!config.enabled) {
        throw new Error("Google Meet plugin disabled in plugin config");
      }
      if (!runtime) {
        runtime = new GoogleMeetRuntime({
          config,
          fullConfig: api.config,
          runtime: api.runtime,
          logger: api.logger,
        });
      }
      return runtime;
    };

    const sendError = (respond: (ok: boolean, payload?: unknown) => void, err: unknown) => {
      respond(false, { error: formatErrorMessage(err) });
    };

    api.registerGatewayMethod(
      "googlemeet.join",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          const result = await rt.join({
            url: resolveMeetingInput(config, params?.url),
            transport: normalizeTransport(params?.transport),
            mode: normalizeMode(params?.mode),
            dialInNumber: normalizeOptionalString(params?.dialInNumber),
            pin: normalizeOptionalString(params?.pin),
            dtmfSequence: normalizeOptionalString(params?.dtmfSequence),
          });
          respond(true, result);
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          respond(true, rt.status(normalizeOptionalString(params?.sessionId)));
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.setup",
      async ({ respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          respond(true, rt.setupStatus());
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.leave",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const sessionId = normalizeOptionalString(params?.sessionId);
          if (!sessionId) {
            respond(false, { error: "sessionId required" });
            return;
          }
          const rt = await ensureRuntime();
          respond(true, await rt.leave(sessionId));
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.speak",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const sessionId = normalizeOptionalString(params?.sessionId);
          if (!sessionId) {
            respond(false, { error: "sessionId required" });
            return;
          }
          const rt = await ensureRuntime();
          respond(true, rt.speak(sessionId, normalizeOptionalString(params?.message)));
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerTool({
      name: "google_meet",
      label: "Google Meet",
      description: "Join and track Google Meet sessions through Chrome or Twilio.",
      parameters: GoogleMeetToolSchema,
      async execute(_toolCallId, params) {
        const raw = asParamRecord(params);
        try {
          switch (raw.action) {
            case "join": {
              const rt = await ensureRuntime();
              return json(
                await rt.join({
                  url: resolveMeetingInput(config, raw.url),
                  transport: normalizeTransport(raw.transport),
                  mode: normalizeMode(raw.mode),
                  dialInNumber: normalizeOptionalString(raw.dialInNumber),
                  pin: normalizeOptionalString(raw.pin),
                  dtmfSequence: normalizeOptionalString(raw.dtmfSequence),
                }),
              );
            }
            case "status": {
              const rt = await ensureRuntime();
              return json(rt.status(normalizeOptionalString(raw.sessionId)));
            }
            case "setup_status": {
              const rt = await ensureRuntime();
              return json(rt.setupStatus());
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
            case "leave": {
              const rt = await ensureRuntime();
              const sessionId = normalizeOptionalString(raw.sessionId);
              if (!sessionId) {
                throw new Error("sessionId required");
              }
              return json(await rt.leave(sessionId));
            }
            case "speak": {
              const rt = await ensureRuntime();
              const sessionId = normalizeOptionalString(raw.sessionId);
              if (!sessionId) {
                throw new Error("sessionId required");
              }
              return json(rt.speak(sessionId, normalizeOptionalString(raw.message)));
            }
            default:
              throw new Error("unknown google_meet action");
          }
        } catch (err) {
          return json({ error: formatErrorMessage(err) });
        }
      },
    });

    api.registerNodeHostCommand({
      command: "googlemeet.chrome",
      cap: "google-meet",
      handle: handleGoogleMeetNodeHostCommand,
    });

    api.registerCli(
      ({ program }) =>
        registerGoogleMeetCli({
          program,
          config,
          ensureRuntime,
        }),
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
