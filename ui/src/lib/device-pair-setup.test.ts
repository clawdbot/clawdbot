// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  closeDevicePairSetup,
  createDevicePairSetupState,
  openDevicePairSetup,
  refreshDevicePairSetup,
  setDevicePairSetupAccess,
  type DevicePairSetup,
} from "./device-pair-setup.ts";

type DevicePairSetupState = ReturnType<typeof createDevicePairSetupState>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function setupResult(
  setupCode: string,
  access?: "full" | "limited",
  accessDowngraded?: boolean,
): DevicePairSetup {
  return {
    setupCode,
    gatewayUrl: "wss://gateway.example.com",
    auth: "token",
    urlSource: "test",
    ...(access ? { access } : {}),
    ...(accessDowngraded ? { accessDowngraded: true } : {}),
  };
}

function stateWithClient(client: DevicePairSetupState["client"]): DevicePairSetupState {
  const state = createDevicePairSetupState({ client, connected: true });
  state.devicePairSetupOpen = true;
  return state;
}

describe("device pairing setup state", () => {
  it("opens without minting a setup credential", async () => {
    const request = vi.fn();
    const state = createDevicePairSetupState({
      client: { request } as unknown as DevicePairSetupState["client"],
      connected: true,
    });

    await openDevicePairSetup(state);

    expect(state.devicePairSetupOpen).toBe(true);
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

    oldResponse.resolve(setupResult("OLD"));
    await oldRequest;
    expect(state.devicePairSetup).toBeNull();
    expect(state.devicePairSetupLoading).toBe(true);

    newResponse.resolve(setupResult("NEW"));
    await newRequest;
    expect(state.devicePairSetup?.setupCode).toBe("NEW");
    expect(state.devicePairSetupLoading).toBe(false);
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

    oldResponse.resolve(setupResult("OLD"));
    await oldRequest;
    expect(state.devicePairSetup).toBeNull();
    expect(state.devicePairSetupLoading).toBe(true);

    newResponse.resolve(setupResult("NEW"));
    await newRequest;
    expect(state.devicePairSetup?.setupCode).toBe("NEW");
  });

  it("clears setup credentials and loading state when the dialog closes", () => {
    const state = stateWithClient(null);
    state.devicePairSetupLoading = true;
    state.devicePairSetupError = "failed";
    state.devicePairSetup = setupResult("SECRET");

    closeDevicePairSetup(state);

    expect(state.devicePairSetupOpen).toBe(false);
    expect(state.devicePairSetupLoading).toBe(false);
    expect(state.devicePairSetupError).toBeNull();
    expect(state.devicePairSetup).toBeNull();
    expect(state.devicePairSetupAccess).toBe("full");
  });

  it("selects limited access before issuing a setup code", async () => {
    const request = vi.fn().mockResolvedValue(setupResult("LIMITED"));
    const client = {
      request,
    } as unknown as DevicePairSetupState["client"];
    const state = stateWithClient(client);

    await setDevicePairSetupAccess(state, "limited");

    expect(request).not.toHaveBeenCalled();
    await refreshDevicePairSetup(state);

    expect(request).toHaveBeenCalledWith("device.pair.setupCode", {
      bootstrapProfile: "limited",
    });
    expect(state.devicePairSetupAccess).toBe("limited");
    expect(state.devicePairSetup?.setupCode).toBe("LIMITED");
  });

  it("reflects a server-side plaintext downgrade", async () => {
    const request = vi.fn().mockResolvedValue(setupResult("LIMITED", "limited", true));
    const state = stateWithClient({
      request,
    } as unknown as DevicePairSetupState["client"]);

    await refreshDevicePairSetup(state);

    expect(state.devicePairSetupAccess).toBe("limited");
    expect(state.devicePairSetup?.accessDowngraded).toBe(true);
  });
});
