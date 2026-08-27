import { beforeEach, describe, expect, it, vi } from "vitest";
import { relayTestKey } from "../../../chrome-extension/relay-key.test-support.js";
import { resolveProfile, type ResolvedBrowserConfig } from "../config.js";
import { refreshResolvedBrowserConfigFromDisk } from "../resolved-config-refresh.js";
import {
  beginProfileTransition,
  getOrCreateProfileRuntime,
  getProfileLifecycle,
  withProfileOperationLease,
} from "../server-context.lifecycle.js";
import type { BrowserServerState } from "../server-context.types.js";
import type { ExtensionRelayHandle } from "./relay-server.js";

const ensureExtensionRelayTokenMock = vi.fn();
vi.mock("./relay-auth.js", () => ({
  ensureExtensionRelayToken: () => ensureExtensionRelayTokenMock(),
}));

vi.mock("../config-refresh-source.js", () => ({
  loadBrowserConfigForRuntimeRefresh: () => ({
    browser: { profiles: { chrome: { driver: "extension", cdpPort: RELAY_PORT } } },
  }),
}));

const startExtensionRelayServerMock = vi.fn();
vi.mock("./relay-server.js", () => ({
  startExtensionRelayServer: (...args: unknown[]) => startExtensionRelayServerMock(...args),
}));

import { ensureExtensionRelayForProfile } from "./relay-lifecycle.js";

const OLD_TOKEN = relayTestKey(1);
const ROTATED_TOKEN = relayTestKey(2);

const PROFILE_NAME = "chrome";
const RELAY_PORT = 18_123;

function createState(token: string, existing?: ExtensionRelayHandle) {
  const resolved = {
    extensionRelayToken: token,
    extensionRelayDefaultPort: 18_799,
    extensionRelayPorts: { [PROFILE_NAME]: RELAY_PORT },
    extensionRelay: { allowLegacyAuth: true },
    extensionRelayInternalTokens: existing ? { [PROFILE_NAME]: existing.internalToken } : {},
    profiles: {
      [PROFILE_NAME]: {
        cdpPort: RELAY_PORT,
        color: "#FF4500",
        driver: "extension",
      },
    },
  } as unknown as ResolvedBrowserConfig;
  const state: BrowserServerState = {
    server: null,
    port: 0,
    resolved,
    profiles: new Map(),
    ...(existing ? { extensionRelays: new Map([[PROFILE_NAME, existing]]) } : {}),
  };
  const profile = resolveProfile(resolved, PROFILE_NAME);
  if (!profile) {
    throw new Error("expected extension profile");
  }
  return { profile, state };
}

function createHandle(token: string, port = RELAY_PORT): ExtensionRelayHandle {
  return {
    port,
    token,
    allowLegacyAuth: true,
    internalToken: `${token.slice(0, 8)}-internal`,
    bridge: {} as ExtensionRelayHandle["bridge"],
    close: vi.fn(async () => {}),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("extension relay lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureExtensionRelayTokenMock.mockResolvedValue(ROTATED_TOKEN);
    startExtensionRelayServerMock.mockImplementation(async ({ port, token, allowLegacyAuth }) => ({
      port,
      token,
      allowLegacyAuth,
      internalToken: "replacement-internal",
      bridge: {},
      close: vi.fn(async () => {}),
    }));
  });

  it("rebounds an existing relay when the host-local token rotates", async () => {
    const oldRelay = createHandle(OLD_TOKEN);
    const { profile, state } = createState(OLD_TOKEN, oldRelay);
    expect(profile.cdpUrl).toContain(encodeURIComponent(oldRelay.internalToken));
    expect(profile.cdpUrl).not.toContain(OLD_TOKEN);

    const handle = await ensureExtensionRelayForProfile(state, profile);

    expect(oldRelay.close).toHaveBeenCalledOnce();
    expect(startExtensionRelayServerMock).toHaveBeenCalledWith({
      port: RELAY_PORT,
      token: ROTATED_TOKEN,
      allowLegacyAuth: true,
    });
    expect(handle.token).toBe(ROTATED_TOKEN);
    expect(state.resolved.extensionRelayToken).toBe(ROTATED_TOKEN);
    expect(profile.cdpUrl).toContain("replacement-internal");
    expect(profile.cdpUrl).not.toContain(ROTATED_TOKEN);
    expect(resolveProfile(state.resolved, PROFILE_NAME)?.cdpUrl).toContain("replacement-internal");
    expect(state.extensionRelays?.get(PROFILE_NAME)).toBe(handle);
  });

  it("retains and retries the exact stale relay when its first close fails", async () => {
    const oldRelay = createHandle(OLD_TOKEN);
    vi.mocked(oldRelay.close)
      .mockRejectedValueOnce(new Error("relay still listening"))
      .mockResolvedValue(undefined);
    const { profile, state } = createState(OLD_TOKEN, oldRelay);

    await expect(ensureExtensionRelayForProfile(state, profile)).rejects.toThrow(
      "relay still listening",
    );

    const runtime = state.profiles.get(profile.name);
    expect(runtime && getProfileLifecycle(runtime).blockedReason).toBeNull();
    expect(startExtensionRelayServerMock).not.toHaveBeenCalled();
    expect(state.extensionRelays?.get(profile.name)).toBe(oldRelay);

    await expect(ensureExtensionRelayForProfile(state, profile)).resolves.toEqual(
      expect.objectContaining({ token: ROTATED_TOKEN }),
    );
    expect(oldRelay.close).toHaveBeenCalledTimes(2);
    expect(startExtensionRelayServerMock).toHaveBeenCalledOnce();
  });

  it("retains the adopted key when config refreshes during relay startup", async () => {
    const { profile, state } = createState(OLD_TOKEN);
    const replacement = createHandle(ROTATED_TOKEN);
    startExtensionRelayServerMock.mockImplementationOnce(async () => {
      refreshResolvedBrowserConfigFromDisk({ current: state, refreshConfigFromDisk: true });
      return replacement;
    });

    await expect(ensureExtensionRelayForProfile(state, profile)).resolves.toBe(replacement);
    expect(state.resolved.extensionRelayToken).toBe(ROTATED_TOKEN);
    expect(state.extensionRelays?.get(PROFILE_NAME)).toBe(replacement);
    expect(replacement.close).not.toHaveBeenCalled();
  });

  it("coalesces concurrent rebinds to one exact relay handle", async () => {
    const oldRelay = createHandle(OLD_TOKEN);
    const { profile, state } = createState(OLD_TOKEN, oldRelay);
    const startEntered = deferred();
    const releaseStart = deferred();
    const replacement = createHandle(ROTATED_TOKEN);
    startExtensionRelayServerMock.mockImplementationOnce(async () => {
      startEntered.resolve();
      await releaseStart.promise;
      return replacement;
    });

    const first = ensureExtensionRelayForProfile(state, profile);
    await startEntered.promise;
    const second = ensureExtensionRelayForProfile(state, profile);
    releaseStart.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([replacement, replacement]);
    expect(oldRelay.close).toHaveBeenCalledOnce();
    expect(startExtensionRelayServerMock).toHaveBeenCalledOnce();
    expect(state.extensionRelays?.get(PROFILE_NAME)).toBe(replacement);
  });

  it("keeps a shared HMAC-rotation rebind alive when its first caller is cancelled", async () => {
    const oldRelay = createHandle(OLD_TOKEN);
    const { profile, state } = createState(OLD_TOKEN, oldRelay);
    const runtime = getOrCreateProfileRuntime(state, profile);
    const startEntered = deferred();
    const releaseStart = deferred();
    const replacement = createHandle(ROTATED_TOKEN);
    startExtensionRelayServerMock.mockImplementationOnce(async () => {
      startEntered.resolve();
      await releaseStart.promise;
      return replacement;
    });
    const firstController = new AbortController();
    const first = withProfileOperationLease({
      state,
      runtime,
      configRevision: getProfileLifecycle(runtime).configRevision,
      signal: firstController.signal,
      run: async (signal) => await ensureExtensionRelayForProfile(state, profile, signal),
    });
    void first.catch(() => {});
    await startEntered.promise;

    const sibling = withProfileOperationLease({
      state,
      runtime,
      configRevision: getProfileLifecycle(runtime).configRevision,
      run: async (signal) => await ensureExtensionRelayForProfile(state, profile, signal),
    });
    void sibling.catch(() => {});
    await expect.poll(() => ensureExtensionRelayTokenMock.mock.calls.length).toBe(2);
    firstController.abort(new Error("first browser request cancelled"));
    releaseStart.resolve();

    await expect(first).rejects.toThrow("first browser request cancelled");
    await expect(sibling).resolves.toBe(replacement);
    expect(oldRelay.close).toHaveBeenCalledOnce();
    expect(startExtensionRelayServerMock).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(state.extensionRelays?.get(PROFILE_NAME)).toBe(replacement);
    expect(state.resolved.extensionRelayInternalTokens[PROFILE_NAME]).toBe(
      replacement.internalToken,
    );
    expect(getProfileLifecycle(runtime).leases.size).toBe(0);
  });

  it("releases a cancelled sibling without waiting for another caller's pending rebind", async () => {
    const oldRelay = createHandle(OLD_TOKEN);
    const { profile, state } = createState(OLD_TOKEN, oldRelay);
    const runtime = getOrCreateProfileRuntime(state, profile);
    const startEntered = deferred();
    const releaseStart = deferred();
    const replacement = createHandle(ROTATED_TOKEN);
    startExtensionRelayServerMock.mockImplementationOnce(async () => {
      startEntered.resolve();
      await releaseStart.promise;
      return replacement;
    });
    const owner = withProfileOperationLease({
      state,
      runtime,
      configRevision: getProfileLifecycle(runtime).configRevision,
      run: async (signal) => await ensureExtensionRelayForProfile(state, profile, signal),
    });
    void owner.catch(() => {});
    await startEntered.promise;

    const siblingController = new AbortController();
    const sibling = withProfileOperationLease({
      state,
      runtime,
      configRevision: getProfileLifecycle(runtime).configRevision,
      signal: siblingController.signal,
      run: async (signal) => await ensureExtensionRelayForProfile(state, profile, signal),
    });
    let siblingError: unknown;
    void sibling.catch((error: unknown) => {
      siblingError = error;
    });
    await expect.poll(() => ensureExtensionRelayTokenMock.mock.calls.length).toBe(2);
    siblingController.abort(new Error("sibling browser request cancelled"));
    try {
      await expect
        .poll(() => siblingError, { timeout: 200 })
        .toEqual(expect.objectContaining({ message: "sibling browser request cancelled" }));
    } finally {
      releaseStart.resolve();
    }
    await expect(owner).resolves.toBe(replacement);
    expect(oldRelay.close).toHaveBeenCalledOnce();
    expect(startExtensionRelayServerMock).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(getProfileLifecycle(runtime).leases.size).toBe(0);
  });

  it("fences and drains a lifecycle-owned rebind when its profile transitions", async () => {
    const oldRelay = createHandle(OLD_TOKEN);
    const { profile, state } = createState(OLD_TOKEN, oldRelay);
    const runtime = getOrCreateProfileRuntime(state, profile);
    const startEntered = deferred();
    const releaseStart = deferred();
    const replacement = createHandle(ROTATED_TOKEN);
    startExtensionRelayServerMock.mockImplementationOnce(async () => {
      startEntered.resolve();
      await releaseStart.promise;
      return replacement;
    });
    const pending = withProfileOperationLease({
      state,
      runtime,
      configRevision: getProfileLifecycle(runtime).configRevision,
      run: async (signal) => await ensureExtensionRelayForProfile(state, profile, signal),
    });
    void pending.catch(() => {});
    await startEntered.promise;

    const transition = beginProfileTransition({
      state,
      runtime,
      reason: "profile configuration changed",
      closeRelay: true,
    });
    await expect(pending).rejects.toThrow("profile configuration changed");
    releaseStart.resolve();
    await expect(transition).resolves.toEqual(expect.objectContaining({ stopped: true }));

    expect(oldRelay.close).toHaveBeenCalledOnce();
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(state.extensionRelays?.has(PROFILE_NAME)).toBe(false);
    expect(state.resolved.extensionRelayInternalTokens[PROFILE_NAME]).toBeUndefined();
    expect(getProfileLifecycle(runtime).leases.size).toBe(0);
  });
});
