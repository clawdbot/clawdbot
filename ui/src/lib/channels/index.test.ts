// Channels domain tests.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelsPairingListResult, ChannelsStatusSnapshot } from "../../api/types.ts";
import { createChannelCapability } from "./index.ts";

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

function createChannelsSnapshot(label: string): ChannelsStatusSnapshot {
  return {
    ts: Date.now(),
    channelOrder: ["test"],
    channelLabels: { test: label },
    channels: {},
    channelAccounts: {},
    channelDefaultAccountId: {},
  };
}

describe("channels controller WhatsApp wait", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a stale login result after reconnecting with the same client", async () => {
    const staleWait = createDeferred<{
      message: string;
      connected: boolean;
      qrDataUrl: string;
    }>();
    const freshWait = createDeferred<{
      message: string;
      connected: boolean;
      qrDataUrl: string;
    }>();
    let waitCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "web.login.wait") {
        waitCount += 1;
        return waitCount === 1 ? staleWait.promise : freshWait.promise;
      }
      return Promise.resolve(createChannelsSnapshot("fresh"));
    });
    const client = { request };
    let snapshot = { client, connected: true };
    const listeners = new Set<(next: typeof snapshot) => void>();
    const gateway = {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const channels = createChannelCapability(gateway as never);

    const stale = channels.waitWhatsApp();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    snapshot = { client, connected: false };
    for (const listener of listeners) {
      listener(snapshot);
    }
    snapshot = { client, connected: true };
    for (const listener of listeners) {
      listener(snapshot);
    }

    const fresh = channels.waitWhatsApp();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    freshWait.resolve({
      message: "fresh login",
      connected: false,
      qrDataUrl: "data:image/png;base64,fresh-qr",
    });
    await fresh;

    staleWait.resolve({
      message: "stale login",
      connected: true,
      qrDataUrl: "data:image/png;base64,stale-qr",
    });
    await stale;

    expect(channels.state.whatsappLoginMessage).toBe("fresh login");
    expect(channels.state.whatsappLoginQrDataUrl).toBe("data:image/png;base64,fresh-qr");
    expect(request.mock.calls.filter(([method]) => method === "channels.status")).toHaveLength(1);
    channels.dispose();
  });

  it("keeps an active login wait across pairing-scope changes", async () => {
    const pending = createDeferred<{
      message: string;
      connected: boolean;
      qrDataUrl: string;
    }>();
    const request = vi.fn((method: string) =>
      method === "web.login.wait"
        ? pending.promise
        : Promise.resolve(createChannelsSnapshot("refreshed")),
    );
    const client = { request };
    let snapshot = {
      client,
      connected: true,
      hello: { auth: { role: "operator", scopes: ["operator.pairing"] } },
    };
    const listeners = new Set<(next: typeof snapshot) => void>();
    const channels = createChannelCapability({
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as never);

    const wait = channels.waitWhatsApp();
    await vi.waitFor(() => expect(channels.state.whatsappBusy).toBe(true));
    snapshot = {
      ...snapshot,
      hello: { auth: { role: "operator", scopes: ["operator.pairing", "operator.read"] } },
    };
    for (const listener of listeners) {
      listener(snapshot);
    }
    expect(channels.state.whatsappBusy).toBe(true);

    pending.resolve({
      message: "login survived scope change",
      connected: false,
      qrDataUrl: "data:image/png;base64,scope-change",
    });
    await wait;

    expect(channels.state.whatsappLoginMessage).toBe("login survived scope change");
    expect(channels.state.whatsappLoginQrDataUrl).toBe("data:image/png;base64,scope-change");
    channels.dispose();
  });

  it("rejects an active login result when admin access is revoked", async () => {
    const pending = createDeferred<{
      message: string;
      connected: boolean;
      qrDataUrl: string;
    }>();
    const request = vi.fn(() => pending.promise);
    const client = { request };
    let snapshot = {
      client,
      connected: true,
      hello: { auth: { role: "operator", scopes: ["operator.admin", "operator.pairing"] } },
    };
    const listeners = new Set<(next: typeof snapshot) => void>();
    const channels = createChannelCapability({
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as never);
    channels.state.whatsappLoginQrDataUrl = "data:image/png;base64,existing";

    const wait = channels.waitWhatsApp();
    await vi.waitFor(() => expect(channels.state.whatsappBusy).toBe(true));
    snapshot = {
      ...snapshot,
      hello: { auth: { role: "operator", scopes: ["operator.pairing"] } },
    };
    for (const listener of listeners) {
      listener(snapshot);
    }
    expect(channels.state.whatsappBusy).toBe(false);
    expect(channels.state.whatsappLoginQrDataUrl).toBeNull();

    pending.resolve({
      message: "stale login",
      connected: true,
      qrDataUrl: "data:image/png;base64,stale",
    });
    await wait;

    expect(channels.state.whatsappLoginMessage).toBeNull();
    expect(channels.state.whatsappLoginQrDataUrl).toBeNull();
    channels.dispose();
  });

  it("does not apply or refresh a login result after its capability is disposed", async () => {
    const pending = createDeferred<{
      message: string;
      connected: boolean;
      qrDataUrl: string;
    }>();
    const request = vi.fn(() => pending.promise);
    const client = { request };
    const gateway = {
      snapshot: { client, connected: true },
      subscribe: () => () => undefined,
    };
    const channels = createChannelCapability(gateway as never);

    const wait = channels.waitWhatsApp();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    channels.dispose();
    pending.resolve({
      message: "stale login",
      connected: true,
      qrDataUrl: "data:image/png;base64,stale-qr",
    });
    await wait;

    expect(channels.state.whatsappLoginMessage).toBeNull();
    expect(channels.state.whatsappLoginQrDataUrl).toBeNull();
    expect(request).toHaveBeenCalledOnce();

    await channels.waitWhatsApp();
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("channels controller WhatsApp logout", () => {
  it("preserves login state when no stored session was cleared", async () => {
    const request = vi.fn(async (method: string) =>
      method === "channels.logout"
        ? { cleared: false, loggedOut: false }
        : createChannelsSnapshot("refreshed"),
    );
    const channels = createChannelCapability({
      snapshot: { client: { request }, connected: true },
      subscribe: () => () => undefined,
    } as never);
    channels.state.whatsappLoginMessage = "Scan this QR.";
    channels.state.whatsappLoginQrDataUrl = "data:image/png;base64,current-qr";
    channels.state.whatsappLoginConnected = true;

    await channels.logoutWhatsApp("work");

    expect(request).toHaveBeenCalledWith("channels.logout", {
      channel: "whatsapp",
      accountId: "work",
    });
    expect(request.mock.calls.filter(([method]) => method === "channels.status")).toHaveLength(1);
    expect(channels.state.whatsappLoginMessage).toBe(
      "No stored WhatsApp session was cleared. It may already be absent, or its auth directory may require manual cleanup.",
    );
    expect(channels.state.whatsappLoginQrDataUrl).toBe("data:image/png;base64,current-qr");
    expect(channels.state.whatsappLoginConnected).toBe(true);
    expect(channels.state.whatsappBusy).toBe(false);
    channels.dispose();
  });

  it("clears login state only when the Gateway confirms session clearance", async () => {
    const request = vi.fn(async (method: string) =>
      method === "channels.logout"
        ? { cleared: true, loggedOut: true }
        : createChannelsSnapshot("refreshed"),
    );
    const channels = createChannelCapability({
      snapshot: { client: { request }, connected: true },
      subscribe: () => () => undefined,
    } as never);
    channels.state.whatsappLoginMessage = "Scan this QR.";
    channels.state.whatsappLoginQrDataUrl = "data:image/png;base64,current-qr";
    channels.state.whatsappLoginConnected = true;

    await channels.logoutWhatsApp();

    expect(channels.state.whatsappLoginMessage).toBe("Logged out.");
    expect(channels.state.whatsappLoginQrDataUrl).toBeNull();
    expect(channels.state.whatsappLoginConnected).toBeNull();
    expect(channels.state.whatsappBusy).toBe(false);
    channels.dispose();
  });

  it("reports a Gateway failure without discarding login state", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "channels.logout") {
        throw new Error("credential cleanup failed");
      }
      return createChannelsSnapshot("refreshed");
    });
    const channels = createChannelCapability({
      snapshot: { client: { request }, connected: true },
      subscribe: () => () => undefined,
    } as never);
    channels.state.whatsappLoginQrDataUrl = "data:image/png;base64,current-qr";
    channels.state.whatsappLoginConnected = true;

    await channels.logoutWhatsApp();

    expect(channels.state.whatsappLoginMessage).toBe("Error: credential cleanup failed");
    expect(channels.state.whatsappLoginQrDataUrl).toBe("data:image/png;base64,current-qr");
    expect(channels.state.whatsappLoginConnected).toBe(true);
    expect(request.mock.calls.filter(([method]) => method === "channels.status")).toHaveLength(1);
    channels.dispose();
  });
});

describe("channels controller DM pairing", () => {
  const emptyPairing: ChannelsPairingListResult = {
    accounts: [],
    requests: [],
    commandOwnerConfigured: true,
    limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
  };
  const pendingPairing: ChannelsPairingListResult = {
    ...emptyPairing,
    accounts: [
      {
        channel: "whatsapp",
        channelLabel: "WhatsApp",
        accountId: "personal",
        notifySupported: true,
      },
    ],
    requests: [
      {
        requestId: "request-1",
        channel: "whatsapp",
        channelLabel: "WhatsApp",
        accountId: "personal",
        senderId: "+1555",
        senderLabel: "Phone number",
        createdAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-07-20T10:00:00.000Z",
        expiresAt: "2026-07-20T11:00:00.000Z",
        notifySupported: true,
      },
    ],
  };

  it("loads pending requests and refreshes after approval", async () => {
    let listCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "channels.pairing.list") {
        listCount += 1;
        return listCount === 1 ? pendingPairing : emptyPairing;
      }
      if (method === "channels.pairing.approve") {
        return {
          requestId: "request-1",
          senderId: "+1555",
          notification: "sent",
          commandOwnerBootstrap: "not-requested",
        };
      }
      return {};
    });
    const channels = createChannelCapability({
      snapshot: { client: { request }, connected: true },
      subscribe: () => () => undefined,
    } as never);

    await channels.refreshPairing();
    expect(channels.state.pairingSnapshot?.requests).toHaveLength(1);

    const result = await channels.approvePairing({
      channel: "whatsapp",
      accountId: "personal",
      requestId: "request-1",
      notify: true,
      bootstrapCommandOwner: false,
    });

    expect(result?.notification).toBe("sent");
    expect(request).toHaveBeenCalledWith("channels.pairing.approve", {
      channel: "whatsapp",
      accountId: "personal",
      requestId: "request-1",
      notify: true,
      bootstrapCommandOwner: false,
    });
    expect(channels.state.pairingSnapshot?.requests).toEqual([]);
    expect(channels.state.pairingBusyRequestId).toBeNull();
    channels.dispose();
  });

  it("keeps the row resolved when refresh fails and blocks polling during mutation", async () => {
    const approvalResult = createDeferred<{
      requestId: string;
      senderId: string;
      notification: "not-requested";
      commandOwnerBootstrap: "not-requested";
    }>();
    let listCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "channels.pairing.list") {
        listCount += 1;
        if (listCount === 1) {
          return pendingPairing;
        }
        throw new Error("refresh unavailable");
      }
      return approvalResult.promise;
    });
    const channels = createChannelCapability({
      snapshot: { client: { request }, connected: true },
      subscribe: () => () => undefined,
    } as never);
    await channels.refreshPairing();

    const approval = channels.approvePairing({
      channel: "whatsapp",
      accountId: "personal",
      requestId: "request-1",
      notify: false,
      bootstrapCommandOwner: false,
    });
    await vi.waitFor(() => expect(channels.state.pairingBusyRequestId).toBe("request-1"));
    await channels.refreshPairing();
    expect(listCount).toBe(1);

    approvalResult.resolve({
      requestId: "request-1",
      senderId: "+1555",
      notification: "not-requested",
      commandOwnerBootstrap: "not-requested",
    });
    await approval;

    expect(channels.state.pairingSnapshot?.requests).toEqual([]);
    expect(channels.state.pairingError).toBe("Error: refresh unavailable");
    channels.dispose();
  });

  it("does not let a pre-approval list restore the resolved request", async () => {
    const staleList = createDeferred<ChannelsPairingListResult>();
    const freshList = createDeferred<ChannelsPairingListResult>();
    let listCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "channels.pairing.list") {
        listCount += 1;
        return listCount === 1 ? staleList.promise : freshList.promise;
      }
      return {
        requestId: "request-1",
        senderId: "+1555",
        notification: "not-requested",
        commandOwnerBootstrap: "not-requested",
      };
    });
    const channels = createChannelCapability({
      snapshot: { client: { request }, connected: true },
      subscribe: () => () => undefined,
    } as never);

    const staleRefresh = channels.refreshPairing();
    await vi.waitFor(() => expect(listCount).toBe(1));
    const approval = channels.approvePairing({
      channel: "whatsapp",
      accountId: "personal",
      requestId: "request-1",
      notify: false,
      bootstrapCommandOwner: false,
    });
    await vi.waitFor(() => expect(listCount).toBe(2));
    freshList.resolve(emptyPairing);
    await approval;

    staleList.resolve(pendingPairing);
    await staleRefresh;

    expect(channels.state.pairingSnapshot?.requests).toEqual([]);
    channels.dispose();
  });

  it("clears sender metadata on disconnect and pairing-scope changes", () => {
    const client = { request: vi.fn() };
    let snapshot = {
      client,
      connected: true,
      hello: { auth: { role: "operator", scopes: ["operator.pairing"] } },
    };
    const listeners = new Set<(next: typeof snapshot) => void>();
    const channels = createChannelCapability({
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as never);
    channels.state.pairingSnapshot = pendingPairing;

    snapshot = {
      ...snapshot,
      hello: { auth: { role: "operator", scopes: ["operator.read"] } },
    };
    for (const listener of listeners) {
      listener(snapshot);
    }
    expect(channels.state.pairingSnapshot).toBeNull();

    channels.state.pairingSnapshot = pendingPairing;
    snapshot = { ...snapshot, connected: false };
    for (const listener of listeners) {
      listener(snapshot);
    }
    expect(channels.state.pairingSnapshot).toBeNull();
    channels.dispose();
  });

  it("ignores a pairing mutation result from an earlier authorization epoch", async () => {
    const approval = createDeferred<{
      requestId: string;
      senderId: string;
      notification: "not-requested";
      commandOwnerBootstrap: "not-requested";
    }>();
    const request = vi.fn(async (method: string) => {
      if (method === "channels.pairing.approve") {
        return approval.promise;
      }
      return emptyPairing;
    });
    const client = { request };
    let snapshot = {
      client,
      connected: true,
      hello: { auth: { role: "operator", scopes: ["operator.pairing"] } },
    };
    const listeners = new Set<(next: typeof snapshot) => void>();
    const channels = createChannelCapability({
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as never);
    channels.state.pairingSnapshot = pendingPairing;

    const pendingApproval = channels.approvePairing({
      channel: "whatsapp",
      accountId: "personal",
      requestId: "request-1",
      notify: false,
      bootstrapCommandOwner: false,
    });
    await vi.waitFor(() => expect(channels.state.pairingBusyRequestId).toBe("request-1"));
    snapshot = {
      ...snapshot,
      hello: { auth: { role: "operator", scopes: ["operator.pairing", "operator.read"] } },
    };
    for (const listener of listeners) {
      listener(snapshot);
    }
    channels.state.pairingSnapshot = pendingPairing;

    approval.resolve({
      requestId: "request-1",
      senderId: "+1555",
      notification: "not-requested",
      commandOwnerBootstrap: "not-requested",
    });

    await expect(pendingApproval).resolves.toBeNull();
    expect(channels.state.pairingSnapshot).toBe(pendingPairing);
    expect(request.mock.calls.filter(([method]) => method === "channels.pairing.list")).toEqual([]);
    channels.dispose();
  });

  it("keeps the last request snapshot visible when refresh fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("gateway unavailable");
    });
    const channels = createChannelCapability({
      snapshot: { client: { request }, connected: true },
      subscribe: () => () => undefined,
    } as never);
    channels.state.pairingSnapshot = emptyPairing;

    await channels.refreshPairing();

    expect(channels.state.pairingSnapshot).toBe(emptyPairing);
    expect(channels.state.pairingError).toBe("Error: gateway unavailable");
    channels.dispose();
  });
});

describe("channel refresh sequencing", () => {
  it("rejects an in-flight channel snapshot after read access is revoked", async () => {
    const pending = createDeferred<ChannelsStatusSnapshot | null>();
    const request = vi.fn(() => pending.promise);
    const client = { request };
    let snapshot = {
      client,
      connected: true,
      hello: { auth: { role: "operator", scopes: ["operator.read"] } },
    };
    const listeners = new Set<(next: typeof snapshot) => void>();
    const channels = createChannelCapability({
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as never);

    const refresh = channels.refresh();
    await vi.waitFor(() => expect(channels.state.channelsLoading).toBe(true));
    snapshot = {
      ...snapshot,
      hello: { auth: { role: "operator", scopes: ["operator.pairing"] } },
    };
    for (const listener of listeners) {
      listener(snapshot);
    }
    expect(channels.state.channelsLoading).toBe(false);
    expect(channels.state.channelsSnapshot).toBeNull();

    pending.resolve(createChannelsSnapshot("stale"));
    await refresh;

    expect(channels.state.channelsSnapshot).toBeNull();
    channels.dispose();
  });

  it("keeps a stale slow probe from replacing a newer runtime snapshot", async () => {
    const slowProbe = createDeferred<ChannelsStatusSnapshot | null>();
    const fastRuntime = createDeferred<ChannelsStatusSnapshot | null>();
    const request = vi.fn(async (_method: string, params?: unknown) =>
      (params as { probe?: boolean } | undefined)?.probe ? slowProbe.promise : fastRuntime.promise,
    );
    const channels = createChannelCapability({
      snapshot: { client: { request }, connected: true },
      subscribe: () => () => undefined,
    } as never);

    const probeLoad = channels.refresh(true, { softTimeoutMs: 1 });
    await probeLoad;
    const runtimeLoad = channels.refresh(false);
    expect(request).toHaveBeenCalledTimes(2);

    fastRuntime.resolve(createChannelsSnapshot("fresh"));
    await runtimeLoad;
    slowProbe.resolve(createChannelsSnapshot("stale"));
    await Promise.resolve();

    expect(channels.state.channelsSnapshot?.channelLabels.test).toBe("fresh");
    expect(channels.state.channelsLoading).toBe(false);
    channels.dispose();
  });

  it("returns after a soft timeout while retaining the in-flight loading state", async () => {
    vi.useFakeTimers();
    try {
      const pending = createDeferred<ChannelsStatusSnapshot | null>();
      const request = vi.fn(() => pending.promise);
      const channels = createChannelCapability({
        snapshot: { client: { request }, connected: true },
        subscribe: () => () => undefined,
      } as never);
      const previous = createChannelsSnapshot("previous");
      channels.state.channelsSnapshot = previous;
      channels.state.channelsLastSuccess = 10;

      const refresh = channels.refresh(true, { softTimeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      await refresh;

      expect(channels.state.channelsLoading).toBe(true);
      expect(channels.state.channelsSnapshot).toBe(previous);
      pending.resolve(createChannelsSnapshot("next"));
      await vi.waitFor(() => expect(channels.state.channelsLoading).toBe(false));
      expect(channels.state.channelsSnapshot?.channelLabels.test).toBe("next");
      channels.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
