import { describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { GatewayProtocolRequestOptions } from "./protocol-request.js";
import { GatewayScopeUpgrade } from "./scope-upgrade.js";

const binding = { clientId: "control-ui", deviceId: "device-1", role: "operator" };
const scopes = ["operator.admin", "operator.read"];

describe("GatewayScopeUpgrade", () => {
  it("persists approved credentials before reconnecting", async () => {
    const order: string[] = [];
    const request = vi.fn(async (method: string) => {
      if (method === "device.scopes.requestUpgrade") {
        return { requestId: "upgrade-1" };
      }
      return {
        status: "approved",
        requestId: "upgrade-1",
        deviceToken: "rotated-token",
        scopes,
      };
    });
    const store = vi.fn(async () => {
      order.push("store");
    });
    const reconnect = vi.fn(() => {
      order.push("reconnect");
    });
    const onPending = vi.fn();
    const client = new GatewayScopeUpgrade({
      request,
      tokenStore: { load: vi.fn(), store, clear: vi.fn() },
      reconnect,
    });

    await expect(client.requestScopeUpgrade({ binding, scopes, onPending })).resolves.toEqual({
      status: "approved",
      requestId: "upgrade-1",
      scopes,
    });
    expect(onPending).toHaveBeenCalledWith("upgrade-1");
    expect(store).toHaveBeenCalledWith({
      ...binding,
      token: "rotated-token",
      scopes,
    });
    expect(order).toEqual(["store", "reconnect"]);
  });

  it.each(["rejected", "expired"] as const)(
    "returns %s without replacing credentials",
    async (status) => {
      const store = vi.fn();
      const reconnect = vi.fn();
      const client = new GatewayScopeUpgrade({
        request: vi
          .fn()
          .mockResolvedValueOnce({ requestId: "upgrade-1" })
          .mockResolvedValueOnce({ status, requestId: "upgrade-1" }),
        tokenStore: { load: vi.fn(), store, clear: vi.fn() },
        reconnect,
      });

      await expect(client.requestScopeUpgrade({ binding, scopes })).resolves.toEqual({
        status,
        requestId: "upgrade-1",
      });
      expect(store).not.toHaveBeenCalled();
      expect(reconnect).not.toHaveBeenCalled();
    },
  );

  it("coalesces concurrent requests and allows a cancelled wait to restart", async () => {
    let waitStarted = createDeferred<AbortSignal | undefined>();
    const request = vi.fn(
      async (method: string, _params?: unknown, options?: GatewayProtocolRequestOptions) => {
        if (method === "device.scopes.requestUpgrade") {
          return { requestId: "upgrade-1" };
        }
        return await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("scope upgrade wait aborted")),
            { once: true },
          );
          waitStarted.resolve(options?.signal);
        });
      },
    );
    const client = new GatewayScopeUpgrade({
      request,
      tokenStore: { load: vi.fn(), store: vi.fn(), clear: vi.fn() },
      reconnect: vi.fn(),
    });
    const first = client.requestScopeUpgrade({ binding, scopes });
    const duplicate = client.requestScopeUpgrade({ binding, scopes });
    expect(duplicate).toBe(first);
    const firstWaitSignal = await withTestTimeout(
      waitStarted.promise,
      1_000,
      "Scope upgrade wait did not start",
    );
    expect(firstWaitSignal).toBeDefined();
    expect(request).toHaveBeenCalledTimes(2);

    client.cancelScopeUpgrade();
    await expect(first).rejects.toBeDefined();
    expect(firstWaitSignal?.aborted).toBe(true);
    waitStarted = createDeferred<AbortSignal | undefined>();
    const restarted = client.requestScopeUpgrade({ binding, scopes });
    await withTestTimeout(waitStarted.promise, 1_000, "Scope upgrade wait did not restart");
    expect(request).toHaveBeenCalledTimes(4);
    client.cancelScopeUpgrade();
    await expect(restarted).rejects.toBeDefined();
  });
});
