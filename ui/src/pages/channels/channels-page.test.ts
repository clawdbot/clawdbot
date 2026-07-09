import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { NostrProfile } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createChannelCapability } from "../../lib/channels/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/index.ts";
import "./channels-page.ts";

type ChannelsPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
  requestUpdate: () => void;
};

type NostrTestPage = ChannelsPageTestElement & {
  nostrProfileFormState: {
    values: NostrProfile;
    saving: boolean;
    importing: boolean;
  } | null;
  nostrProfileAccountId: string | null;
  editNostrProfile: (accountId: string, profile: NostrProfile | null) => void;
  saveNostrProfile: () => Promise<void>;
  importNostrProfile: () => Promise<void>;
};

type TestGateway = ApplicationContext["gateway"] & {
  emit: (patch: Partial<ApplicationGatewaySnapshot>) => void;
};

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected deferred callback to be initialized");
  }
  return { promise, resolve };
}

function createGateway(): TestGateway {
  const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    connected: true,
    reconnecting: false,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  return {
    snapshot,
    connection: { gatewayUrl: "", token: "", password: "" },
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(patch: Partial<ApplicationGatewaySnapshot>) {
      Object.assign(snapshot, patch);
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  } as unknown as TestGateway;
}

function createContext(gateway: ApplicationContext["gateway"]) {
  const channels = createChannelCapability(gateway);
  channels.state.channelsSnapshot = {
    ts: 0,
    channelOrder: [],
    channelLabels: {},
    channels: {},
    channelAccounts: {},
    channelDefaultAccountId: {},
  };
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  runtimeConfig.state.configSnapshot = { config: {}, hash: "test" };
  const ensureSchemaLoaded = vi.spyOn(runtimeConfig, "ensureSchemaLoaded").mockResolvedValue();
  const context = {
    basePath: "",
    gateway,
    channels,
    runtimeConfig,
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
  return { context, ensureSchemaLoaded, runtimeConfig, channels };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChannelsPage lifecycle", () => {
  it("loads schema again when the runtime-config source changes", async () => {
    const gateway = createGateway();
    const first = createContext(gateway);
    const second = createContext(gateway);
    const page = document.createElement("openclaw-channels-page") as ChannelsPageTestElement;
    page.context = first.context;
    document.body.append(page);

    await vi.waitFor(() => expect(first.ensureSchemaLoaded).toHaveBeenCalledOnce());

    page.context = second.context;
    page.requestUpdate();
    await page.updateComplete;

    await vi.waitFor(() => expect(second.ensureSchemaLoaded).toHaveBeenCalledOnce());

    first.runtimeConfig.dispose();
    second.runtimeConfig.dispose();
    first.channels.dispose();
    second.channels.dispose();
  });

  it("drops a profile save when the channel source is replaced", async () => {
    const gateway = createGateway();
    const first = createContext(gateway);
    const second = createContext(gateway);
    const firstRefresh = vi.spyOn(first.channels, "refresh").mockResolvedValue();
    const secondRefresh = vi.spyOn(second.channels, "refresh").mockResolvedValue();
    const response = createDeferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-channels-page") as NostrTestPage;
    page.context = first.context;
    document.body.append(page);
    await page.updateComplete;
    page.editNostrProfile("old-account", { name: "old" });

    const save = page.saveNostrProfile();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    page.context = second.context;
    page.requestUpdate();
    await page.updateComplete;
    expect(page.nostrProfileFormState).toBeNull();

    response.resolve(
      new Response(JSON.stringify({ ok: true, persisted: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await save;

    expect(page.nostrProfileFormState).toBeNull();
    expect(firstRefresh).not.toHaveBeenCalled();
    expect(secondRefresh).not.toHaveBeenCalled();
    first.runtimeConfig.dispose();
    second.runtimeConfig.dispose();
    first.channels.dispose();
    second.channels.dispose();
  });

  it("drops a profile import when the gateway disconnects", async () => {
    const gateway = createGateway();
    const source = createContext(gateway);
    const refresh = vi.spyOn(source.channels, "refresh").mockResolvedValue();
    const response = createDeferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-channels-page") as NostrTestPage;
    page.context = source.context;
    document.body.append(page);
    await page.updateComplete;
    page.editNostrProfile("old-account", { name: "old" });

    const load = page.importNostrProfile();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    gateway.emit({ connected: false });
    expect(page.nostrProfileFormState).toBeNull();

    response.resolve(
      new Response(JSON.stringify({ ok: true, saved: true, merged: { name: "stale import" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await load;

    expect(page.nostrProfileFormState).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    source.runtimeConfig.dispose();
    source.channels.dispose();
  });

  it("does not overwrite a replacement profile form", async () => {
    const gateway = createGateway();
    const source = createContext(gateway);
    const refresh = vi.spyOn(source.channels, "refresh").mockResolvedValue();
    const response = createDeferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    const page = document.createElement("openclaw-channels-page") as NostrTestPage;
    page.context = source.context;
    document.body.append(page);
    await page.updateComplete;
    page.editNostrProfile("old-account", { name: "old" });

    const load = page.importNostrProfile();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    page.editNostrProfile("new-account", { name: "fresh" });
    response.resolve(
      new Response(JSON.stringify({ ok: true, saved: true, merged: { name: "stale import" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await load;

    expect(page.nostrProfileAccountId).toBe("new-account");
    expect(page.nostrProfileFormState?.values.name).toBe("fresh");
    expect(refresh).not.toHaveBeenCalled();
    source.runtimeConfig.dispose();
    source.channels.dispose();
  });
});
