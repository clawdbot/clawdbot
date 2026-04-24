import { setTimeout as sleep } from "node:timers/promises";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import type { GoogleMeetConfig } from "./config.js";

type VoiceCallGatewayClient = InstanceType<typeof GatewayClient>;

type VoiceCallStartResult = {
  callId?: string;
  initiated?: boolean;
  error?: string;
};

export type VoiceCallMeetJoinResult = {
  callId: string;
  dtmfSent: boolean;
};

async function createConnectedGatewayClient(
  config: GoogleMeetConfig,
): Promise<VoiceCallGatewayClient> {
  let client: VoiceCallGatewayClient;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("gateway connect timeout")),
      config.voiceCall.requestTimeoutMs,
    );
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
        reject(err);
      },
    });
    client.start();
  });
  return client!;
}

export async function joinMeetViaVoiceCallGateway(params: {
  config: GoogleMeetConfig;
  dialInNumber: string;
  dtmfSequence?: string;
}): Promise<VoiceCallMeetJoinResult> {
  let client: VoiceCallGatewayClient | undefined;

  try {
    client = await createConnectedGatewayClient(params.config);
    const start = (await client.request(
      "voicecall.start",
      {
        to: params.dialInNumber,
        message: params.config.voiceCall.introMessage,
        mode: "conversation",
      },
      { timeoutMs: params.config.voiceCall.requestTimeoutMs },
    )) as VoiceCallStartResult;
    if (!start.callId) {
      throw new Error(start.error || "voicecall.start did not return callId");
    }
    if (params.dtmfSequence) {
      await sleep(params.config.voiceCall.dtmfDelayMs);
      await client.request(
        "voicecall.dtmf",
        {
          callId: start.callId,
          digits: params.dtmfSequence,
        },
        { timeoutMs: params.config.voiceCall.requestTimeoutMs },
      );
    }
    return { callId: start.callId, dtmfSent: Boolean(params.dtmfSequence) };
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
