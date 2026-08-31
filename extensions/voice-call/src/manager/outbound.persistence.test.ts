import fs from "node:fs";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEventManagerHarness } from "../manager.test-harness.js";
import type { InitiateCallResult } from "../types.js";
import { initiateCall } from "./outbound.js";
import { loadActiveCallsFromStore } from "./store.js";

const { cleanup, createContext, createProvider, setup } = createEventManagerHarness();
beforeEach(setup);
afterEach(cleanup);

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
