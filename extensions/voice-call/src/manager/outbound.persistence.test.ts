import fs from "node:fs";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEventManagerHarness } from "../manager.test-harness.js";
import { PlivoProvider } from "../providers/plivo.js";
import type { InitiateCallResult } from "../types.js";
import { processEvent } from "./events.js";
import { initiateCall, speak } from "./outbound.js";
import { getCallHistoryFromStore, loadActiveCallsFromStore } from "./store.js";

const { cleanup, createContext, createProvider, setup } = createEventManagerHarness();
beforeEach(setup);
afterEach(cleanup);

it.each([
  { phase: "active", requestUuid: undefined, payload: "CallUUID-only parser control" },
  { phase: "active", requestUuid: "request-uuid", payload: "complete callback" },
  { phase: "ended", requestUuid: "request-uuid", payload: "complete callback" },
])(
  "preserves callback-owned identity when initiation settles after the call is $phase ($payload)",
  async ({ phase, requestUuid }) => {
    const placement = createDeferred<InitiateCallResult>();
    const playback = vi.fn(async () => {});
    const ctx = createContext({
      provider: createProvider({ initiateCall: () => placement.promise, playTts: playback }),
      webhookUrl: "https://example.com/voice/webhook",
    });
    const parser = new PlivoProvider({ authId: "MA-fixture", authToken: "synthetic-token" });
    const pending = initiateCall(ctx, "+15550000001");
    try {
      const call = [...ctx.activeCalls.values()][0];
      if (!call) {
        throw new Error("expected the pending outbound call");
      }
      const deliver = (fields: Record<string, string>) => {
        const parsed = parser.parseWebhookEvent({
          headers: {},
          method: "POST",
          url: `https://example.com/voice/webhook?callId=${call.callId}`,
          query: { callId: call.callId },
          rawBody: new URLSearchParams({
            CallUUID: "canonical-call-uuid",
            ...(requestUuid ? { RequestUUID: requestUuid } : {}),
            Direction: "outbound",
            ...fields,
          }).toString(),
        });
        expect(parsed.events).toHaveLength(1);
        for (const event of parsed.events) {
          processEvent(ctx, event);
        }
      };
      deliver({ CallStatus: "in-progress" });
      expect(call.providerCallId).toBe("canonical-call-uuid");
      if (phase === "ended") {
        deliver({ CallStatus: "completed" });
      }
      const beforeResult = await getCallHistoryFromStore(ctx.storePath);

      placement.resolve({ providerCallId: "request-uuid", status: "initiated" });
      await expect(pending).resolves.toEqual({ callId: call.callId, success: true });
      expect(call.providerCallId).toBe("canonical-call-uuid");

      if (phase === "active") {
        deliver({ CallStatus: "in-progress", Speech: "Continue the connected call." });
        await expect(speak(ctx, call.callId, "Still connected.")).resolves.toEqual({
          success: true,
        });
        expect(playback).toHaveBeenCalledWith(
          expect.objectContaining({ callId: call.callId, providerCallId: "canonical-call-uuid" }),
        );
        expect(ctx.providerCallIdMap).toEqual(new Map([["canonical-call-uuid", call.callId]]));
      } else {
        expect(await getCallHistoryFromStore(ctx.storePath)).toEqual(beforeResult);
        expect(ctx.activeCalls.size).toBe(0);
        expect(ctx.providerCallIdMap.size).toBe(0);
      }
    } finally {
      placement.resolve({ providerCallId: "request-uuid", status: "initiated" });
      await pending;
    }
  },
);

it("keeps outbound capacity available after storage failure without dialing", async () => {
  const placement = createDeferred<InitiateCallResult>();
  const dial = vi.fn(() => placement.promise);
  const ctx = createContext({
    provider: createProvider({ initiateCall: dial }),
    webhookUrl: "https://example.com/voice/webhook",
  });
  ctx.config.maxConcurrentCalls = 1;
  const statePath = path.join(ctx.storePath, "state");
  fs.writeFileSync(statePath, "block the database directory");

  await expect(initiateCall(ctx, "+15550000001")).rejects.toMatchObject({
    code: "PLUGIN_STATE_OPEN_FAILED",
  });
  expect(dial).not.toHaveBeenCalled();
  expect(ctx.activeCalls.size).toBe(0);
  expect(ctx.providerCallIdMap.size).toBe(0);

  fs.unlinkSync(statePath);
  const recovered = initiateCall(ctx, "+15550000001");
  try {
    await expect(initiateCall(ctx, "+15550000002")).resolves.toMatchObject({
      success: false,
      error: "Maximum concurrent calls (1) reached",
    });
    expect(dial).toHaveBeenCalledOnce();
  } finally {
    placement.resolve({ providerCallId: "provider-recovered", status: "initiated" });
    await recovered;
  }
  const result = await recovered;
  expect(result.success).toBe(true);
  expect(ctx.activeCalls.size).toBe(1);
  expect(ctx.providerCallIdMap.get("provider-recovered")).toBe(result.callId);
  expect(loadActiveCallsFromStore(ctx.storePath).activeCalls.get(result.callId)).toMatchObject({
    providerCallId: "provider-recovered",
    state: "initiated",
  });
});
