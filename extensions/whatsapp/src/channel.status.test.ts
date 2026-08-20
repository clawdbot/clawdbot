import type { PluginRuntime } from "openclaw/plugin-sdk/core";
// Whatsapp tests cover runtime-aware linked status projection.
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  monitorWebChannel: vi.fn(),
  readWebAuthSnapshot: vi.fn(),
  readWebAuthState: vi.fn(),
  readWebSelfId: vi.fn(),
}));

vi.mock("./channel-runtime-loader.js", () => ({
  isWhatsAppAuthConfigured: vi.fn(async () => true),
  loadWhatsAppChannelRuntime: vi.fn(async () => runtimeMocks),
}));

import { whatsappPlugin } from "./channel.js";
import { setWhatsAppRuntime } from "./runtime.js";

const account = {
  accountId: "default",
  authDir: "/tmp/whatsapp-auth",
  enabled: true,
  name: "Default",
};

describe("WhatsApp channel status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setWhatsAppRuntime({
      channel: {},
      logging: { shouldLogVerbose: () => false },
    } as unknown as PluginRuntime);
    runtimeMocks.readWebAuthSnapshot.mockResolvedValue({
      state: "linked",
      authAgeMs: 10_000,
      selfId: { e164: "+15555550100", jid: "15555550100@s.whatsapp.net", lid: null },
    });
    runtimeMocks.readWebAuthState.mockResolvedValue("linked");
    runtimeMocks.readWebSelfId.mockReturnValue({ e164: "+15555550100", jid: null, lid: null });
    runtimeMocks.monitorWebChannel.mockResolvedValue(undefined);
  });

  it("does not project cached revoked auth as linked", async () => {
    const snapshot = {
      accountId: "default",
      running: false,
      connected: false,
      healthState: "logged-out",
      lifecycle: "blocked" as const,
      lastError: "status=401",
    };

    const summary = await whatsappPlugin.status?.buildChannelSummary?.({
      account: account as never,
      cfg: {} as never,
      defaultAccountId: "default",
      snapshot,
    });
    const accountSnapshot = await whatsappPlugin.status?.buildAccountSnapshot?.({
      account: account as never,
      cfg: {} as never,
      runtime: snapshot,
    });

    expect(summary).toMatchObject({
      configured: true,
      statusState: "not-linked",
      linked: false,
      authAgeMs: null,
      self: { e164: null, jid: null, lid: null },
      healthState: "logged-out",
      lifecycle: "blocked",
    });
    expect(accountSnapshot).toMatchObject({
      configured: true,
      statusState: "not-linked",
      linked: false,
      healthState: "logged-out",
      lifecycle: "blocked",
    });
  });
});
