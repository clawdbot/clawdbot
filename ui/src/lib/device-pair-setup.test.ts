// @vitest-environment node
import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDevicePairSetup,
  completeDevicePairSetup,
  createDevicePairSetupState,
  markDevicePairSetupDeliveryUncertain,
  openDevicePairSetup,
  parseDevicePairSetupCompletion,
  parseDevicePairSetupDeliveryUncertain,
  refreshDevicePairSetup,
  requestDevicePairJoinSetup,
  setDevicePairSetupAccess,
  syncDevicePairSetupCountdown,
  type DevicePairSetupLifecycle,
} from "./device-pair-setup.ts";

type DevicePairSetupState = ReturnType<typeof createDevicePairSetupState>;
type DevicePairSetup = Extract<DevicePairSetupLifecycle, { phase: "waiting" }>["setup"];
type DevicePairSetupCompletion = NonNullable<ReturnType<typeof parseDevicePairSetupCompletion>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function setupResult(
  setupId: string,
  setupCode: string,
  params: {
    access?: "full" | "limited" | "node";
    accessDowngraded?: boolean;
    expiresAtMs?: number;
  } = {},
): DevicePairSetup {
  return {
    setupId,
    setupCode,
    expiresAtMs: params.expiresAtMs ?? Date.now() + 60_000,
    gatewayUrl: "wss://gateway.example.com",
    auth: "token",
    urlSource: "test",
    ...(params.access ? { access: params.access } : {}),
    ...(params.accessDowngraded ? { accessDowngraded: true } : {}),
  };
}

function completion(setupId: string): DevicePairSetupCompletion {
  return {
    setupId,
    deviceName: "Operator’s iPhone",
    access: "full",
  };
}

function stateWithClient(client: DevicePairSetupState["client"]): DevicePairSetupState {
  const state = createDevicePairSetupState({ client, connected: true });
  state.devicePairSetupOpen = true;
  return state;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("device pairing setup state", () => {
  it("requests a one-paste join URL without rendering a QR", async () => {
    const result = setupResult("NODE", "node");
    const request = vi.fn().mockResolvedValue({
      ...result,
      joinUrl: "https://gateway.example.com/j/fresh-code",
    });

    await expect(requestDevicePairJoinSetup({ request })).resolves.toMatchObject({
      joinUrl: "https://gateway.example.com/j/fresh-code",
    });
    expect(request).toHaveBeenCalledWith(
      "device.pair.setupCode",
      { includeQr: false, joinUrl: true },
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    );
  });

  it("opens in access selection without minting a setup credential", async () => {
    const request = vi.fn();
    const state = createDevicePairSetupState({
      client: { request } as unknown as DevicePairSetupState["client"],
      connected: true,
    });

    await openDevicePairSetup(state);

    expect(state.devicePairSetupOpen).toBe(true);
    expect(state.devicePairSetupLifecycle).toEqual({ phase: "selection", access: "full" });
    expect(request).not.toHaveBeenCalled();
  });

  it("ignores a setup response from a replaced Gateway client", async () => {
    const oldResponse = deferred<DevicePairSetup>();
    const newResponse = deferred<DevicePairSetup>();
    const oldClient = {
      request: vi.fn(() => oldResponse.promise),
    } as unknown as DevicePairSetupState["client"];
    const newClient = {
      request: vi.fn(() => newResponse.promise),
    } as unknown as DevicePairSetupState["client"];
    const state = stateWithClient(oldClient);

    const oldRequest = refreshDevicePairSetup(state);
    closeDevicePairSetup(state);
    state.client = newClient;
    state.connected = true;
    state.devicePairSetupOpen = true;
    const newRequest = refreshDevicePairSetup(state);

    oldResponse.resolve(setupResult("old-setup", "OLD"));
    await oldRequest;
    expect(state.devicePairSetupLifecycle).toEqual({ phase: "loading", access: "full" });

    newResponse.resolve(setupResult("new-setup", "NEW"));
    await newRequest;
    expect(state.devicePairSetupLifecycle).toMatchObject({
      phase: "waiting",
      setup: { setupCode: "NEW" },
    });
    closeDevicePairSetup(state);
  });

  it("ignores an older request after closing and reopening on the same client", async () => {
    const oldResponse = deferred<DevicePairSetup>();
    const newResponse = deferred<DevicePairSetup>();
    const client = {
      request: vi
        .fn()
        .mockReturnValueOnce(oldResponse.promise)
        .mockReturnValueOnce(newResponse.promise),
    } as unknown as DevicePairSetupState["client"];
    const state = stateWithClient(client);

    const oldRequest = refreshDevicePairSetup(state);
    closeDevicePairSetup(state);
    state.devicePairSetupOpen = true;
    const newRequest = refreshDevicePairSetup(state);

    oldResponse.resolve(setupResult("old-setup", "OLD"));
    await oldRequest;
    expect(state.devicePairSetupLifecycle.phase).toBe("loading");

    newResponse.resolve(setupResult("new-setup", "NEW"));
    await newRequest;
    expect(state.devicePairSetupLifecycle).toMatchObject({
      phase: "waiting",
      setup: { setupCode: "NEW" },
    });
    closeDevicePairSetup(state);
  });

  it("clears setup credentials and the expiry timer when the dialog closes", () => {
    vi.useFakeTimers();
    const state = stateWithClient(null);
    state.devicePairSetupLifecycle = {
      phase: "waiting",
      access: "full",
      setup: setupResult("active-setup", "SECRET"),
    };
    state.devicePairSetupExpiryTimer = setTimeout(() => {}, 60_000);

    closeDevicePairSetup(state);

    expect(state.devicePairSetupOpen).toBe(false);
    expect(state.devicePairSetupLifecycle).toEqual({ phase: "selection", access: "full" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves full and limited access request contracts", async () => {
    const request = vi.fn().mockResolvedValue(setupResult("limited-setup", "LIMITED"));
    const state = stateWithClient({ request } as unknown as DevicePairSetupState["client"]);

    await setDevicePairSetupAccess(state, "limited");
    expect(request).not.toHaveBeenCalled();
    await refreshDevicePairSetup(state);

    expect(request.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "device.pair.setupCode",
      { bootstrapProfile: "limited" },
    ]);
    expect(state.devicePairSetupLifecycle).toMatchObject({
      phase: "waiting",
      access: "limited",
      setup: { setupCode: "LIMITED" },
    });
    closeDevicePairSetup(state);

    state.devicePairSetupOpen = true;
    request.mockResolvedValueOnce(setupResult("full-setup", "FULL"));
    await refreshDevicePairSetup(state);
    expect(request.mock.calls.at(-1)?.slice(0, 2)).toEqual(["device.pair.setupCode", {}]);
    closeDevicePairSetup(state);
  });

  it("requests the node bootstrap profile when selected", async () => {
    const request = vi.fn().mockResolvedValue(setupResult("NODE", "node"));
    const state = stateWithClient({
      request,
    } as unknown as DevicePairSetupState["client"]);

    await setDevicePairSetupAccess(state, "node");
    await refreshDevicePairSetup(state);

    expect(request.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "device.pair.setupCode",
      { bootstrapProfile: "node", includeQr: false },
    ]);
    expect(state.devicePairSetupLifecycle).toMatchObject({ phase: "waiting", access: "node" });
    closeDevicePairSetup(state);
  });

  it("reflects a server-side plaintext downgrade", async () => {
    const request = vi.fn().mockResolvedValue(
      setupResult("downgraded-setup", "LIMITED", {
        access: "limited",
        accessDowngraded: true,
      }),
    );
    const state = stateWithClient({ request } as unknown as DevicePairSetupState["client"]);

    await refreshDevicePairSetup(state);

    expect(state.devicePairSetupLifecycle).toMatchObject({
      phase: "waiting",
      access: "limited",
      setup: { accessDowngraded: true },
    });
    closeDevicePairSetup(state);
  });

  it("keeps the selected access when setup creation fails", async () => {
    const request = vi.fn().mockRejectedValue(new Error("setup unavailable"));
    const state = stateWithClient({ request } as unknown as DevicePairSetupState["client"]);

    await refreshDevicePairSetup(state);

    expect(state.devicePairSetupLifecycle).toEqual({
      phase: "error",
      source: "create",
      access: "full",
      message: "setup unavailable",
    });
    expect(state.devicePairSetupExpiryTimer).toBeNull();
  });

  it("fails visibly when an older gateway omits lifecycle metadata", async () => {
    const request = vi.fn().mockResolvedValue({
      setupCode: "LEGACY",
      gatewayUrl: "wss://gateway.example.com",
      auth: "token",
      urlSource: "test",
    });
    const state = stateWithClient({ request } as unknown as DevicePairSetupState["client"]);

    await refreshDevicePairSetup(state);

    expect(state.devicePairSetupLifecycle).toEqual({
      phase: "error",
      source: "create",
      access: "full",
      message:
        "Gateway does not provide pairing lifecycle metadata. Update the Gateway and try again.",
    });
    expect(state.devicePairSetupExpiryTimer).toBeNull();
  });

  it("completes only the exact active setup and immediately retires its credential", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const request = vi
      .fn()
      .mockResolvedValue(
        setupResult("active-setup", "SECRET", { expiresAtMs: Date.now() + 60_000 }),
      );
    const state = stateWithClient({ request } as unknown as DevicePairSetupState["client"]);
    const onChange = vi.fn();
    state.onDevicePairSetupChange = onChange;
    await refreshDevicePairSetup(state);

    expect(completeDevicePairSetup(state, completion("unrelated-setup"))).toBe(false);
    expect(state.devicePairSetupLifecycle.phase).toBe("waiting");

    expect(completeDevicePairSetup(state, completion("active-setup"))).toBe(true);
    expect(state.devicePairSetupLifecycle).toEqual({
      phase: "success",
      access: "full",
      deviceName: "Operator’s iPhone",
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(onChange).toHaveBeenCalledOnce();

    expect(completeDevicePairSetup(state, completion("active-setup"))).toBe(false);
  });

  // The modal keeps only what it renders; correlation and presentation fields
  // survive, the rest of the event is dropped rather than carried as dead state.
  it("keeps only the rendered fields of the completion payload", () => {
    expect(
      parseDevicePairSetupCompletion({
        setupId: "setup-1",
        deviceId: "device-1",
        deviceName: "  Operator’s iPhone  ",
        access: "limited",
        ts: 1_000,
      }),
    ).toEqual({
      setupId: "setup-1",
      deviceName: "Operator’s iPhone",
      access: "limited",
    });
    expect(
      parseDevicePairSetupCompletion({
        setupId: "setup-1",
        deviceId: "device-1",
        deviceName: "   ",
        access: "node",
        ts: 1_000,
      }),
    ).toEqual({ setupId: "setup-1", access: "node" });
  });

  it("stops the node countdown when delivery reaches a terminal outcome", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const state = createDevicePairSetupState({ client: null, connected: true });
    state.devicePairSetupOpen = true;
    state.devicePairSetupLifecycle = {
      phase: "waiting",
      access: "node",
      setup: setupResult("node-setup", "NODE", { access: "node", expiresAtMs: 10_000 }),
    };
    syncDevicePairSetupCountdown(state, vi.fn());
    expect(state.devicePairSetupCountdownTimer).not.toBeNull();

    expect(completeDevicePairSetup(state, { setupId: "node-setup", access: "node" })).toBe(true);

    expect(state.devicePairSetupCountdownTimer).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces delivery uncertainty as a recoverable terminal state", () => {
    const state = createDevicePairSetupState({ client: null, connected: true });
    state.devicePairSetupOpen = true;
    state.devicePairSetupLifecycle = {
      phase: "waiting",
      access: "limited",
      setup: setupResult("setup-uncertain", "SECRET", { access: "limited" }),
    };
    const parsed = parseDevicePairSetupDeliveryUncertain({
      setupId: "setup-uncertain",
      deviceId: "phone-1",
      deviceName: " Phone ",
      access: "limited",
      ts: 1,
    });

    expect(parsed).toEqual({ setupId: "setup-uncertain", access: "limited" });
    expect(markDevicePairSetupDeliveryUncertain(state, parsed!)).toBe(true);
    expect(state.devicePairSetupLifecycle).toEqual({
      phase: "delivery-uncertain",
      access: "limited",
    });
  });

  it.each([
    ["a non-record payload", "not-an-object"],
    ["a missing setup id", { access: "full" }],
    ["an empty setup id", { setupId: "", access: "full" }],
    ["an unknown access level", { setupId: "setup-1", access: "admin" }],
    ["a missing access level", { setupId: "setup-1", deviceId: "device-1" }],
  ] as const)("rejects %s", (_label, payload) => {
    expect(parseDevicePairSetupCompletion(payload)).toBeNull();
  });

  it("expires only the currently active setup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const onChange = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValueOnce(setupResult("old-setup", "OLD", { expiresAtMs: 2_000 }))
      .mockResolvedValueOnce(setupResult("new-setup", "NEW", { expiresAtMs: 5_000 }));
    const state = createDevicePairSetupState({
      client: { request } as unknown as DevicePairSetupState["client"],
      connected: true,
      onChange,
    });
    state.devicePairSetupOpen = true;

    await refreshDevicePairSetup(state);
    await refreshDevicePairSetup(state);
    expect(state.devicePairSetupLifecycle).toMatchObject({
      phase: "waiting",
      setup: { setupId: "new-setup", setupCode: "NEW" },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.devicePairSetupLifecycle.phase).toBe("waiting");
    expect(onChange).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(state.devicePairSetupLifecycle).toEqual({ phase: "expired", access: "full" });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  // The completion broadcast is droppable, so expiry has to ask the gateway
  // before it can claim the credential was never used.
  it("reconciles a missed completion at expiry instead of showing expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const onChange = vi.fn();
    const request = vi.fn(async (method: string) =>
      method === "device.pair.setupStatus"
        ? { completion: completion("live-setup") }
        : setupResult("live-setup", "SECRET", { expiresAtMs: 2_000 }),
    );
    const state = createDevicePairSetupState({
      client: { request } as unknown as DevicePairSetupState["client"],
      connected: true,
      onChange,
    });
    state.devicePairSetupOpen = true;

    await refreshDevicePairSetup(state);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(request).toHaveBeenCalledWith("device.pair.setupStatus", { setupId: "live-setup" });
    expect(state.devicePairSetupLifecycle).toEqual({
      phase: "success",
      access: "full",
      deviceName: "Operator’s iPhone",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows expiry only when the gateway authoritatively has no completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const request = vi.fn(async (method: string) =>
      method === "device.pair.setupStatus"
        ? {}
        : setupResult("live-setup", "SECRET", { expiresAtMs: 2_000 }),
    );
    const state = createDevicePairSetupState({
      client: { request } as unknown as DevicePairSetupState["client"],
      connected: true,
    });
    state.devicePairSetupOpen = true;

    await refreshDevicePairSetup(state);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(state.devicePairSetupLifecycle).toEqual({ phase: "expired", access: "full" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires the bearer while an expiry status lookup is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const status = deferred<Record<string, never>>();
    const onChange = vi.fn();
    const request = vi.fn(async (method: string) =>
      method === "device.pair.setupStatus"
        ? await status.promise
        : setupResult("live-setup", "SECRET", { expiresAtMs: 2_000 }),
    );
    const state = createDevicePairSetupState({
      client: { request } as unknown as DevicePairSetupState["client"],
      connected: true,
      onChange,
    });
    state.devicePairSetupOpen = true;

    await refreshDevicePairSetup(state);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(state.devicePairSetupLifecycle).toEqual({
      phase: "reconciling",
      access: "full",
      setupId: "live-setup",
    });
    expect(onChange).toHaveBeenCalledOnce();

    status.resolve({});
    await vi.advanceTimersByTimeAsync(0);

    expect(state.devicePairSetupLifecycle).toEqual({ phase: "expired", access: "full" });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "the reconcile request fails",
      async () => {
        throw new Error("offline");
      },
      "offline",
    ],
    [
      "the recorded completion belongs to another setup",
      async () => ({ completion: completion("other-setup") }),
      "Invalid setup status response",
    ],
  ] as const)(
    "keeps an unknown outcome recoverable when %s",
    async (_label, statusResponse, message) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const request = vi.fn(async (method: string) =>
        method === "device.pair.setupStatus"
          ? await statusResponse()
          : setupResult("live-setup", "SECRET", { expiresAtMs: 2_000 }),
      );
      const state = createDevicePairSetupState({
        client: { request } as unknown as DevicePairSetupState["client"],
        connected: true,
      });
      state.devicePairSetupOpen = true;

      await refreshDevicePairSetup(state);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(state.devicePairSetupLifecycle).toEqual({
        phase: "error",
        source: "status",
        access: "full",
        setupId: "live-setup",
        message,
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retries an unknown outcome without minting a replacement credential", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const request = vi
      .fn()
      .mockResolvedValueOnce(setupResult("live-setup", "SECRET", { expiresAtMs: 2_000 }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ completion: completion("live-setup") });
    const state = createDevicePairSetupState({
      client: { request } as unknown as DevicePairSetupState["client"],
      connected: true,
    });
    state.devicePairSetupOpen = true;

    await refreshDevicePairSetup(state);
    await vi.advanceTimersByTimeAsync(1_000);
    await refreshDevicePairSetup(state);

    expect(request).toHaveBeenLastCalledWith("device.pair.setupStatus", {
      setupId: "live-setup",
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(state.devicePairSetupLifecycle).toEqual({
      phase: "success",
      access: "full",
      deviceName: "Operator’s iPhone",
    });
  });

  it("lets a regenerated setup outlive a slow reconcile for the retired one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const status = deferred<{ completion?: DevicePairSetupCompletion }>();
    const request = vi
      .fn()
      .mockImplementation(async (method: string) =>
        method === "device.pair.setupStatus" ? await status.promise : setupResult("new", "NEW"),
      )
      .mockImplementationOnce(async () => setupResult("old", "OLD", { expiresAtMs: 2_000 }));
    const state = createDevicePairSetupState({
      client: { request } as unknown as DevicePairSetupState["client"],
      connected: true,
    });
    state.devicePairSetupOpen = true;

    await refreshDevicePairSetup(state);
    await vi.advanceTimersByTimeAsync(1_000);
    await refreshDevicePairSetup(state);
    expect(state.devicePairSetupLifecycle).toMatchObject({
      phase: "waiting",
      setup: { setupId: "new" },
    });

    status.resolve({ completion: completion("old") });
    await vi.advanceTimersByTimeAsync(0);

    expect(state.devicePairSetupLifecycle).toMatchObject({
      phase: "waiting",
      setup: { setupId: "new" },
    });
  });

  it("retires a setup response that is already expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const onChange = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValue(setupResult("expired-setup", "SECRET", { expiresAtMs: 1_999 }));
    const state = createDevicePairSetupState({
      client: { request } as unknown as DevicePairSetupState["client"],
      connected: true,
      onChange,
    });
    state.devicePairSetupOpen = true;

    await refreshDevicePairSetup(state);
    // Even an already-lapsed credential reconciles first; expiry lands one turn later.
    await vi.advanceTimersByTimeAsync(0);

    expect(state.devicePairSetupLifecycle).toEqual({ phase: "expired", access: "full" });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
