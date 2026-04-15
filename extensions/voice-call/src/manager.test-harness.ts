import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type {
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "./types.js";

export class FakeProvider implements VoiceCallProvider {
  readonly name: "plivo" | "twilio";
  twilioStreamConnectEnabled = true;
  readonly playTtsCalls: PlayTtsInput[] = [];
  readonly hangupCalls: HangupCallInput[] = [];
  readonly startListeningCalls: StartListeningInput[] = [];
  readonly stopListeningCalls: StopListeningInput[] = [];
  getCallStatusResult: GetCallStatusResult = { status: "in-progress", isTerminal: false };

  constructor(name: "plivo" | "twilio" = "plivo") {
    this.name = name;
  }

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true };
  }

  parseWebhookEvent(_ctx: WebhookContext): ProviderWebhookParseResult {
    return { events: [], statusCode: 200 };
  }

  async initiateCall(_input: InitiateCallInput): Promise<InitiateCallResult> {
    return { providerCallId: "request-uuid", status: "initiated" };
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    this.hangupCalls.push(input);
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    this.playTtsCalls.push(input);
  }

  async startListening(input: StartListeningInput): Promise<void> {
    this.startListeningCalls.push(input);
  }

  async stopListening(input: StopListeningInput): Promise<void> {
    this.stopListeningCalls.push(input);
  }

  async getCallStatus(_input: GetCallStatusInput): Promise<GetCallStatusResult> {
    return this.getCallStatusResult;
  }

  isConversationStreamConnectEnabled(): boolean {
    return this.name === "twilio" && this.twilioStreamConnectEnabled;
  }
}

export function createTestStorePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-voice-call-test-"));
}

export async function createManagerHarness(
  configOverrides: Record<string, unknown> = {},
  provider = new FakeProvider(),
): Promise<{
  manager: CallManager;
  provider: FakeProvider;
}> {
  const config = VoiceCallConfigSchema.parse({
    enabled: true,
    provider: "plivo",
    fromNumber: "+15550000000",
    ...configOverrides,
  });
  const manager = new CallManager(config, createTestStorePath());
  await manager.initialize(provider, "https://example.com/voice/webhook");
  return { manager, provider };
}

export function markCallAnswered(manager: CallManager, callId: string, eventId: string): void {
  manager.processEvent({
    id: eventId,
    type: "call.answered",
    callId,
    providerCallId: "request-uuid",
    timestamp: Date.now(),
  });
}

export function writeCallsToStore(storePath: string, calls: Record<string, unknown>[]): void {
  fs.mkdirSync(storePath, { recursive: true });
  const logPath = path.join(storePath, "calls.jsonl");
  const lines = calls.map((c) => JSON.stringify(c)).join("\n") + "\n";
  fs.writeFileSync(logPath, lines);
}

export function makePersistedCall(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    callId: `call-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    providerCallId: `prov-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    provider: "plivo",
    direction: "outbound",
    state: "answered",
    from: "+15550000000",
    to: "+15550000001",
    startedAt: Date.now() - 30_000,
    answeredAt: Date.now() - 25_000,
    transcript: [],
    processedEventIds: [],
    ...overrides,
  };
}
