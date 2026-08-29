// Voice Call plugin module implements manager harness behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import type { CallManagerContext } from "./manager/context.js";
import { persistCallRecord } from "./manager/store.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { setVoiceCallStateRuntime, type VoiceCallStateRuntime } from "./runtime-state.js";
import { CallRecordSchema } from "./types.js";
import type {
  CallRecord,
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "./types.js";

export class FakeProvider implements VoiceCallProvider {
  readonly name: "plivo" | "twilio" | "telnyx";
  twilioStreamConnectEnabled = true;
  readonly playTtsCalls: PlayTtsInput[] = [];
  readonly hangupCalls: HangupCallInput[] = [];
  readonly startListeningCalls: StartListeningInput[] = [];
  readonly stopListeningCalls: StopListeningInput[] = [];
  getCallStatusResult: GetCallStatusResult = { status: "in-progress", isTerminal: false };

  constructor(name: "plivo" | "twilio" | "telnyx" = "plivo") {
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

function createVoiceCallStateRuntimeForTests(): VoiceCallStateRuntime["state"] {
  return {
    resolveStateDir: () => "",
    openKeyedStore: (() => {
      throw new Error("openKeyedStore is not used by voice-call manager tests");
    }) as VoiceCallStateRuntime["state"]["openKeyedStore"],
    openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("voice-call", options),
    openChannelIngressQueue: (() => {
      throw new Error("openChannelIngressQueue is not used by voice-call manager tests");
    }) as VoiceCallStateRuntime["state"]["openChannelIngressQueue"],
    openChannelIngressDrain: (() => {
      throw new Error("openChannelIngressDrain is not used by voice-call manager tests");
    }) as VoiceCallStateRuntime["state"]["openChannelIngressDrain"],
  };
}

function installVoiceCallStateRuntimeForTests(): void {
  setVoiceCallStateRuntime({ state: createVoiceCallStateRuntimeForTests() });
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
  installVoiceCallStateRuntimeForTests();
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
  for (const call of calls) {
    persistCallRecord(storePath, CallRecordSchema.parse(call));
  }
}

export function writeLegacyCallsJsonl(storePath: string, calls: Record<string, unknown>[]): void {
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

export const EVENT_MANAGER_REPLAY_KEY_LIMIT = 10_000;

export function createEventManagerHarness() {
  const contexts: CallManagerContext[] = [];

  function installStateRuntime(shouldFail?: () => boolean): void {
    setVoiceCallStateRuntime({
      state: {
        resolveStateDir: () => "",
        openKeyedStore: (() => {
          throw new Error("openKeyedStore is not used by voice-call event tests");
        }) as never,
        openSyncKeyedStore: (options: OpenKeyedStoreOptions) => {
          if (shouldFail?.()) {
            throw new Error("synthetic SQLite persistence failure");
          }
          return createPluginStateSyncKeyedStoreForTests("voice-call", options);
        },
        openChannelIngressQueue: (() => {
          throw new Error("openChannelIngressQueue is not used by voice-call event tests");
        }) as never,
        openChannelIngressDrain: (() => {
          throw new Error("openChannelIngressDrain is not used by voice-call event tests");
        }) as never,
      },
    });
  }

  function setup(): void {
    resetPluginStateStoreForTests();
    installStateRuntime();
  }

  function cleanup(): void {
    for (const ctx of contexts.splice(0)) {
      for (const timer of ctx.maxDurationTimers.values()) {
        clearTimeout(timer);
      }
      ctx.maxDurationTimers.clear();
      for (const waiter of ctx.transcriptWaiters.values()) {
        clearTimeout(waiter.timeout);
      }
      ctx.transcriptWaiters.clear();
      fs.rmSync(ctx.storePath, { recursive: true, force: true });
    }
    resetPluginStateStoreForTests();
  }

  function createContext(overrides: Partial<CallManagerContext> = {}): CallManagerContext {
    const storePath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-voice-call-events-test-"));
    const ctx: CallManagerContext = {
      activeCalls: new Map(),
      providerCallIdMap: new Map(),
      processedEventIds: new Set(),
      rejectedProviderCallIds: new Map(),
      provider: null,
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        fromNumber: "+15550000000",
      }),
      storePath,
      webhookUrl: null,
      activeTurnCalls: new Set(),
      endCallOperations: new Map(),
      transcriptWaiters: new Map(),
      maxDurationTimers: new Map(),
      pendingHangupTimers: new Map(),
      initialMessageInFlight: new Set(),
      ...overrides,
    };
    contexts.push(ctx);
    return ctx;
  }

  function createProvider(overrides: Partial<VoiceCallProvider> = {}): VoiceCallProvider {
    return {
      name: "plivo",
      verifyWebhook: () => ({ ok: true }),
      parseWebhookEvent: () => ({ events: [] }),
      initiateCall: async () => ({ providerCallId: "provider-call-id", status: "initiated" }),
      hangupCall: async () => {},
      playTts: async () => {},
      startListening: async () => {},
      stopListening: async () => {},
      getCallStatus: async () => ({ status: "in-progress", isTerminal: false }),
      ...overrides,
    };
  }

  function createInboundDisabledConfig() {
    return VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
      inboundPolicy: "disabled",
    });
  }

  function createInboundInitiatedEvent(params: {
    id: string;
    providerCallId: string;
    from: string;
  }): NormalizedEvent {
    return {
      id: params.id,
      type: "call.initiated",
      callId: params.providerCallId,
      providerCallId: params.providerCallId,
      timestamp: Date.now(),
      direction: "inbound",
      from: params.from,
      to: "+15550000000",
    };
  }

  function createRejectingInboundContext(): {
    ctx: CallManagerContext;
    hangupCalls: HangupCallInput[];
  } {
    const hangupCalls: HangupCallInput[] = [];
    const provider = createProvider({
      hangupCall: async (input: HangupCallInput): Promise<void> => {
        hangupCalls.push(input);
      },
    });
    const ctx = createContext({
      config: createInboundDisabledConfig(),
      provider,
    });
    return { ctx, hangupCalls };
  }

  function requireFirstActiveCall(ctx: CallManagerContext): CallRecord {
    const call = [...ctx.activeCalls.values()][0];
    if (!call) {
      throw new Error("expected one active call");
    }
    return call;
  }

  return {
    cleanup,
    createContext,
    createInboundDisabledConfig,
    createInboundInitiatedEvent,
    createProvider,
    createRejectingInboundContext,
    installStateRuntime,
    requireFirstActiveCall,
    setup,
  };
}
