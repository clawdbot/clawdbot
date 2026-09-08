import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
/* @vitest-environment node */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionsListResult } from "../../api/types.ts";
import type { BootRecord } from "../../app/boot-record.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createSessionCapability } from "./index.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import type { SessionCapability, SessionGateway } from "./session-capability.ts";
import type { SessionRosterRecord } from "./session-roster-cache.ts";

const url = "ws://gateway.example.test";
const scope = gatewayCredentialScope(url);
const bootRecord: BootRecord = {
  version: 2,
  authMethod: "token",
  credential: "9d17676d",
  savedAt: 1,
  scope,
  profileId: "profile-one",
  agents: { defaultId: "main", mainKey: "main", scope: "per-sender", agents: [{ id: "main" }] },
  groups: [{ name: "Work", position: 0 }],
  sectionOrder: ["category:Work"],
};
function roster(): SessionRosterRecord {
  return {
    version: 1,
    scope,
    savedAt: Date.now(),
    profileId: "profile-one",
    agentId: "main",
    query: {},
    result: sessionsResult(
      [
        {
          key: "agent:main:deleted",
          sessionId: "deleted",
          kind: "direct",
          derivedTitle: "Removed later",
        },
        {
          key: "agent:main:kept",
          sessionId: "kept",
          kind: "direct",
          derivedTitle: "Stale title",
          lastMessagePreview: "Stale preview",
        },
      ],
      1,
    ),
    groups: ["Work"],
    groupSettings: bootRecord.groups,
    sectionOrder: bootRecord.sectionOrder,
  };
}
const activeCapabilities = new Set<SessionCapability>();
afterEach(() => {
  for (const sessions of activeCapabilities) {
    sessions.dispose();
  }
  activeCapabilities.clear();
});

function harness(
  options: { cached?: Promise<SessionRosterRecord | null>; withBootRecord?: boolean } = {},
) {
  let connectionRevision = 0;
  let snapshot: SessionGateway["snapshot"] = {
    client: null,
    phase: "connecting",
    hello: null,
    sessionKey: "agent:main:deleted",
    selfUser: null,
  };
  const listeners = new Set<(value: typeof snapshot) => void>();
  const live = createDeferred<SessionsListResult>();
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      return live.promise;
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const client = createTestGatewayClient(request);
  const gateway: SessionGateway = {
    connection: { gatewayUrl: url, token: "test-token" },
    get connectionRevision() {
      return connectionRevision;
    },
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEvents: () => () => undefined,
  };
  const read = vi.fn(() => options.cached ?? Promise.resolve(roster()));
  const write = vi.fn();
  const selection = { state: { selectedId: "main" }, subscribe: () => () => undefined };
  const sessions = createSessionCapability(gateway, selection, {
    rosterCache: { read, write },
    ...(options.withBootRecord !== false ? { bootRecord } : {}),
  });
  activeCapabilities.add(sessions);
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener(snapshot));
  };
  return {
    sessions,
    read,
    write,
    request,
    live,
    gateway,
    publish,
    changeCredentials() {
      connectionRevision += 1;
    },
    connect(
      profileId = "profile-one",
      method:
        | "token"
        | "device-token"
        | "trusted-proxy"
        | "password"
        | "tailscale"
        | "bootstrap-token"
        | "none"
        | undefined = "token",
    ) {
      publish({
        phase: "connected",
        client,
        selfUser: { id: profileId },
        hello: {
          type: "hello-ok",
          protocol: 1,
          auth: { method, deviceToken: "test-token", role: "operator", scopes: ["operator.read"] },
        },
      });
    },
  };
}

describe("session capability warm roster", () => {
  it("publishes groups synchronously, then the cached roster without a connection or canonical revision", async () => {
    const cached = createDeferred<SessionRosterRecord | null>();
    const h = harness({ cached: cached.promise });
    expect(h.sessions.state.groups).toEqual(["Work"]);
    expect(h.sessions.state.result).toBeNull();
    let settled = false;
    void h.sessions.whenCachedRosterSettled().then(() => {
      settled = true;
    });
    await vi.dynamicImportSettled();
    expect(settled).toBe(false);
    cached.resolve(roster());
    await h.sessions.whenCachedRosterSettled();
    expect(settled).toBe(true);
    expect(h.sessions.state).toMatchObject({
      result: roster().result,
      resultCached: true,
      agentId: "main",
    });
    expect(h.sessions.canonicalListRevision).toBe(0);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    h.publish({ phase: "reconnecting" });
    expect(h.sessions.state.result?.sessions).toHaveLength(2);
    expect(h.sessions.state.resultCached).toBe(true);
  });

  it("does not read or publish a cached roster without an accepted boot record", async () => {
    const h = harness({ withBootRecord: false });
    await h.sessions.whenCachedRosterSettled();
    expect(h.read).not.toHaveBeenCalled();
    expect(h.sessions.state).toMatchObject({
      result: null,
      groups: [],
      groupSettings: [],
      sectionOrder: [],
    });
    expect(h.sessions.state.resultCached).not.toBe(true);
    expect(h.sessions.canonicalListRevision).toBe(0);
    h.publish({ phase: "reconnecting" });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.sessions.state.result).toBeNull();

    h.connect();
    const live = sessionsResult([{ key: "agent:main:live", kind: "direct" }], 2);
    h.live.resolve(live);
    await vi.waitFor(() => expect(h.sessions.state.result).toEqual(live));
    expect(h.sessions.state.resultCached).toBe(false);
  });

  it("replaces cached rows and stale presentation with the first live list, then schedules persistence", async () => {
    const h = harness();
    await h.sessions.whenCachedRosterSettled();
    h.connect();
    await vi.waitFor(() =>
      expect(h.request).toHaveBeenCalledWith("sessions.list", expect.anything()),
    );
    expect(h.write).not.toHaveBeenCalled();
    const live = sessionsResult([{ key: "agent:main:kept", sessionId: "kept", kind: "direct" }], 2);
    h.live.resolve(live);
    await vi.waitFor(() => expect(h.sessions.state.resultCached).toBe(false));
    expect(h.sessions.state.result).toEqual(live);
    expect(h.sessions.canonicalListRevision).toBe(1);
    expect(h.write).toHaveBeenCalledWith(
      expect.objectContaining({ scope, profileId: "profile-one", agentId: "main", result: live }),
    );
  });

  it.each(["trusted-proxy", "password", "tailscale", "bootstrap-token", "none"] as const)(
    "does not persist live rows for %s authentication",
    async (method) => {
      const h = harness({ withBootRecord: false });
      h.connect("profile-one", method);
      const live = sessionsResult([{ key: "agent:main:private", kind: "direct" }], 2);
      h.live.resolve(live);
      await vi.waitFor(() => expect(h.sessions.state.result).toEqual(live));
      expect(h.write).not.toHaveBeenCalled();
    },
  );

  it("drops a mismatched profile before bootstrap asks for its live rows", async () => {
    const h = harness();
    await h.sessions.whenCachedRosterSettled();
    h.connect("profile-two");
    expect(h.sessions.state.result).toBeNull();
    expect(h.sessions.state.groups).toEqual([]);
    expect(h.sessions.state.resultCached).toBe(false);
    const live = sessionsResult([{ key: "agent:main:new-profile", kind: "direct" }], 2);
    h.live.resolve(live);
    await vi.waitFor(() => expect(h.sessions.state.result).toEqual(live));
    expect(h.write).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "profile-two", result: live }),
    );
  });

  it.each(["connect", "dispose", "credentials", "credentials-before-notification"] as const)(
    "does not publish a late cache read after %s",
    async (transition) => {
      const cached = createDeferred<SessionRosterRecord | null>();
      const h = harness({ cached: cached.promise });
      if (transition === "connect") {
        h.connect();
      } else if (transition === "dispose") {
        h.sessions.dispose();
      } else {
        h.changeCredentials();
        if (transition === "credentials") {
          h.publish({ phase: "connecting" });
          expect(h.sessions.state.groups).toEqual([]);
        }
      }
      cached.resolve(roster());
      await h.sessions.whenCachedRosterSettled();
      expect(h.sessions.state.result).toBeNull();
      expect(h.sessions.state.resultCached).not.toBe(true);
    },
  );

  it.each(["connect", "dispose"] as const)(
    "releases the roster wait on %s while the cache read is still pending",
    async (transition) => {
      const cached = createDeferred<SessionRosterRecord | null>();
      const h = harness({ cached: cached.promise });
      const settled = h.sessions.whenCachedRosterSettled();
      if (transition === "connect") {
        h.connect();
      } else {
        h.sessions.dispose();
      }
      await expect(
        Promise.race([
          settled.then(() => "released"),
          new Promise<string>((resolve) => {
            setTimeout(() => resolve("held"), 200);
          }),
        ]),
      ).resolves.toBe("released");
      cached.resolve(roster());
      await settled;
      expect(h.sessions.state.resultCached).not.toBe(true);
    },
  );

  it.each(["gateway", "credentials"])(
    "retires the warm roster on a %s change and retains replacement live rows",
    async (change) => {
      const h = harness();
      await h.sessions.whenCachedRosterSettled();
      expect(h.sessions.state.resultCached).toBe(true);
      expect(h.sessions.state.result?.sessions).toHaveLength(2);
      const nextUrl = change === "gateway" ? "ws://other.example.test" : url;
      if (change === "gateway") {
        Object.defineProperty(h.gateway, "connection", {
          value: { gatewayUrl: nextUrl, token: "test-token" },
        });
      } else {
        h.changeCredentials();
      }
      h.publish({ phase: "connecting" });
      expect(h.sessions.state).toMatchObject({
        result: null,
        resultCached: false,
        agentId: null,
        groups: [],
        groupSettings: [],
        sectionOrder: [],
      });
      h.publish({ phase: "offline" });
      expect(h.sessions.state.result).toBeNull();
      h.connect();
      const live = sessionsResult([{ key: "agent:main:other", kind: "direct" }], 2);
      h.live.resolve(live);
      await vi.waitFor(() => expect(h.sessions.state.result).toEqual(live));
      h.publish({ sessionKey: "agent:main:other" });
      expect(h.sessions.state.result).toEqual(live);
      expect(h.write).toHaveBeenCalledWith(
        expect.objectContaining({ scope: gatewayCredentialScope(nextUrl) }),
      );
    },
  );

  it.each(["agent", "profile", "query", "query-agent"] as const)(
    "rejects an incompatible %s from an injected roster reader",
    async (mismatch) => {
      const invalid = roster();
      if (mismatch === "agent") {
        invalid.agentId = "other";
      }
      if (mismatch === "profile") {
        invalid.profileId = "other";
      }
      if (mismatch === "query") {
        invalid.query = { archivedFilter: "archived" };
      }
      if (mismatch === "query-agent") {
        invalid.query = { agentId: "other" };
      }
      const h = harness({ cached: Promise.resolve(invalid) });
      await h.sessions.whenCachedRosterSettled();
      expect(h.sessions.state.result).toBeNull();
    },
  );
});
