import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProfile, type ResolvedBrowserConfig } from "../config.js";
import { getProfileLifecycle } from "../server-context.lifecycle.js";
import type { BrowserServerState } from "../server-context.types.js";
import type { ExtensionRelayHandle } from "./relay-server.js";

const readExtensionRelayTokenMock = vi.fn();
const ensureExtensionRelayTokenMock = vi.fn();
vi.mock("./relay-auth.js", () => ({
  readExtensionRelayToken: () => readExtensionRelayTokenMock(),
  ensureExtensionRelayToken: () => ensureExtensionRelayTokenMock(),
  resolveExtensionRelayToken: () => readExtensionRelayTokenMock(),
}));

const startExtensionRelayServerMock = vi.fn();
vi.mock("./relay-server.js", () => ({
  startExtensionRelayServer: (...args: unknown[]) => startExtensionRelayServerMock(...args),
}));

import { ensureExtensionRelayForProfile } from "./relay-lifecycle.js";

const OLD_TOKEN = "a".repeat(64);
const ROTATED_TOKEN = "b".repeat(64);

const PROFILE_NAME = "chrome";
const RELAY_PORT = 18_123;

function createState(token: string, existing?: ExtensionRelayHandle) {
  const resolved = {
    extensionRelayToken: token,
    extensionRelayDefaultPort: 18_799,
    extensionRelayPorts: { [PROFILE_NAME]: RELAY_PORT },
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
    readExtensionRelayTokenMock.mockReturnValue(ROTATED_TOKEN);
    ensureExtensionRelayTokenMock.mockReturnValue(ROTATED_TOKEN);
    startExtensionRelayServerMock.mockImplementation(async ({ port, token }) => ({
      port,
      token,
      bridge: {},
      close: vi.fn(async () => {}),
    }));
  });

  it("rebounds an existing relay when the host-local token rotates", async () => {
    const oldRelay = createHandle(OLD_TOKEN);
    const { profile, state } = createState(OLD_TOKEN, oldRelay);
    expect(profile.cdpUrl).toContain(OLD_TOKEN);

    const handle = await ensureExtensionRelayForProfile(state, profile);

    expect(oldRelay.close).toHaveBeenCalledOnce();
    expect(startExtensionRelayServerMock).toHaveBeenCalledWith({
      port: RELAY_PORT,
      token: ROTATED_TOKEN,
    });
    expect(handle.token).toBe(ROTATED_TOKEN);
    expect(state.resolved.extensionRelayToken).toBe(ROTATED_TOKEN);
    expect(profile.cdpUrl).toContain(ROTATED_TOKEN);
    expect(resolveProfile(state.resolved, PROFILE_NAME)?.cdpUrl).toContain(ROTATED_TOKEN);
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
});
