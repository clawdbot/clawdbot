import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "../config.js";
import type { BrowserServerState } from "../server-context.types.js";
import type { ExtensionRelayHandle } from "./relay-server.js";

const readExtensionRelayTokenMock = vi.fn();
const ensureExtensionRelayTokenMock = vi.fn();
vi.mock("./relay-auth.js", () => ({
  readExtensionRelayToken: () => readExtensionRelayTokenMock(),
  ensureExtensionRelayToken: () => ensureExtensionRelayTokenMock(),
}));

const startExtensionRelayServerMock = vi.fn();
vi.mock("./relay-server.js", () => ({
  startExtensionRelayServer: (...args: unknown[]) => startExtensionRelayServerMock(...args),
}));

import { ensureExtensionRelayForProfile } from "./relay-lifecycle.js";

const OLD_TOKEN = "a".repeat(64);
const ROTATED_TOKEN = "b".repeat(64);

function createState(existing?: ExtensionRelayHandle): BrowserServerState {
  return {
    port: 0,
    resolved: {
      extensionRelayToken: OLD_TOKEN,
      profiles: {},
    } as ResolvedBrowserConfig,
    profiles: new Map(),
    ...(existing ? { extensionRelays: new Map([["chrome", existing]]) } : {}),
  };
}

const profile = {
  name: "chrome",
  cdpPort: 18123,
  driver: "extension",
} as ResolvedBrowserProfile;

function createHandle(token: string): ExtensionRelayHandle {
  return {
    port: profile.cdpPort,
    token,
    bridge: {} as ExtensionRelayHandle["bridge"],
    close: vi.fn(async () => {}),
  };
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
    const state = createState(oldRelay);

    const handle = await ensureExtensionRelayForProfile(state, profile);

    expect(oldRelay.close).toHaveBeenCalledOnce();
    expect(startExtensionRelayServerMock).toHaveBeenCalledWith({
      port: profile.cdpPort,
      token: ROTATED_TOKEN,
    });
    expect(handle.token).toBe(ROTATED_TOKEN);
    expect(state.resolved.extensionRelayToken).toBe(ROTATED_TOKEN);
    expect(state.extensionRelays?.get("chrome")).toBe(handle);
  });
});
