import { CallManager } from "../src/voice-call/manager.js";
import { VoiceCallConfigSchema } from "../src/voice-call/config.js";
import { VoiceCallWebhookServer } from "../src/voice-call/webhook.js";
import { MockProvider } from "../src/voice-call/providers/mock.js";

async function postWebhook(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Webhook POST failed: ${res.status} ${res.statusText} ${text}`);
  }
}

async function main() {
  const config = VoiceCallConfigSchema.parse({
    enabled: true,
    provider: "mock",
    fromNumber: "+15551234567",
    toNumber: "+15550001111",
    serve: { bind: "0.0.0.0", port: 3334, path: "/voice/webhook" },
    tailscale: { mode: "off", path: "/voice" },
  });

  const provider = new MockProvider();
  const manager = new CallManager(config, "/tmp/clawd/voice-calls-mock");
  const server = new VoiceCallWebhookServer(config, manager, provider);

  const webhookUrl = await server.start();
  manager.initialize(provider, webhookUrl);

  const { callId, success, error } = await manager.initiateCall(
    config.toNumber!,
    "mock-session"
  );

  if (!success) {
    throw new Error(error || "Call initiation failed");
  }

  const providerCallId = `mock-${callId}`;

  // Auto-drive a basic lifecycle so you can test speak/listen + transcript logging.
  await postWebhook(webhookUrl, {
    events: [
      { type: "call.initiated", callId, providerCallId },
      { type: "call.ringing", callId, providerCallId },
      { type: "call.answered", callId, providerCallId },
      { type: "call.active", callId, providerCallId },
    ],
  });

  // eslint-disable-next-line no-console
  console.log("[voice-call][mock] ready");
  // eslint-disable-next-line no-console
  console.log(`- webhook: ${webhookUrl}`);
  // eslint-disable-next-line no-console
  console.log(`- callId:  ${callId}`);
  // eslint-disable-next-line no-console
  console.log("\nSend a mock user utterance (final transcript):");
  // eslint-disable-next-line no-console
  console.log(
    `curl -sS -X POST '${webhookUrl}' -H 'content-type: application/json' \\\n  -d '{"event":{"type":"call.speech","callId":"${callId}","providerCallId":"${providerCallId}","transcript":"hello from user","isFinal":true}}'`
  );
  // eslint-disable-next-line no-console
  console.log("\nHang up:");
  // eslint-disable-next-line no-console
  console.log(
    `curl -sS -X POST '${webhookUrl}' -H 'content-type: application/json' \\\n  -d '{"event":{"type":"call.ended","callId":"${callId}","providerCallId":"${providerCallId}","reason":"completed"}}'`
  );

  // Keep process alive.
  // eslint-disable-next-line no-console
  console.log("\nLogs written to: /tmp/clawd/voice-calls-mock/calls.jsonl");
  // eslint-disable-next-line no-console
  console.log("Ctrl+C to stop.");

  await new Promise(() => {});
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
