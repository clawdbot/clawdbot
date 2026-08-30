import { describe, expect, it } from "vitest";
import { GatewayPendingRequests } from "./pending-request.js";

describe("GatewayPendingRequests", () => {
  it("does not retain settled IDs for the socket generation", async () => {
    let requestId = 0;
    const requests = new GatewayPendingRequests({
      createRequestId: () => `request-${requestId++}`,
      nowMs: () => 0,
    });
    const sender = {
      send: () => {
        throw new Error("synthetic send failure");
      },
    };

    for (let index = 0; index < 100; index += 1) {
      await requests.request(sender, "bounded", {}, { timeoutMs: null }).catch(() => undefined);
    }

    const retained = (requests as unknown as { retiredIds?: ReadonlySet<string> }).retiredIds;
    expect(retained?.size ?? 0).toBe(0);
  });

  it("preserves replacement-generation requests created by a close timing observer", async () => {
    const sent: Array<{ id: string; method: string }> = [];
    let replacement: Promise<{ healthy: boolean }> | undefined;
    const sender = {
      send: (frame: string) => {
        const { id, method } = JSON.parse(frame) as { id: string; method: string };
        sent.push({ id, method });
      },
    };
    const requests = new GatewayPendingRequests({
      createRequestId: () => "stable",
      nowMs: () => 0,
      onTiming: ({ method }) => {
        if (method === "retired") {
          replacement = requests.request(sender, "replacement", {}, { timeoutMs: null });
          void replacement.catch(() => undefined);
        }
      },
    });
    const retired = requests.request(sender, "retired", {}, { timeoutMs: null });
    const alsoRetired = requests.request(sender, "also-retired", {}, { timeoutMs: null });
    void retired.catch(() => undefined);
    void alsoRetired.catch(() => undefined);

    requests.flush(new Error("old socket closed"));

    expect(sent).toEqual([
      { id: "1:stable", method: "retired" },
      { id: "2:stable", method: "also-retired" },
      { id: "1:stable", method: "replacement" },
    ]);
    expect(requests.hasPending).toBe(true);
    requests.handleResponse({
      type: "res",
      id: "1:stable",
      ok: true,
      payload: { healthy: true },
    });

    await expect(retired).rejects.toThrow("old socket closed");
    await expect(alsoRetired).rejects.toThrow("old socket closed");
    await expect(replacement).resolves.toEqual({ healthy: true });
    expect(requests.hasPending).toBe(false);
  });

  it("settles each retired request once when its timing observer shuts down again", async () => {
    const timings: string[] = [];
    const requests = new GatewayPendingRequests({
      createRequestId: () => "stable",
      nowMs: () => 0,
      onTiming: ({ method }) => {
        timings.push(method);
        if (timings.length === 1) {
          requests.flush(new Error("nested shutdown"));
        }
      },
    });
    const retired = requests.request(
      { send: () => {} },
      "session.observe",
      {},
      {
        timeoutMs: null,
      },
    );
    void retired.catch(() => undefined);

    requests.flush(new Error("transport closed"));

    expect(timings).toEqual(["session.observe"]);
    await expect(retired).rejects.toThrow("transport closed");
    expect(requests.hasPending).toBe(false);
  });
});
