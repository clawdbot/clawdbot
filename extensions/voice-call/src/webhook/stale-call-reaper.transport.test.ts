// Voice Call tests cover stale-call reaping through a real provider HTTP boundary.
import type { ServerResponse } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withFetchPreconnect, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { endCall } from "../manager/outbound.js";
import { TelnyxProvider } from "../providers/telnyx.js";
import type { CallRecord } from "../types.js";
import { startStaleCallReaper } from "./stale-call-reaper.js";

async function waitForProofEvent<T>(promise: Promise<T>, label: string): Promise<T> {
  // AbortSignal.timeout stays real while this suite fakes the global timer functions.
  const timeoutSignal = AbortSignal.timeout(1_000);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(`timed out waiting for ${label}`));
    timeoutSignal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        timeoutSignal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        timeoutSignal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

describe("stale-call reaper provider transport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps one Telnyx hangup in flight, then retries after the provider timeout", async () => {
    vi.useFakeTimers({
      // Voice provider requests use buildTimeoutAbortSignal's setTimeout timer.
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));

    const firstRequestStarted = createDeferred<void>();
    const firstResponseClosed = createDeferred<void>();
    const secondRequestStarted = createDeferred<void>();
    let requestCount = 0;
    let firstResponse: ServerResponse | undefined;

    await withServer(
      (_req, res) => {
        requestCount += 1;
        if (requestCount === 1) {
          firstResponse = res;
          res.once("close", () => firstResponseClosed.resolve());
          firstRequestStarted.resolve();
          return;
        }
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("controlled provider failure");
        secondRequestStarted.resolve();
      },
      async (baseUrl) => {
        const realFetch = globalThis.fetch.bind(globalThis);
        const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const providerUrl = new URL(input instanceof Request ? input.url : String(input));
          const loopbackUrl = new URL(`${providerUrl.pathname}${providerUrl.search}`, baseUrl);
          return await realFetch(loopbackUrl, init);
        });
        vi.stubGlobal("fetch", withFetchPreconnect(transport));

        const provider = new TelnyxProvider({
          apiKey: "KEY123",
          connectionId: "connection-test",
        });
        const call = {
          callId: "call-stale",
          providerCallId: "provider-stale",
          provider: "telnyx",
          direction: "outbound",
          from: "+10000000001",
          to: "+10000000002",
          startedAt: Date.now() - 61_000,
          state: "active" as const,
          transcript: [],
          processedEventIds: [],
        } satisfies CallRecord;
        const context: Parameters<typeof endCall>[0] = {
          activeCalls: new Map([[call.callId, call]]),
          providerCallIdMap: new Map([[call.providerCallId, call.callId]]),
          provider,
          storePath: "/tmp/openclaw-voice-call-proof.json",
          transcriptWaiters: new Map(),
          maxDurationTimers: new Map(),
          endCallOperations: new Map(),
        };
        const manager = {
          getActiveCalls: () => [...context.activeCalls.values()],
          endCall: vi.fn((callId: string) => endCall(context, callId)),
        };

        const stop = startStaleCallReaper({
          manager,
          staleCallReaperSeconds: 60,
        });

        await vi.advanceTimersByTimeAsync(30_000);
        await waitForProofEvent(firstRequestStarted.promise, "the first provider request");
        expect(requestCount).toBe(1);
        const firstOperation = manager.endCall.mock.results[0]?.value;
        expect(firstOperation).toBeDefined();
        const sharedOperation = endCall(context, call.callId);
        expect(sharedOperation).toBe(firstOperation);

        // The next sweep coincides with the provider's 30s request timeout. It must
        // not start another hangup before the first attempt has settled.
        await vi.advanceTimersByTimeAsync(30_000);
        expect(requestCount).toBe(1);
        expect(manager.endCall).toHaveBeenCalledTimes(1);
        expect(firstResponse).toBeDefined();

        const firstResult = await waitForProofEvent(
          firstOperation!,
          "the first endCall settlement",
        );
        await waitForProofEvent(firstResponseClosed.promise, "the timed-out socket close");
        expect(firstResult).toEqual({ success: false, error: "request timed out" });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(30_000);
        await waitForProofEvent(secondRequestStarted.promise, "the retried provider request");
        const retryOperation = manager.endCall.mock.results[1]?.value;
        expect(retryOperation).toBeDefined();
        const secondResult = await waitForProofEvent(
          retryOperation!,
          "the retried endCall settlement",
        );

        expect(requestCount).toBe(2);
        expect(manager.endCall).toHaveBeenCalledTimes(2);
        expect(secondResult).toEqual({
          success: false,
          error: "Telnyx API error: 503 controlled provider failure",
        });
        expect(transport).toHaveBeenCalledTimes(2);

        stop?.();
      },
    );
  });
});
