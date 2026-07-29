import {
  GatewayClient,
  startGatewayClientWhenEventLoopReady,
} from "openclaw/plugin-sdk/gateway-runtime";
// Google Meet keeps its labels/config; core owns the voicecall.* delegation contract.
import {
  createMeetingVoiceCallGateway,
  endMeetingVoiceCallGatewayCall,
  getMeetingVoiceCallGatewayCall,
  isMeetingVoiceCallMissingError,
  joinMeetingViaVoiceCallGateway,
  speakMeetingViaVoiceCallGateway,
  type MeetingVoiceCallConfig,
  type MeetingVoiceCallGateway,
  type MeetingVoiceCallGatewayClient,
  type MeetingVoiceCallSurface,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type { GoogleMeetConfig } from "./config.js";

export type VoiceCallGateway = MeetingVoiceCallGateway;

const GOOGLE_MEET_VOICE_CALL_SURFACE: MeetingVoiceCallSurface = {
  clientDisplayName: "Google Meet plugin",
  configPath: "google-meet voiceCall.gatewayUrl",
  logScope: "[google-meet]",
  meetingLabel: "Meet",
  providerLabel: "Twilio",
};

async function createConnectedGatewayClient(params: {
  config: MeetingVoiceCallConfig;
  surface: MeetingVoiceCallSurface;
}): Promise<MeetingVoiceCallGatewayClient> {
  let client: InstanceType<typeof GatewayClient>;
  await new Promise<void>((resolve, reject) => {
    const abortStart = new AbortController();
    const timer = setTimeout(() => {
      abortStart.abort();
      reject(new Error("gateway connect timeout"));
    }, params.config.requestTimeoutMs);
    client = new GatewayClient({
      url: params.config.gatewayUrl,
      token: params.config.token,
      requestTimeoutMs: params.config.requestTimeoutMs,
      clientName: "cli",
      clientDisplayName: params.surface.clientDisplayName,
      scopes: ["operator.write"],
      onHelloOk: () => {
        clearTimeout(timer);
        resolve();
      },
      onConnectError: (error) => {
        clearTimeout(timer);
        abortStart.abort();
        reject(error);
      },
    });
    void startGatewayClientWhenEventLoopReady(client, {
      timeoutMs: params.config.requestTimeoutMs,
      signal: abortStart.signal,
    })
      .then((readiness) => {
        if (!readiness.ready && !readiness.aborted) {
          clearTimeout(timer);
          reject(new Error("gateway event loop readiness timeout"));
        }
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
  return client!;
}

export function createVoiceCallGateway(params: {
  config: GoogleMeetConfig;
  runtime: PluginRuntime;
}): VoiceCallGateway {
  return createMeetingVoiceCallGateway({
    config: params.config.voiceCall,
    runtime: params.runtime,
    surface: GOOGLE_MEET_VOICE_CALL_SURFACE,
    connectClient: createConnectedGatewayClient,
  });
}

export const isVoiceCallMissingError = isMeetingVoiceCallMissingError;

export async function joinMeetViaVoiceCallGateway(params: {
  config: GoogleMeetConfig;
  gateway: VoiceCallGateway;
  dialInNumber: string;
  dtmfSequence?: string;
  logger?: RuntimeLogger;
  message?: string;
  requesterSessionKey?: string;
  agentId?: string;
  sessionKey?: string;
}): Promise<{ callId: string; dtmfSent: boolean; introSent: boolean }> {
  return await joinMeetingViaVoiceCallGateway({
    ...params,
    config: params.config.voiceCall,
    surface: GOOGLE_MEET_VOICE_CALL_SURFACE,
  });
}

export async function endMeetVoiceCallGatewayCall(params: {
  gateway: VoiceCallGateway;
  callId: string;
}): Promise<void> {
  await endMeetingVoiceCallGatewayCall(params);
}

export async function getMeetVoiceCallGatewayCall(params: {
  gateway: VoiceCallGateway;
  callId: string;
}): Promise<{ found?: boolean; call?: unknown }> {
  return await getMeetingVoiceCallGatewayCall(params);
}

export async function speakMeetViaVoiceCallGateway(params: {
  gateway: VoiceCallGateway;
  callId: string;
  message: string;
}): Promise<void> {
  await speakMeetingViaVoiceCallGateway(params);
}
