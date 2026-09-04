import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginStateKeyedStore } from "../api.js";
import { VisitorPolicyClient } from "./cloudflare.js";
import type { VisitorAccessConfig } from "./config.js";
import { VisitorAccessError } from "./errors.js";
import { VisitorAccessService, type VisitorGrant } from "./visitors.js";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const DAY_MS = 86_400_000;
const config: VisitorAccessConfig = {
  accountId: "test-account",
  appId: "test-app",
  apiToken: "test-token",
  policyName: "Visitors (openclaw-managed)",
  defaultTtlDays: 14,
  maxVisitors: 50,
};
const policiesPath = "/client/v4/accounts/test-account/access/apps/test-app/policies";

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input);
}

type PolicyFixture = {
  id: string;
  name: string;
  decision: string;
  include: { email: { email: string } }[];
};

function visitorGrant(email: string, overrides: Partial<VisitorGrant> = {}): VisitorGrant {
  return { email, createdAt: NOW - DAY_MS, expiresAt: NOW + DAY_MS, ...overrides };
}

function visitorFixture(
  options: {
    config?: Partial<VisitorAccessConfig>;
    grants?: VisitorGrant[];
    emails?: string[];
    githubEmail?: string | null;
  } = {},
) {
  const resolved = { ...config, ...options.config };
  const grants = new Map(options.grants?.map((grant) => [grant.email, grant]));
  const store: PluginStateKeyedStore<VisitorGrant> = {
    async register(key, grant) {
      grants.set(key, structuredClone(grant));
    },
    async registerIfAbsent(key, grant) {
      if (grants.has(key)) {
        return false;
      }
      grants.set(key, structuredClone(grant));
      return true;
    },
    async lookup(key) {
      return structuredClone(grants.get(key));
    },
    async consume(key) {
      const grant = grants.get(key);
      grants.delete(key);
      return structuredClone(grant);
    },
    async delete(key) {
      return grants.delete(key);
    },
    async entries() {
      return [...grants].map(([key, value]) => ({
        key,
        value: structuredClone(value),
        createdAt: value.createdAt,
      }));
    },
    async clear() {
      grants.clear();
    },
  };
  const cloudflare: {
    policy: PolicyFixture | undefined;
    failWrites: boolean;
    loseWriteResponse: boolean;
    beforeWrite: () => Promise<void>;
  } = {
    policy: options.emails?.length
      ? {
          id: "visitors",
          name: resolved.policyName,
          decision: "allow",
          include: options.emails.map((email) => ({ email: { email } })),
        }
      : undefined,
    failWrites: false,
    loseWriteResponse: false,
    beforeWrite: async () => {},
  };
  const response = (result: unknown) => Response.json({ success: true, result });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    if (url.origin === "https://api.github.com") {
      if (!/^\/users\/[a-z0-9-]+$/.test(url.pathname) || method !== "GET") {
        throw new Error("Unexpected GitHub request");
      }
      return Response.json({ email: options.githubEmail ?? null });
    }
    if (url.origin !== "https://api.cloudflare.com" || !url.pathname.startsWith(policiesPath)) {
      throw new Error("Unexpected Cloudflare endpoint");
    }
    if (method === "GET") {
      if (url.pathname === policiesPath) {
        return response(cloudflare.policy ? [cloudflare.policy] : []);
      }
      if (url.pathname === `${policiesPath}/visitors` && cloudflare.policy) {
        return response(cloudflare.policy);
      }
      throw new Error("Unknown policy read");
    }
    await cloudflare.beforeWrite();
    if (cloudflare.failWrites) {
      return new Response("Unavailable", { status: 503 });
    }
    if (method === "DELETE" && url.pathname === `${policiesPath}/visitors`) {
      cloudflare.policy = undefined;
    } else if (
      (method === "POST" && url.pathname === policiesPath) ||
      (method === "PUT" && url.pathname === `${policiesPath}/visitors`)
    ) {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON policy");
      }
      const body = JSON.parse(init.body) as Omit<PolicyFixture, "id">;
      cloudflare.policy = { ...body, id: "visitors" };
    } else {
      throw new Error("Unexpected policy mutation");
    }
    if (cloudflare.loseWriteResponse) {
      throw new Error("Connection lost after Cloudflare committed the policy");
    }
    return response(cloudflare.policy ?? { id: "visitors" });
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const service = new VisitorAccessService(
    resolved,
    store,
    new VisitorPolicyClient(resolved, fetcher),
    logger,
    fetcher,
  );
  return {
    cloudflare,
    fetcher,
    grants,
    logger,
    service,
    emails: () => cloudflare.policy?.include.map((rule) => rule.email.email) ?? [],
    mutations: () =>
      fetcher.mock.calls.filter(([, init]) => init?.method !== "GET" && init?.method),
  };
}

describe("VisitorAccessService", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves public GitHub email, records a default-expiring grant, and explains login", async () => {
    const fixture = visitorFixture({ githubEmail: "Visitor@Example.com" });

    const result = await fixture.service.invite({ github: "Visitor" }, "session:maintainer");

    expect(fixture.emails()).toEqual(["visitor@example.com"]);
    expect(fixture.grants.get("visitor@example.com")).toEqual({
      email: "visitor@example.com",
      githubLogin: "visitor",
      invitedVia: "session:maintainer",
      createdAt: NOW,
      expiresAt: NOW + 14 * DAY_MS,
    });
    expect(fixture.fetcher.mock.calls[0]?.[0]).toBe("https://api.github.com/users/visitor");
    expect(result).toContain("@visitor");
    expect(result).toContain("visitor@example.com");
    expect(result).toContain("2026-09-11T12:00:00.000Z");
    expect(result).toContain("https://team.openclaw.ai");
    expect(result).toContain("GitHub account");
  });

  it("asks for an explicit account email when GitHub has no public email, without granting access", async () => {
    const fixture = visitorFixture({ githubEmail: null });

    await expect(fixture.service.invite({ github: "private-visitor" })).rejects.toThrow(
      /Ask the visitor.*email.*GitHub account.*email explicitly/,
    );

    expect(fixture.emails()).toEqual([]);
    expect(fixture.grants.size).toBe(0);
    expect(fixture.mutations()).toEqual([]);
  });

  it("uses an explicit normalized email without consulting GitHub", async () => {
    const fixture = visitorFixture();

    await fixture.service.invite({
      github: "Private-Visitor",
      email: " Visitor@Example.com ",
      days: 3,
    });

    expect(fixture.grants.get("visitor@example.com")).toMatchObject({
      githubLogin: "private-visitor",
      expiresAt: NOW + 3 * DAY_MS,
    });
    expect(fixture.emails()).toEqual(["visitor@example.com"]);
    expect(
      fixture.fetcher.mock.calls.every(
        ([url]) => requestUrl(url).origin === "https://api.cloudflare.com",
      ),
    ).toBe(true);
  });

  it.each([
    {},
    { email: "not-an-email" },
    { email: "a@example.com\nBcc:other@example.com" },
    { github: "../other" },
    { email: "visitor@example.com", days: 0 },
  ])("rejects invalid identity or duration before writing any grant: %j", async (input) => {
    const fixture = visitorFixture();
    await expect(fixture.service.invite(input)).rejects.toBeInstanceOf(VisitorAccessError);
    expect(fixture.fetcher).not.toHaveBeenCalled();
    expect(fixture.grants.size).toBe(0);
  });

  it.each([0, null])(
    "requires explicit forever when the default duration is %s",
    async (defaultTtlDays) => {
      const fixture = visitorFixture({ config: { defaultTtlDays } });
      await expect(fixture.service.invite({ email: "visitor@example.com" })).rejects.toThrow(
        /forever/,
      );
      expect(fixture.grants.size).toBe(0);
      expect(fixture.mutations()).toEqual([]);

      const result = await fixture.service.invite({ email: "visitor@example.com", forever: true });
      expect(fixture.grants.get("visitor@example.com")?.expiresAt).toBeNull();
      expect(result).toContain("never");
      await expect(
        fixture.service.invite({ email: "visitor@example.com", forever: true, days: 1 }),
      ).rejects.toThrow(/days.*forever/);
    },
  );

  it("counts managed and unmanaged grants toward admission while allowing an existing grant to renew", async () => {
    const previous = visitorGrant("visitor@example.com", { githubLogin: "visitor" });
    const fixture = visitorFixture({
      config: { maxVisitors: 2 },
      grants: [previous],
      emails: [previous.email, "manual@example.com"],
    });
    await expect(fixture.service.invite({ email: "third@example.com" })).rejects.toThrow(/limit/);
    expect(fixture.emails()).toEqual([previous.email, "manual@example.com"]);
    expect(fixture.grants.size).toBe(1);

    vi.setSystemTime(NOW + DAY_MS);
    await fixture.service.invite({ email: "VISITOR@example.com", days: 4 });
    expect(fixture.grants.get(previous.email)).toMatchObject({
      createdAt: previous.createdAt,
      githubLogin: "visitor",
      expiresAt: NOW + 5 * DAY_MS,
    });
    expect(fixture.emails()).toEqual([previous.email, "manual@example.com"]);
    expect(fixture.grants.size).toBe(1);
  });

  it("revokes by recorded GitHub login even after that account hides its public email", async () => {
    const grants = ["first@example.com", "second@example.com"].map((email) =>
      visitorGrant(email, { githubLogin: "visitor" }),
    );
    const fixture = visitorFixture({
      grants,
      emails: [...grants.map((grant) => grant.email), "manual@example.com"],
    });

    const result = await fixture.service.revoke({ github: "Visitor" });

    expect(fixture.emails()).toEqual(["manual@example.com"]);
    expect(fixture.grants.size).toBe(0);
    expect(result).toContain("@visitor (2 recorded emails)");
    expect(
      fixture.fetcher.mock.calls.every(
        ([url]) => requestUrl(url).origin !== "https://api.github.com",
      ),
    ).toBe(true);
  });

  it("explicitly revokes unmanaged emails and makes a repeated revoke a clean no-op", async () => {
    const fixture = visitorFixture({ emails: ["manual@example.com"] });
    await expect(fixture.service.revoke({ email: "manual@example.com" })).resolves.toContain(
      "Revoked",
    );
    expect(fixture.emails()).toEqual([]);
    expect(fixture.grants.size).toBe(0);
    const writes = fixture.mutations().length;

    await expect(fixture.service.revoke({ email: "manual@example.com" })).resolves.toMatch(
      /nothing to revoke/,
    );
    expect(fixture.mutations()).toHaveLength(writes);
  });

  it("rejects an empty revoke without deleting email-only grant records", async () => {
    const grant = visitorGrant("visitor@example.com");
    const fixture = visitorFixture({ grants: [grant], emails: [grant.email] });

    await expect(fixture.service.revoke({})).rejects.toBeInstanceOf(VisitorAccessError);

    expect(fixture.emails()).toEqual([grant.email]);
    expect(fixture.grants.get(grant.email)).toEqual(grant);
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });

  it("sweeps expired grants while preserving unexpired, forever, and unmanaged access", async () => {
    const expired = visitorGrant("expired@example.com", { expiresAt: NOW });
    const active = visitorGrant("active@example.com");
    const forever = visitorGrant("forever@example.com", { expiresAt: null });
    const fixture = visitorFixture({
      grants: [expired, active, forever],
      emails: [expired.email, active.email, forever.email, "manual@example.com"],
    });

    await fixture.service.sweep();

    expect(fixture.emails()).toEqual([active.email, forever.email, "manual@example.com"]);
    expect([...fixture.grants.values()]).toEqual([active, forever]);
    expect(fixture.logger.info).toHaveBeenCalledWith(expect.stringContaining(expired.email));
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/unmanaged.*manual@example.com.*retained/),
    );
  });

  it("reports both drift directions and dates without restoring or deleting dashboard changes", async () => {
    const missing = visitorGrant("missing@example.com", { githubLogin: "visitor" });
    const fixture = visitorFixture({ grants: [missing], emails: ["manual@example.com"] });

    const result = await fixture.service.list();
    await fixture.service.sweep();

    expect(result).toContain("1 unmanaged, 1 missing from policy");
    expect(result).toMatch(
      /missing@example.com.*@visitor.*2026-08-27T12:00:00.000Z.*2026-08-29T12:00:00.000Z.*MISSING FROM POLICY/,
    );
    expect(result).toMatch(/manual@example.com.*UNMANAGED/);
    expect(fixture.emails()).toEqual(["manual@example.com"]);
    expect(fixture.grants.get(missing.email)).toEqual(missing);
    expect(fixture.mutations()).toEqual([]);
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/missing@example.com.*missing from policy/),
    );
  });

  it("bounds list output when dashboard edits exceed the visitor cap", async () => {
    const fixture = visitorFixture({
      config: { maxVisitors: 2 },
      emails: ["a@example.com", "b@example.com", "c@example.com"],
    });

    const result = await fixture.service.list();

    expect(result).toContain("3 unmanaged");
    expect(result.match(/UNMANAGED/g)).toHaveLength(2);
    expect(result).toContain("1 entries omitted");
    expect(fixture.emails()).toHaveLength(3);
    expect(fixture.mutations()).toEqual([]);
  });

  it.each(["revoke", "sweep"] as const)(
    "retains expiry records after a failed Cloudflare %s so cleanup can retry",
    async (operation) => {
      const expired = visitorGrant("expired@example.com", { expiresAt: NOW });
      const fixture = visitorFixture({ grants: [expired], emails: [expired.email] });
      fixture.cloudflare.failWrites = true;

      await expect(
        operation === "revoke"
          ? fixture.service.revoke({ email: expired.email })
          : fixture.service.sweep(),
      ).rejects.toBeInstanceOf(VisitorAccessError);

      expect(fixture.grants.get(expired.email)).toEqual(expired);
      expect(fixture.emails()).toEqual([expired.email]);
      fixture.cloudflare.failWrites = false;
      await fixture.service.sweep();
      expect(fixture.grants.size).toBe(0);
      expect(fixture.emails()).toEqual([]);
    },
  );

  it("keeps an expiry cleanup record when Cloudflare grants access but its response is lost", async () => {
    const fixture = visitorFixture();
    fixture.cloudflare.loseWriteResponse = true;

    await expect(
      fixture.service.invite({ email: "visitor@example.com", days: 1 }),
    ).rejects.toBeInstanceOf(VisitorAccessError);

    expect(fixture.emails()).toEqual(["visitor@example.com"]);
    expect(fixture.grants.get("visitor@example.com")?.expiresAt).toBe(NOW + DAY_MS);
    fixture.cloudflare.loseWriteResponse = false;
    vi.setSystemTime(NOW + DAY_MS);
    await fixture.service.sweep();
    expect(fixture.grants.size).toBe(0);
    expect(fixture.emails()).toEqual([]);
  });

  it("serializes concurrent invites so a delayed policy write cannot lose another visitor", async () => {
    const fixture = visitorFixture();
    const writing = createDeferred<void>();
    const release = createDeferred<void>();
    fixture.cloudflare.beforeWrite = async () => {
      writing.resolve();
      await release.promise;
    };
    const first = fixture.service.invite({ email: "first@example.com" });
    await writing.promise;
    const second = fixture.service.invite({ email: "second@example.com" });
    release.resolve();

    await Promise.all([first, second]);

    expect(fixture.emails()).toEqual(["first@example.com", "second@example.com"]);
    expect([...fixture.grants.keys()]).toEqual(["first@example.com", "second@example.com"]);
  });
});
