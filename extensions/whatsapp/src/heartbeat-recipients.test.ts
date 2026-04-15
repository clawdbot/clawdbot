import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWhatsAppHeartbeatRecipients } from "./heartbeat-recipients.js";
import type { OpenClawConfig } from "./runtime-api.js";

const loadSessionStoreMock = vi.hoisted(() => vi.fn());
const readChannelAllowFromStoreSyncMock = vi.hoisted(() => vi.fn<() => string[]>(() => []));

vi.mock("./heartbeat-recipients.runtime.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  loadSessionStore: loadSessionStoreMock,
  readChannelAllowFromStoreSync: readChannelAllowFromStoreSyncMock,
  resolveStorePath: vi.fn(() => "/tmp/test-sessions.json"),
  normalizeChannelId: (value?: string | null) => {
    const trimmed = value?.trim().toLowerCase();
    return trimmed ? (trimmed as "whatsapp") : null;
  },
  normalizeE164: (value?: string | null) => {
    const digits = (value ?? "").replace(/[^\d+]/g, "");
    if (!digits) {
      return "";
    }
    return digits.startsWith("+") ? digits : `+${digits}`;
  },
}));

function makeCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    bindings: [],
    channels: {},
    ...overrides,
  } as OpenClawConfig;
}

describe("resolveWhatsAppHeartbeatRecipients", () => {
  function setSessionStore(store: Record<string, unknown>) {
    loadSessionStoreMock.mockReturnValue(store);
  }

  function setAllowFromStore(entries: string[]) {
    readChannelAllowFromStoreSyncMock.mockReturnValue(entries);
  }

  function resolveWith(
    cfgOverrides: Partial<OpenClawConfig> = {},
    opts?: Parameters<typeof resolveWhatsAppHeartbeatRecipients>[1],
  ) {
    return resolveWhatsAppHeartbeatRecipients(makeCfg(cfgOverrides), opts);
  }

  function setSingleUnauthorizedSessionWithAllowFrom() {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000099", updatedAt: 2, sessionId: "a" },
    });
    setAllowFromStore(["+15550000001"]);
  }

  beforeEach(() => {
    loadSessionStoreMock.mockReset();
    readChannelAllowFromStoreSyncMock.mockReset();
    loadSessionStoreMock.mockReturnValue({});
    setAllowFromStore([]);
  });

  it("uses allowFrom store recipients when session recipients are ambiguous", () => {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000001", updatedAt: 2, sessionId: "a" },
      b: { lastChannel: "whatsapp", lastTo: "+15550000002", updatedAt: 1, sessionId: "b" },
    });
    setAllowFromStore(["+15550000001"]);

    const result = resolveWith();

    expect(result).toEqual({ recipients: ["+15550000001"], source: "session-single" });
  });

  it("falls back to allowFrom when no session recipient is authorized", () => {
    setSingleUnauthorizedSessionWithAllowFrom();

    const result = resolveWith();

    expect(result).toEqual({ recipients: ["+15550000001"], source: "allowFrom" });
  });

  it("includes both session and allowFrom recipients when --all is set", () => {
    setSingleUnauthorizedSessionWithAllowFrom();

    const result = resolveWith({}, { all: true });

    expect(result).toEqual({
      recipients: ["+15550000099", "+15550000001"],
      source: "all",
    });
  });

  it("returns explicit --to recipient and source flag", () => {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000099", updatedAt: 2, sessionId: "a" },
    });
    const result = resolveWith({}, { to: " +1 555 000 7777 " });
    expect(result).toEqual({ recipients: ["+15550007777"], source: "flag" });
  });

  it("returns ambiguous session recipients when no allowFrom list exists", () => {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000001", updatedAt: 2, sessionId: "a" },
      b: { lastChannel: "whatsapp", lastTo: "+15550000002", updatedAt: 1, sessionId: "b" },
    });
    const result = resolveWith();
    expect(result).toEqual({
      recipients: ["+15550000001", "+15550000002"],
      source: "session-ambiguous",
    });
  });

  it("returns single session recipient when allowFrom is empty", () => {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000001", updatedAt: 2, sessionId: "a" },
    });
    const result = resolveWith();
    expect(result).toEqual({ recipients: ["+15550000001"], source: "session-single" });
  });

  it("returns all authorized session recipients when allowFrom matches multiple", () => {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000001", updatedAt: 2, sessionId: "a" },
      b: { lastChannel: "whatsapp", lastTo: "+15550000002", updatedAt: 1, sessionId: "b" },
      c: { lastChannel: "whatsapp", lastTo: "+15550000003", updatedAt: 0, sessionId: "c" },
    });
    setAllowFromStore(["+15550000001", "+15550000002"]);
    const result = resolveWith();
    expect(result).toEqual({
      recipients: ["+15550000001", "+15550000002"],
      source: "session-ambiguous",
    });
  });

  it("ignores session store when session scope is global", () => {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000001", updatedAt: 2, sessionId: "a" },
    });
    const result = resolveWith({
      session: { scope: "global" } as OpenClawConfig["session"],
      channels: { whatsapp: { allowFrom: ["*", "+15550000009"] } as never },
    });
    expect(result).toEqual({ recipients: ["+15550000009"], source: "allowFrom" });
  });

  it("uses the requested account allowFrom config and pairing store", () => {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000077", updatedAt: 2, sessionId: "a" },
    });
    setAllowFromStore(["+15550000002"]);

    const result = resolveWith(
      {
        channels: {
          whatsapp: {
            allowFrom: ["+15550000001"],
            accounts: {
              work: {
                allowFrom: ["+15550000003"],
              },
            },
          } as never,
        },
      },
      { accountId: "work" },
    );

    expect(readChannelAllowFromStoreSyncMock).toHaveBeenCalledWith("whatsapp", process.env, "work");
    expect(result).toEqual({
      recipients: ["+15550000003", "+15550000002"],
      source: "allowFrom",
    });
  });

  it("uses configured defaultAccount allowFrom config and pairing store when accountId is omitted", () => {
    setSessionStore({
      a: { lastChannel: "whatsapp", lastTo: "+15550000077", updatedAt: 2, sessionId: "a" },
    });
    setAllowFromStore(["+15550000002"]);

    const result = resolveWith({
      channels: {
        whatsapp: {
          defaultAccount: "work",
          allowFrom: ["+15550000001"],
          accounts: {
            work: {
              allowFrom: ["+15550000003"],
            },
          },
        } as never,
      },
    });

    expect(readChannelAllowFromStoreSyncMock).toHaveBeenCalledWith("whatsapp", process.env, "work");
    expect(result).toEqual({
      recipients: ["+15550000003", "+15550000002"],
      source: "allowFrom",
    });
  });
});
