/**
 * Tests for CallManager - call state machine, persistence, and coordination.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VoiceCallConfig } from "./config.js";
import { CallManager } from "./manager.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type {
  InitiateCallResult,
  NormalizedEvent,
  ProviderWebhookParseResult,
  WebhookVerificationResult,
} from "./types.js";

// Create a mock provider for testing
function createMockProvider(
  overrides: Partial<VoiceCallProvider> = {},
): VoiceCallProvider {
  return {
    name: "mock",
    initiateCall: vi.fn().mockResolvedValue({
      providerCallId: "provider-call-123",
      status: "initiated",
    } as InitiateCallResult),
    hangupCall: vi.fn().mockResolvedValue(undefined),
    playTts: vi.fn().mockResolvedValue(undefined),
    startListening: vi.fn().mockResolvedValue(undefined),
    stopListening: vi.fn().mockResolvedValue(undefined),
    verifyWebhook: vi
      .fn()
      .mockReturnValue({ ok: true } as WebhookVerificationResult),
    parseWebhookEvent: vi.fn().mockReturnValue({
      events: [],
    } as ProviderWebhookParseResult),
    ...overrides,
  };
}

// Create a minimal config for testing
function createTestConfig(
  overrides: Partial<VoiceCallConfig> = {},
): VoiceCallConfig {
  return {
    enabled: true,
    provider: "mock",
    fromNumber: "+15551234567",
    maxConcurrentCalls: 5,
    maxDurationSeconds: 300,
    transcriptTimeoutMs: 30000,
    tts: {
      voice: "alloy",
    },
    serve: {
      port: 3000,
      bind: "127.0.0.1",
      path: "/voice",
    },
    tailscale: {
      mode: "off",
      path: "/voice",
    },
    outbound: {
      defaultMode: "notify",
      notifyHangupDelaySec: 3,
    },
    ...overrides,
  };
}

describe("CallManager", () => {
  let tempDir: string;
  let manager: CallManager;
  let mockProvider: VoiceCallProvider;
  let config: VoiceCallConfig;

  beforeEach(async () => {
    // Create temp directory for call persistence
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "voice-call-test-"));
    config = createTestConfig({ store: tempDir });
    mockProvider = createMockProvider();
    manager = new CallManager(config, tempDir);
  });

  afterEach(async () => {
    // Cleanup temp directory
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  describe("initialization", () => {
    it("initializes with provider and webhook URL", () => {
      manager.initialize(mockProvider, "https://example.com/voice");
      expect(manager.getProvider()).toBe(mockProvider);
    });

    it("creates store directory on initialization", async () => {
      const nestedPath = path.join(tempDir, "nested", "calls");
      const nestedManager = new CallManager(config, nestedPath);
      nestedManager.initialize(mockProvider, "https://example.com/voice");

      const stats = await fsp.stat(nestedPath);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  describe("initiateCall", () => {
    beforeEach(() => {
      manager.initialize(mockProvider, "https://example.com/voice");
    });

    it("initiates a call successfully", async () => {
      const result = await manager.initiateCall("+15559876543");

      expect(result.success).toBe(true);
      expect(result.callId).toBeDefined();
      expect(result.error).toBeUndefined();
      expect(mockProvider.initiateCall).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "+15551234567",
          to: "+15559876543",
          webhookUrl: "https://example.com/voice",
        }),
      );
    });

    it("stores session key with call", async () => {
      const result = await manager.initiateCall("+15559876543", "session-123");
      const call = manager.getCall(result.callId);

      expect(call?.sessionKey).toBe("session-123");
    });

    it("fails when provider not initialized", async () => {
      const uninitializedManager = new CallManager(config, tempDir);
      const result = await uninitializedManager.initiateCall("+15559876543");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Provider not initialized");
    });

    it("fails when fromNumber not configured", async () => {
      const noFromConfig = createTestConfig({ fromNumber: undefined });
      const noFromManager = new CallManager(noFromConfig, tempDir);
      noFromManager.initialize(mockProvider, "https://example.com/voice");

      const result = await noFromManager.initiateCall("+15559876543");

      expect(result.success).toBe(false);
      expect(result.error).toBe("fromNumber not configured");
    });

    it("respects concurrent call limit", async () => {
      const limitedConfig = createTestConfig({ maxConcurrentCalls: 1 });
      const limitedManager = new CallManager(limitedConfig, tempDir);
      limitedManager.initialize(mockProvider, "https://example.com/voice");

      // First call should succeed
      const first = await limitedManager.initiateCall("+15559876543");
      expect(first.success).toBe(true);

      // Second call should fail due to limit
      const second = await limitedManager.initiateCall("+15559876544");
      expect(second.success).toBe(false);
      expect(second.error).toContain("Maximum concurrent calls");
    });

    it("handles provider failure", async () => {
      const failingProvider = createMockProvider({
        initiateCall: vi.fn().mockRejectedValue(new Error("Network error")),
      });
      manager.initialize(failingProvider, "https://example.com/voice");

      const result = await manager.initiateCall("+15559876543");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
    });

    it("persists call record to disk", async () => {
      await manager.initiateCall("+15559876543");

      // Wait for async persistence
      await new Promise((r) => setTimeout(r, 50));

      const logPath = path.join(tempDir, "calls.jsonl");
      const content = await fsp.readFile(logPath, "utf-8");
      expect(content).toContain("+15559876543");
    });
  });

  describe("speak", () => {
    let callId: string;

    beforeEach(async () => {
      manager.initialize(mockProvider, "https://example.com/voice");
      const result = await manager.initiateCall("+15559876543");
      callId = result.callId;

      // Simulate call being answered
      const call = manager.getCall(callId);
      if (call) {
        call.providerCallId = "provider-call-123";
        call.state = "answered";
      }
    });

    it("speaks text to active call", async () => {
      const result = await manager.speak(callId, "Hello, world!");

      expect(result.success).toBe(true);
      expect(mockProvider.playTts).toHaveBeenCalledWith(
        expect.objectContaining({
          callId,
          providerCallId: "provider-call-123",
          text: "Hello, world!",
        }),
      );
    });

    it("adds text to transcript", async () => {
      await manager.speak(callId, "Hello, world!");
      const call = manager.getCall(callId);

      expect(call?.transcript).toHaveLength(1);
      expect(call?.transcript[0]).toMatchObject({
        speaker: "bot",
        text: "Hello, world!",
        isFinal: true,
      });
    });

    it("fails for unknown call", async () => {
      const result = await manager.speak("unknown-call-id", "Hello!");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Call not found");
    });

    it("fails for ended call", async () => {
      const call = manager.getCall(callId);
      if (call) call.state = "completed";

      const result = await manager.speak(callId, "Hello!");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Call has ended");
    });
  });

  describe("endCall", () => {
    let callId: string;

    beforeEach(async () => {
      manager.initialize(mockProvider, "https://example.com/voice");
      const result = await manager.initiateCall("+15559876543");
      callId = result.callId;

      const call = manager.getCall(callId);
      if (call) {
        call.providerCallId = "provider-call-123";
        call.state = "answered";
      }
    });

    it("ends an active call", async () => {
      const result = await manager.endCall(callId);

      expect(result.success).toBe(true);
      expect(mockProvider.hangupCall).toHaveBeenCalledWith(
        expect.objectContaining({
          callId,
          providerCallId: "provider-call-123",
          reason: "hangup-bot",
        }),
      );
    });

    it("removes call from active calls", async () => {
      await manager.endCall(callId);

      expect(manager.getCall(callId)).toBeUndefined();
      expect(manager.getActiveCalls()).toHaveLength(0);
    });

    it("succeeds silently for already-ended call", async () => {
      const call = manager.getCall(callId);
      if (call) call.state = "completed";

      const result = await manager.endCall(callId);

      expect(result.success).toBe(true);
      expect(mockProvider.hangupCall).not.toHaveBeenCalled();
    });
  });

  describe("processEvent", () => {
    let callId: string;

    beforeEach(async () => {
      manager.initialize(mockProvider, "https://example.com/voice");
      const result = await manager.initiateCall("+15559876543");
      callId = result.callId;
    });

    it("processes call.answered event", () => {
      // Clear providerCallId to test that event sets it
      const call = manager.getCall(callId);
      if (call) call.providerCallId = undefined;

      const event: NormalizedEvent = {
        id: "event-1",
        type: "call.answered",
        callId,
        providerCallId: "provider-123",
        timestamp: Date.now(),
      };

      manager.processEvent(event);
      const updatedCall = manager.getCall(callId);

      expect(updatedCall?.state).toBe("answered");
      expect(updatedCall?.providerCallId).toBe("provider-123");
      expect(updatedCall?.answeredAt).toBe(event.timestamp);
    });

    it("processes call.speech event with final transcript", () => {
      const call = manager.getCall(callId);
      if (call) {
        call.providerCallId = "provider-123";
        call.state = "listening";
      }

      const event: NormalizedEvent = {
        id: "event-2",
        type: "call.speech",
        callId,
        providerCallId: "provider-123",
        timestamp: Date.now(),
        transcript: "I need help with my order",
        isFinal: true,
      };

      manager.processEvent(event);
      const updatedCall = manager.getCall(callId);

      expect(updatedCall?.transcript).toHaveLength(1);
      expect(updatedCall?.transcript[0]).toMatchObject({
        speaker: "user",
        text: "I need help with my order",
      });
    });

    it("processes call.ended event", () => {
      const event: NormalizedEvent = {
        id: "event-3",
        type: "call.ended",
        callId,
        timestamp: Date.now(),
        reason: "hangup-user",
      };

      manager.processEvent(event);

      // Call should be removed from active calls
      expect(manager.getCall(callId)).toBeUndefined();
    });

    it("is idempotent - ignores duplicate events", () => {
      const event: NormalizedEvent = {
        id: "event-same",
        type: "call.answered",
        callId,
        timestamp: Date.now(),
      };

      manager.processEvent(event);
      manager.processEvent(event);

      const call = manager.getCall(callId);
      expect(
        call?.processedEventIds.filter((id) => id === "event-same"),
      ).toHaveLength(1);
    });

    it("ignores events for unknown calls", () => {
      const event: NormalizedEvent = {
        id: "event-unknown",
        type: "call.answered",
        callId: "unknown-call-id",
        timestamp: Date.now(),
      };

      // Should not throw
      expect(() => manager.processEvent(event)).not.toThrow();
    });
  });

  describe("getCallByProviderCallId", () => {
    beforeEach(async () => {
      manager.initialize(mockProvider, "https://example.com/voice");
    });

    it("finds call by provider call ID", async () => {
      const result = await manager.initiateCall("+15559876543");
      const call = manager.getCall(result.callId);
      if (call) call.providerCallId = "twilio-CA123456";

      const found = manager.getCallByProviderCallId("twilio-CA123456");

      expect(found).toBeDefined();
      expect(found?.callId).toBe(result.callId);
    });

    it("returns undefined for unknown provider call ID", () => {
      const found = manager.getCallByProviderCallId("unknown-id");

      expect(found).toBeUndefined();
    });

    it("returns first matching call when multiple calls exist", async () => {
      const result1 = await manager.initiateCall("+15559876543");
      const result2 = await manager.initiateCall("+15559876544");

      const call1 = manager.getCall(result1.callId);
      const call2 = manager.getCall(result2.callId);
      if (call1) call1.providerCallId = "provider-A";
      if (call2) call2.providerCallId = "provider-B";

      const found = manager.getCallByProviderCallId("provider-B");

      expect(found?.callId).toBe(result2.callId);
    });
  });

  describe("state machine transitions", () => {
    let callId: string;

    beforeEach(async () => {
      manager.initialize(mockProvider, "https://example.com/voice");
      const result = await manager.initiateCall("+15559876543");
      callId = result.callId;
    });

    it("transitions forward through states", () => {
      const events: Array<{
        type: NormalizedEvent["type"];
        expectedState: string;
      }> = [
        { type: "call.ringing", expectedState: "ringing" },
        { type: "call.answered", expectedState: "answered" },
        { type: "call.active", expectedState: "active" },
      ];

      for (const { type, expectedState } of events) {
        manager.processEvent({
          id: `event-${type}`,
          type,
          callId,
          timestamp: Date.now(),
        } as NormalizedEvent);

        expect(manager.getCall(callId)?.state).toBe(expectedState);
      }
    });

    it("allows cycling between speaking and listening", () => {
      // Set up answered call
      const call = manager.getCall(callId);
      if (call) {
        call.providerCallId = "provider-123";
        call.state = "speaking";
      }

      // Transition to listening
      manager.processEvent({
        id: "event-speech-1",
        type: "call.speech",
        callId,
        timestamp: Date.now(),
        transcript: "Hello",
        isFinal: true,
      });
      expect(manager.getCall(callId)?.state).toBe("listening");

      // Transition back to speaking
      manager.processEvent({
        id: "event-speaking-1",
        type: "call.speaking",
        callId,
        timestamp: Date.now(),
        text: "Response",
      });
      expect(manager.getCall(callId)?.state).toBe("speaking");
    });

    it("does not transition backwards from terminal state", () => {
      // End the call
      manager.processEvent({
        id: "event-end",
        type: "call.ended",
        callId,
        timestamp: Date.now(),
        reason: "completed",
      });

      // Call should be gone from active calls
      expect(manager.getCall(callId)).toBeUndefined();
    });

    it("transitions to terminal state from any non-terminal state", () => {
      const call = manager.getCall(callId);
      if (call) call.state = "speaking";

      manager.processEvent({
        id: "event-error",
        type: "call.error",
        callId,
        timestamp: Date.now(),
        error: "Connection lost",
        retryable: false,
      });

      // Call should be removed (terminal state)
      expect(manager.getCall(callId)).toBeUndefined();
    });
  });

  describe("call history", () => {
    beforeEach(async () => {
      manager.initialize(mockProvider, "https://example.com/voice");
    });

    it("returns empty array when no history", async () => {
      const history = await manager.getCallHistory();
      expect(history).toEqual([]);
    });

    it("returns persisted call records", async () => {
      // Make some calls
      await manager.initiateCall("+15559876543");
      await manager.initiateCall("+15559876544");

      // Wait for persistence
      await new Promise((r) => setTimeout(r, 100));

      const history = await manager.getCallHistory();
      expect(history.length).toBeGreaterThanOrEqual(2);
    });

    it("respects limit parameter", async () => {
      // Make several calls
      for (let i = 0; i < 5; i++) {
        await manager.initiateCall(`+1555987654${i}`);
      }

      // Wait for persistence
      await new Promise((r) => setTimeout(r, 100));

      const history = await manager.getCallHistory(2);
      expect(history.length).toBeLessThanOrEqual(2);
    });
  });

  describe("crash recovery", () => {
    it("loads active calls from persistence on init", async () => {
      // First manager makes a call
      manager.initialize(mockProvider, "https://example.com/voice");
      const result = await manager.initiateCall("+15559876543");

      // Wait for persistence
      await new Promise((r) => setTimeout(r, 100));

      // New manager should recover the call
      const newManager = new CallManager(config, tempDir);
      newManager.initialize(mockProvider, "https://example.com/voice");

      const recovered = newManager.getCall(result.callId);
      expect(recovered).toBeDefined();
      expect(recovered?.to).toBe("+15559876543");
    });

    it("does not recover terminal calls", async () => {
      manager.initialize(mockProvider, "https://example.com/voice");
      const result = await manager.initiateCall("+15559876543");

      // End the call
      const call = manager.getCall(result.callId);
      if (call) {
        call.providerCallId = "provider-123";
        call.state = "completed";
        call.endedAt = Date.now();
      }

      // Force persist
      await new Promise((r) => setTimeout(r, 100));

      // Write terminal state
      const logPath = path.join(tempDir, "calls.jsonl");
      await fsp.appendFile(logPath, `${JSON.stringify(call)}\n`);

      // New manager should not recover
      const newManager = new CallManager(config, tempDir);
      newManager.initialize(mockProvider, "https://example.com/voice");

      expect(newManager.getCall(result.callId)).toBeUndefined();
    });
  });

  describe("continueCall with transcript waiter", () => {
    let callId: string;

    beforeEach(async () => {
      manager.initialize(mockProvider, "https://example.com/voice");
      const result = await manager.initiateCall("+15559876543");
      callId = result.callId;

      const call = manager.getCall(callId);
      if (call) {
        call.providerCallId = "provider-call-123";
        call.state = "answered";
      }
    });

    it("times out when no transcript received", async () => {
      // Use short timeout for test
      const shortConfig = createTestConfig({
        store: tempDir,
        transcriptTimeoutMs: 100,
      });
      const shortManager = new CallManager(shortConfig, tempDir);
      shortManager.initialize(mockProvider, "https://example.com/voice");

      const initResult = await shortManager.initiateCall("+15559876543");
      const call = shortManager.getCall(initResult.callId);
      if (call) {
        call.providerCallId = "provider-123";
        call.state = "answered";
      }

      const result = await shortManager.continueCall(
        initResult.callId,
        "Hello?",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Timed out");
    });

    it("resolves when transcript event received", async () => {
      const shortConfig = createTestConfig({
        store: tempDir,
        transcriptTimeoutMs: 5000,
      });
      const shortManager = new CallManager(shortConfig, tempDir);
      shortManager.initialize(mockProvider, "https://example.com/voice");

      const initResult = await shortManager.initiateCall("+15559876543");
      const testCallId = initResult.callId;
      const call = shortManager.getCall(testCallId);
      if (call) {
        call.providerCallId = "provider-123";
        call.state = "answered";
      }

      // Start continueCall (will wait for transcript)
      const continuePromise = shortManager.continueCall(
        testCallId,
        "How can I help?",
      );

      // Simulate transcript event arriving
      await new Promise((r) => setTimeout(r, 50));
      shortManager.processEvent({
        id: "transcript-event",
        type: "call.speech",
        callId: testCallId,
        providerCallId: "provider-123",
        timestamp: Date.now(),
        transcript: "I need help!",
        isFinal: true,
      });

      const result = await continuePromise;

      expect(result.success).toBe(true);
      expect(result.transcript).toBe("I need help!");
    });

    it("rejects waiter when call ends", async () => {
      const shortConfig = createTestConfig({
        store: tempDir,
        transcriptTimeoutMs: 5000,
      });
      const shortManager = new CallManager(shortConfig, tempDir);
      shortManager.initialize(mockProvider, "https://example.com/voice");

      const initResult = await shortManager.initiateCall("+15559876543");
      const testCallId = initResult.callId;
      const call = shortManager.getCall(testCallId);
      if (call) {
        call.providerCallId = "provider-123";
        call.state = "answered";
      }

      // Start continueCall
      const continuePromise = shortManager.continueCall(testCallId, "Hello?");

      // Simulate call ending
      await new Promise((r) => setTimeout(r, 50));
      shortManager.processEvent({
        id: "end-event",
        type: "call.ended",
        callId: testCallId,
        timestamp: Date.now(),
        reason: "hangup-user",
      });

      const result = await continuePromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain("Call ended");
    });
  });
});
