import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { GoogleMeetConfig, GoogleMeetMode, GoogleMeetTransport } from "./config.js";
import {
  createGoogleMeetSpace,
  type GoogleMeetAccessType,
  type GoogleMeetEntryPointAccess,
  type GoogleMeetSpaceConfig,
} from "./meet.js";
import { resolveGoogleMeetAccessToken } from "./oauth.js";
import type { GoogleMeetRuntime } from "./runtime.js";
import { createMeetWithBrowserProxyOnNode } from "./transports/chrome-create.js";

function normalizeTransport(value: unknown): GoogleMeetTransport | undefined {
  return value === "chrome" || value === "chrome-node" || value === "twilio" ? value : undefined;
}

function normalizeMode(value: unknown): GoogleMeetMode | undefined {
  return value === "realtime" || value === "transcribe" ? value : undefined;
}

function normalizeGoogleMeetAccessType(value: unknown): GoogleMeetAccessType | undefined {
  const normalized = normalizeOptionalString(value)?.toUpperCase().replaceAll("-", "_");
  return normalized === "OPEN" || normalized === "TRUSTED" || normalized === "RESTRICTED"
    ? normalized
    : undefined;
}

function normalizeGoogleMeetEntryPointAccess(
  value: unknown,
): GoogleMeetEntryPointAccess | undefined {
  const normalized = normalizeOptionalString(value)?.toUpperCase().replaceAll("-", "_");
  return normalized === "ALL" || normalized === "CREATOR_APP_ONLY" ? normalized : undefined;
}

export function resolveCreateSpaceConfig(
  raw: Record<string, unknown>,
): GoogleMeetSpaceConfig | undefined {
  const rawAccessType = normalizeOptionalString(raw.accessType);
  const rawEntryPointAccess = normalizeOptionalString(raw.entryPointAccess);
  const accessType = normalizeGoogleMeetAccessType(raw.accessType);
  const entryPointAccess = normalizeGoogleMeetEntryPointAccess(raw.entryPointAccess);
  if (rawAccessType !== undefined && !accessType) {
    throw new Error("Invalid Google Meet accessType. Expected OPEN, TRUSTED, or RESTRICTED.");
  }
  if (rawEntryPointAccess !== undefined && !entryPointAccess) {
    throw new Error("Invalid Google Meet entryPointAccess. Expected ALL or CREATOR_APP_ONLY.");
  }
  const config = {
    ...(accessType ? { accessType } : {}),
    ...(entryPointAccess ? { entryPointAccess } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

export function hasCreateSpaceConfigInput(raw: Record<string, unknown>): boolean {
  return (
    normalizeOptionalString(raw.accessType) !== undefined ||
    normalizeOptionalString(raw.entryPointAccess) !== undefined
  );
}

async function createSpaceFromParams(config: GoogleMeetConfig, raw: Record<string, unknown>) {
  const token = await resolveGoogleMeetAccessToken({
    clientId: normalizeOptionalString(raw.clientId) ?? config.oauth.clientId,
    clientSecret: normalizeOptionalString(raw.clientSecret) ?? config.oauth.clientSecret,
    refreshToken: normalizeOptionalString(raw.refreshToken) ?? config.oauth.refreshToken,
    accessToken: normalizeOptionalString(raw.accessToken) ?? config.oauth.accessToken,
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : config.oauth.expiresAt,
  });
  const result = await createGoogleMeetSpace({
    accessToken: token.accessToken,
    config: resolveCreateSpaceConfig(raw),
  });
  return { source: "api" as const, token, ...result };
}

function hasGoogleMeetOAuth(config: GoogleMeetConfig, raw: Record<string, unknown>): boolean {
  return Boolean(
    normalizeOptionalString(raw.accessToken) ??
    normalizeOptionalString(raw.refreshToken) ??
    config.oauth.accessToken ??
    config.oauth.refreshToken,
  );
}

export async function createMeetFromParams(params: {
  config: GoogleMeetConfig;
  runtime: OpenClawPluginApi["runtime"];
  raw: Record<string, unknown>;
}) {
  if (hasGoogleMeetOAuth(params.config, params.raw)) {
    const { token: _token, ...result } = await createSpaceFromParams(params.config, params.raw);
    return {
      ...result,
      joined: false,
      nextAction:
        "URL-only creation was requested. Call google_meet with action=join and url=meetingUri to enter the meeting.",
    };
  }
  if (hasCreateSpaceConfigInput(params.raw)) {
    throw new Error(
      "Google Meet access policy options require OAuth/API room creation. Configure Google Meet OAuth or remove accessType/entryPointAccess.",
    );
  }
  const browser = await createMeetWithBrowserProxyOnNode({
    runtime: params.runtime,
    config: params.config,
  });
  return {
    source: browser.source,
    meetingUri: browser.meetingUri,
    joined: false,
    nextAction:
      "URL-only creation was requested. Call google_meet with action=join and url=meetingUri to enter the meeting.",
    space: {
      name: `browser/${browser.meetingUri.split("/").pop()}`,
      meetingUri: browser.meetingUri,
    },
    browser: {
      nodeId: browser.nodeId,
      targetId: browser.targetId,
      browserUrl: browser.browserUrl,
      browserTitle: browser.browserTitle,
      notes: browser.notes,
    },
  };
}

export async function createAndJoinMeetFromParams(params: {
  config: GoogleMeetConfig;
  runtime: OpenClawPluginApi["runtime"];
  raw: Record<string, unknown>;
  ensureRuntime: () => Promise<GoogleMeetRuntime>;
}) {
  const created = await createMeetFromParams(params);
  const rt = await params.ensureRuntime();
  const join = await rt.join({
    url: created.meetingUri,
    transport: normalizeTransport(params.raw.transport),
    mode: normalizeMode(params.raw.mode),
    dialInNumber: normalizeOptionalString(params.raw.dialInNumber),
    pin: normalizeOptionalString(params.raw.pin),
    dtmfSequence: normalizeOptionalString(params.raw.dtmfSequence),
    message: normalizeOptionalString(params.raw.message),
  });
  return {
    ...created,
    joined: true,
    nextAction: "Share meetingUri with participants; the OpenClaw agent has started the join flow.",
    join,
  };
}
