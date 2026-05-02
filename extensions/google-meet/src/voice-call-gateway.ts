import {
  GatewayClient,
  startGatewayClientWhenEventLoopReady,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type { GoogleMeetConfig } from "./config.js";

type VoiceCallGatewayClient = InstanceType<typeof GatewayClient>;

type VoiceCallStartResult = {
  callId?: string;
  initiated?: boolean;
  error?: string;
};

type VoiceCallSpeakResult = {
  success?: boolean;
  error?: string;
};

type VoiceCallMeetJoinResult = {
  callId: string;
  dtmfSent: boolean;
  introSent: boolean;
};

async function createConnectedGatewayClient(
  config: GoogleMeetConfig,
): Promise<VoiceCallGatewayClient> {
  let client: VoiceCallGatewayClient;
  await new Promise<void>((resolve, reject) => {
    const abortStart = new AbortController();
    const timer = setTimeout(() => {
      abortStart.abort();
      reject(new Error("gateway connect timeout"));
    }, config.voiceCall.requestTimeoutMs);
    client = new GatewayClient({
      url: config.voiceCall.gatewayUrl,
      token: config.voiceCall.token,
      requestTimeoutMs: config.voiceCall.requestTimeoutMs,
      clientName: "cli",
      clientDisplayName: "Google Meet plugin",
      scopes: ["operator.write"],
      onHelloOk: () => {
        clearTimeout(timer);
        resolve();
      },
      onConnectError: (err) => {
        clearTimeout(timer);
        abortStart.abort();
        reject(err);
      },
    });
    void startGatewayClientWhenEventLoopReady(client, {
      timeoutMs: config.voiceCall.requestTimeoutMs,
      signal: abortStart.signal,
    })
      .then((readiness) => {
        if (!readiness.ready && !readiness.aborted) {
          clearTimeout(timer);
          reject(new Error("gateway event loop readiness timeout"));
        }
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
  return client!;
}

export async function joinMeetViaVoiceCallGateway(params: {
  config: GoogleMeetConfig;
  dialInNumber: string;
  dtmfSequence?: string;
  logger?: RuntimeLogger;
  message?: string;
}): Promise<VoiceCallMeetJoinResult> {
  let client: VoiceCallGatewayClient | undefined;

  try {
    client = await createConnectedGatewayClient(params.config);
    params.logger?.info(
      `[google-meet] Delegating Twilio join to Voice Call (dtmf=${params.dtmfSequence ? "yes" : "no"}, intro=${params.message ? "yes" : "no"})`,
    );
    const start = (await client.request(
      "voicecall.start",
      {
        to: params.dialInNumber,
        mode: "conversation",
        ...(params.message ? { message: params.message } : {}),
        ...(params.dtmfSequence ? { dtmfSequence: params.dtmfSequence } : {}),
      },
      { timeoutMs: params.config.voiceCall.requestTimeoutMs },
    )) as VoiceCallStartResult;
    if (!start.callId) {
      throw new Error(start.error || "voicecall.start did not return callId");
    }
    params.logger?.info(
      `[google-meet] Voice Call Twilio join started: callId=${start.callId} dtmf=${params.dtmfSequence ? "yes" : "no"} intro=${params.message ? "yes" : "no"}`,
    );
    return {
      callId: start.callId,
      dtmfSent: Boolean(params.dtmfSequence),
      introSent: Boolean(params.message),
    };
  } finally {
    await client?.stopAndWait({ timeoutMs: 1_000 });
  }
}

export async function endMeetVoiceCallGatewayCall(params: {
  config: GoogleMeetConfig;
  callId: string;
}): Promise<void> {
  let client: VoiceCallGatewayClient | undefined;

  try {
    client = await createConnectedGatewayClient(params.config);
    await client.request(
      "voicecall.end",
      {
        callId: params.callId,
      },
      { timeoutMs: params.config.voiceCall.requestTimeoutMs },
    );
  } finally {
    await client?.stopAndWait({ timeoutMs: 1_000 });
  }
}

export async function speakMeetViaVoiceCallGateway(params: {
  config: GoogleMeetConfig;
  callId: string;
  message: string;
}): Promise<void> {
  let client: VoiceCallGatewayClient | undefined;

  try {
    client = await createConnectedGatewayClient(params.config);
    const spoken = (await client.request(
      "voicecall.speak",
      {
        callId: params.callId,
        message: params.message,
      },
      { timeoutMs: params.config.voiceCall.requestTimeoutMs },
    )) as VoiceCallSpeakResult;
    if (spoken.success === false) {
      throw new Error(spoken.error || "voicecall.speak failed");
    }
  } finally {
    await client?.stopAndWait({ timeoutMs: 1_000 });
  }
}
