import { ConnectErrorDetailCodes } from "@openclaw/gateway-client/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MentionInboxItem,
  MentionsListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError, type GatewayHelloOk } from "../api/gateway.ts";
import { createConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import { createMentionsCapability, type MentionsCapability } from "./mentions.ts";
import {
  client,
  createGatewayHarness,
  deferred,
  flushMicrotasks,
  type RequestFn,
} from "./overlays-access.test-support.ts";

const mention: MentionInboxItem = {
  id: "mention-1",
  senderProfileId: "alice",
  senderLabel: "Alice",
  sessionKey: "agent:writer:review",
  agentId: "writer",
  sessionTitle: "Review",
  messageId: "message-1",
  createdAt: 1_000,
  expiresAt: 10_000,
  excerpt: "@Bob please review this",
};

function hello(bootId = "boot-a"): GatewayHelloOk {
  return {
    type: "hello-ok",
    protocol: 1,
    server: { bootId, connId: "connection-a" },
    auth: { role: "operator", scopes: ["operator.read"] },
    features: { methods: ["mentions.list", "mentions.dismiss"] },
  };
}

function result(
  revision: number,
  items: MentionInboxItem[] = [mention],
  gatewayInstanceId = "boot-a",
): MentionsListResult {
  return { gatewayInstanceId, revision, items };
}

function gatewayForMentions(request: RequestFn) {
  const harness = createGatewayHarness(client(request));
  harness.update({
    hello: hello(),
    selfUser: { id: "bob", identity: { type: "profile", id: "bob" }, name: "Bob" },
  });
  return harness;
}

const capabilities: MentionsCapability[] = [];

function createCapability(...args: Parameters<typeof createMentionsCapability>) {
  const capability = createMentionsCapability(...args);
  capabilities.push(capability);
  return capability;
}

afterEach(() => {
  capabilities.splice(0).forEach((capability) => capability.dispose());
});

describe("application mention Inbox", () => {
  it("does not call older Gateways without an advertised mention Inbox", async () => {
    const request = vi.fn<RequestFn>(() => Promise.resolve(result(1)));
    const harness = gatewayForMentions(request);
    harness.update({ hello: { ...hello(), features: { methods: ["sessions.list"] } } });
    const capability = createCapability(harness.gateway);

    await capability.refresh();

    expect(capability.snapshot.phase).toBe("unavailable");
    expect(request).not.toHaveBeenCalled();
  });

  it("hydrates only a canonical profile and keeps mentions independent of the selected session", async () => {
    const request = vi.fn<RequestFn>(() => Promise.resolve(result(1)));
    const harness = gatewayForMentions(request);
    harness.update({ selfUser: { id: "bob", name: "Bob" } });
    const capability = createCapability(harness.gateway);

    await capability.refresh();
    expect(capability.snapshot.phase).toBe("unavailable");
    expect(request).not.toHaveBeenCalled();

    harness.update({
      selfUser: { id: "raw-login", identity: { type: "profile", id: "bob" } },
    });
    await capability.refresh();
    expect(capability.snapshot).toMatchObject({ phase: "ready", items: [mention] });
    harness.update({ sessionKey: "agent:other:main", assistantAgentId: "other" });

    expect(capability.snapshot.items).toEqual([mention]);
    expect(request).toHaveBeenCalledExactlyOnceWith("mentions.list", {});
  });

  it("coalesces in-flight invalidations without publishing a pre-invalidation snapshot", async () => {
    const initial = deferred<MentionsListResult>();
    const latest = deferred<MentionsListResult>();
    const request = vi
      .fn<RequestFn>()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValue(latest.promise);
    const harness = gatewayForMentions(request);
    const capability = createCapability(harness.gateway);
    const published: string[][] = [];
    capability.subscribe(() => published.push(capability.snapshot.items.map((item) => item.id)));
    const hydration = capability.refresh();
    await flushMicrotasks();

    harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 2 });
    harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 3 });
    initial.resolve(result(1));
    await flushMicrotasks();
    expect(request).toHaveBeenCalledTimes(2);
    expect(published.flat()).not.toContain(mention.id);

    const current = { ...mention, id: "mention-current" };
    latest.resolve(result(3, [current]));
    await hydration;
    expect(capability.snapshot.items).toEqual([current]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a dismissed item from an older list or delayed invalidation", async () => {
    const staleList = deferred<MentionsListResult>();
    let reads = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method === "mentions.dismiss") {
        return Promise.resolve(result(2, []));
      }
      reads += 1;
      return reads === 1 ? Promise.resolve(result(1)) : staleList.promise;
    });
    const harness = gatewayForMentions(request);
    const capability = createCapability(harness.gateway);
    await capability.refresh();
    const refresh = capability.refresh();
    await flushMicrotasks();

    await capability.dismiss([mention.id]);
    expect(capability.snapshot.items).toEqual([]);
    staleList.resolve(result(1));
    await refresh;
    harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 1 });
    harness.emitEvent("mentions.changed", { gatewayInstanceId: "retired-boot", revision: 99 });

    expect(capability.snapshot).toMatchObject({ phase: "ready", items: [], dismissing: [] });
    expect(reads).toBe(2);
  });

  it("reconciles an invalidation arriving as the previous snapshot settles", async () => {
    const request = vi
      .fn<RequestFn>()
      .mockResolvedValueOnce(result(1))
      .mockResolvedValue(result(2, []));
    const harness = gatewayForMentions(request);
    const capability = createCapability(harness.gateway);
    let invalidated = false;
    capability.subscribe(() => {
      if (invalidated || capability.snapshot.phase !== "ready") {
        return;
      }
      invalidated = true;
      queueMicrotask(() => {
        harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 2 });
      });
    });

    await capability.refresh();

    expect(capability.snapshot).toMatchObject({ phase: "ready", items: [] });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps failed acknowledgements visible and retries only caller-visible IDs", async () => {
    let dismissals = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method !== "mentions.dismiss") {
        return Promise.resolve(result(1));
      }
      dismissals += 1;
      return dismissals === 1
        ? Promise.reject(new Error("Connection interrupted"))
        : Promise.resolve(result(2, []));
    });
    const harness = gatewayForMentions(request);
    const capability = createCapability(harness.gateway);
    await capability.refresh();

    await capability.dismiss(["foreign-id", mention.id, mention.id]);
    expect(capability.snapshot).toMatchObject({
      phase: "error",
      items: [mention],
      dismissing: [],
      error: "Connection interrupted",
    });
    expect(request).toHaveBeenLastCalledWith("mentions.dismiss", { ids: [mention.id] });
    await capability.dismiss([mention.id]);
    expect(capability.snapshot).toMatchObject({ phase: "ready", items: [], error: null });
  });

  it.each([
    ["refresh", "role"],
    ["dismiss", "role"],
    ["refresh", "profile"],
    ["dismiss", "profile"],
  ] as const)(
    "clears a previously visible Inbox when %s reports %s access loss",
    async (operation, failure) => {
      let revoked = false;
      const request = vi.fn<RequestFn>(() =>
        revoked
          ? Promise.reject(
              new GatewayRequestError({
                code: failure === "role" ? "FORBIDDEN" : "UNAVAILABLE",
                message: "Mention access revoked",
                ...(failure === "profile"
                  ? { details: { code: ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE } }
                  : {}),
              }),
            )
          : Promise.resolve(result(1)),
      );
      const harness = gatewayForMentions(request);
      const capability = createCapability(harness.gateway);
      await capability.refresh();
      revoked = true;

      if (operation === "refresh") {
        await capability.refresh();
      } else {
        await capability.dismiss([mention.id]);
      }

      expect(capability.snapshot).toMatchObject({
        phase: "error",
        items: [],
        dismissing: [],
        error: "Mention access revoked",
      });
      revoked = false;
      await capability.refresh();
      expect(capability.snapshot).toMatchObject({ phase: "ready", items: [mention], error: null });
    },
  );

  it("fences an in-flight list after dismissal reports revoked access", async () => {
    const stale = deferred<MentionsListResult>();
    let reads = 0;
    const request = vi.fn<RequestFn>((method) => {
      if (method === "mentions.dismiss") {
        return Promise.reject(
          new GatewayRequestError({ code: "FORBIDDEN", message: "Mention access revoked" }),
        );
      }
      return ++reads === 1 ? Promise.resolve(result(1)) : stale.promise;
    });
    const harness = gatewayForMentions(request);
    const capability = createCapability(harness.gateway);
    await capability.refresh();
    const pending = capability.refresh();
    await flushMicrotasks();
    await capability.dismiss([mention.id]);

    stale.resolve(result(2));
    await pending;

    expect(capability.snapshot).toMatchObject({ phase: "error", items: [] });
  });

  it.each([
    "profile",
    "connection",
    "gateway",
    "credentials",
    "disconnect",
    "scope",
    "capability",
  ] as const)(
    "clears the old Inbox immediately and fences an in-flight read after a %s change",
    async (boundary) => {
      const stale = deferred<MentionsListResult>();
      let reads = 0;
      const request = vi.fn<RequestFn>(() => {
        reads += 1;
        return reads === 1
          ? Promise.resolve(result(1))
          : reads === 2
            ? stale.promise
            : Promise.resolve(result(0, [], boundary === "gateway" ? "boot-b" : "boot-a"));
      });
      const harness = gatewayForMentions(request);
      const capability = createCapability(harness.gateway);
      await capability.refresh();
      const refresh = capability.refresh();
      await flushMicrotasks();

      if (boundary === "profile") {
        harness.update({ selfUser: { id: "carol", identity: { type: "profile", id: "carol" } } });
      } else if (boundary === "connection") {
        harness.update({ client: client(request) });
      } else if (boundary === "gateway") {
        harness.update({ hello: hello("boot-b") });
      } else if (boundary === "credentials") {
        harness.gateway.connectionRevision += 1;
        harness.update({});
      } else if (boundary === "scope") {
        harness.update({ hello: { ...hello(), auth: { role: "operator", scopes: [] } } });
      } else if (boundary === "capability") {
        harness.update({ hello: { ...hello(), features: { methods: [] } } });
      } else {
        harness.update({ phase: "reconnecting", selfUser: null, hello: null });
      }
      expect(capability.snapshot.items).toEqual([]);
      if (boundary !== "disconnect") {
        await capability.refresh();
      }
      stale.resolve(result(99));
      await refresh;

      expect(capability.snapshot.items).toEqual([]);
      expect(capability.snapshot.phase).toBe(
        ["disconnect", "scope", "capability"].includes(boundary) ? "unavailable" : "ready",
      );
    },
  );

  it("hydrates the new profile when an earlier profile's bootstrap is still queued", async () => {
    const bootstrap = createConnectionBootstrapCoordinator();
    const request = vi.fn<RequestFn>(() => Promise.resolve(result(0, [])));
    const harness = gatewayForMentions(request);
    const capability = createCapability(harness.gateway, { connectionBootstrap: bootstrap });
    harness.update({ selfUser: { id: "carol", identity: { type: "profile", id: "carol" } } });

    bootstrap.synchronize({ client: harness.gateway.snapshot.client, connected: true });
    await vi.waitFor(() => expect(capability.snapshot.phase).toBe("ready"));
    expect(request).toHaveBeenCalledExactlyOnceWith("mentions.list", {});
    bootstrap.reset();
  });

  it("does not start queued work or publish an in-flight dismissal after disposal", async () => {
    const dismissal = deferred<MentionsListResult>();
    const request = vi.fn<RequestFn>((method) =>
      method === "mentions.dismiss" ? dismissal.promise : Promise.resolve(result(1)),
    );
    const harness = gatewayForMentions(request);
    const capability = createCapability(harness.gateway);
    await capability.refresh();
    const pending = capability.dismiss([mention.id]);
    const publish = vi.fn();
    capability.subscribe(publish);
    capability.dispose();
    dismissal.resolve(result(2, []));
    await pending;
    harness.emitEvent("mentions.changed", { gatewayInstanceId: "boot-a", revision: 3 });
    expect(publish).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);

    const queued = createCapability(harness.gateway);
    queued.dispose();
    await flushMicrotasks();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
