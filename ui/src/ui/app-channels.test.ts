import { afterEach, describe, expect, it, vi } from "vitest";
import { handleChannelConfigReload, handleChannelConfigSave } from "./app-channels.ts";
import type { ChannelsState } from "./controllers/channels.ts";
import type { ConfigState } from "./controllers/config.ts";
import type { ChannelsStatusSnapshot } from "./types.ts";

type ChannelsActionHostForTest = ConfigState &
  ChannelsState & {
    hello?: { auth?: { deviceToken?: string | null } | null } | null;
    password?: string;
    settings: { token?: string };
    nostrProfileFormState: null;
    nostrProfileAccountId: string | null;
  };

function createChannelsSnapshot(name = "saved"): ChannelsStatusSnapshot {
  const nostrAccount = { accountId: "default", configured: true, profile: { name } } as
    ChannelsStatusSnapshot["channelAccounts"][string][number];
  return {
    ts: Date.now(),
    channelOrder: ["nostr"],
    channelLabels: { nostr: "Nostr" },
    channels: { nostr: { configured: true } },
    channelAccounts: {
      nostr: [nostrAccount],
    },
    channelDefaultAccountId: { nostr: "default" },
  };
}

function createHost(request: ReturnType<typeof vi.fn> = vi.fn()): ChannelsActionHostForTest {
  return {
    applySessionKey: "main",
    channelsError: null,
    channelsLastSuccess: null,
    channelsLoading: false,
    channelsSnapshot: createChannelsSnapshot("old"),
    client: { request } as unknown as ConfigState["client"],
    configActiveSection: null,
    configActiveSubsection: null,
    configApplying: false,
    configForm: null,
    configFormDirty: false,
    configFormMode: "form",
    configFormOriginal: null,
    configIssues: [],
    configLoading: false,
    configRaw: "",
    configRawOriginal: "",
    configSaving: false,
    configSchema: null,
    configSchemaLoading: false,
    configSchemaVersion: null,
    configSearchQuery: "",
    configSnapshot: null,
    configUiHints: {},
    configValid: null,
    connected: true,
    lastError: null,
    nostrProfileAccountId: null,
    nostrProfileFormState: null,
    pendingUpdateExpectedVersion: null,
    settings: {},
    updateStatusBanner: null,
    updateRunning: false,
    whatsappBusy: false,
    whatsappLoginConnected: null,
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("channel config actions", () => {
  it("discards stale dirty config state on explicit reload", async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return {
          config: { gateway: { mode: "remote" } },
          valid: true,
          issues: [],
          raw: '{\n  "gateway": { "mode": "remote" }\n}\n',
        };
      }
      if (method === "channels.status") {
        return createChannelsSnapshot();
      }
      return {};
    });
    const host = createHost(request);
    host.configFormDirty = true;
    host.configForm = { gateway: { mode: "local" } };

    await handleChannelConfigReload(host);

    expect(host.configFormDirty).toBe(false);
    expect(host.configForm).toEqual({ gateway: { mode: "remote" } });
    expect(host.configFormOriginal).toEqual({ gateway: { mode: "remote" } });
    expect(request).toHaveBeenCalledWith("channels.status", { probe: true, timeoutMs: 8000 });
  });

  it("keeps failed channel saves from discarding pending edits during recovery reload", async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "config.set") {
        throw new Error("Config hash mismatch");
      }
      if (method === "config.get") {
        return {
          config: { gateway: { mode: "remote" } },
          valid: true,
          issues: [],
          raw: '{\n  "gateway": { "mode": "remote" }\n}\n',
        };
      }
      if (method === "channels.status") {
        return createChannelsSnapshot();
      }
      return {};
    });
    const host = createHost(request);
    host.configSnapshot = { hash: "old-hash" };
    host.configFormDirty = true;
    host.configForm = { gateway: { mode: "local" } };

    await handleChannelConfigSave(host);

    expect(host.lastError).toContain("Config hash mismatch");
    expect(host.configFormDirty).toBe(true);
    expect(host.configForm).toEqual({ gateway: { mode: "local" } });
    expect(host.configSnapshot?.config).toEqual({ gateway: { mode: "remote" } });
    expect(request.mock.calls.some(([method]) => method === "channels.status")).toBe(false);
  });
});
