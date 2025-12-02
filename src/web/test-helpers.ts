import { vi } from "vitest";

import type { MockBaileysSocket } from "../../test/mocks/baileys.js";
import { createMockBaileys } from "../../test/mocks/baileys.js";

// Use globalThis to store the mock config so it survives vi.mock hoisting
const CONFIG_KEY = Symbol.for("warelay:testConfigMock");
const DEFAULT_CONFIG = {
  inbound: {
    allowFrom: ["*"], // Allow all in tests by default
    messagePrefix: undefined, // No message prefix in tests
    responsePrefix: undefined, // No response prefix in tests
    timestampPrefix: false, // No timestamp in tests
  },
};

// Initialize default if not set
if (!(globalThis as Record<symbol, unknown>)[CONFIG_KEY]) {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = () => DEFAULT_CONFIG;
}

export function setLoadConfigMock(fn: (() => unknown) | unknown) {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] =
    typeof fn === "function" ? fn : () => fn;
}

export function resetLoadConfigMock() {
  (globalThis as Record<symbol, unknown>)[CONFIG_KEY] = () => DEFAULT_CONFIG;
}

vi.mock("../config/config.js", () => ({
  loadConfig: () => {
    const getter = (globalThis as Record<symbol, unknown>)[CONFIG_KEY];
    if (typeof getter === "function") return getter();
    return DEFAULT_CONFIG;
  },
}));

vi.mock("../media/store.js", () => ({
  saveMediaBuffer: vi
    .fn()
    .mockImplementation(async (_buf: Buffer, contentType?: string) => ({
      id: "mid",
      path: "/tmp/mid",
      size: _buf.length,
      contentType,
    })),
}));

vi.mock("@whiskeysockets/baileys", () => {
  const created = createMockBaileys();
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("warelay:lastSocket")
  ] = created.lastSocket;
  return created.mod;
});

vi.mock("qrcode-terminal", () => ({
  default: { generate: vi.fn() },
  generate: vi.fn(),
}));

export const baileys = (await import(
  "@whiskeysockets/baileys"
)) as unknown as typeof import("@whiskeysockets/baileys") & {
  makeWASocket: ReturnType<typeof vi.fn>;
  useMultiFileAuthState: ReturnType<typeof vi.fn>;
  fetchLatestBaileysVersion: ReturnType<typeof vi.fn>;
  makeCacheableSignalKeyStore: ReturnType<typeof vi.fn>;
};

export function resetBaileysMocks() {
  const recreated = createMockBaileys();
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("warelay:lastSocket")
  ] = recreated.lastSocket;
  baileys.makeWASocket.mockImplementation(recreated.mod.makeWASocket);
  baileys.useMultiFileAuthState.mockImplementation(
    recreated.mod.useMultiFileAuthState,
  );
  baileys.fetchLatestBaileysVersion.mockImplementation(
    recreated.mod.fetchLatestBaileysVersion,
  );
  baileys.makeCacheableSignalKeyStore.mockImplementation(
    recreated.mod.makeCacheableSignalKeyStore,
  );
}

export function getLastSocket(): MockBaileysSocket {
  const getter = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("warelay:lastSocket")
  ];
  if (typeof getter === "function")
    return (getter as () => MockBaileysSocket)();
  if (!getter) throw new Error("Baileys mock not initialized");
  throw new Error("Invalid Baileys socket getter");
}
