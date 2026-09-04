import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import {
  getUserProfileListItem,
  setDisplayName,
  setUserProfileRole,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";
import { resolveAuthenticatedHttpUserProfile } from "./http-auth-user-profile.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";

const ACCESS_ORIGIN = "https://team.cloudflareaccess.com";
const CACHE_TTL_MS = 15 * 60_000;

function jsonResponse(value: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), { headers });
}

function accessParams(
  principal = "ada@example.test",
): Parameters<typeof createAuthenticatedGitHubIdentitySync>[0] {
  return {
    authResult: { ok: true, method: "trusted-proxy", user: principal },
    authConfig: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["cf-access-jwt-assertion"],
      },
    },
    requestHeaders: {
      "cf-access-jwt-assertion": `header.${Buffer.from(JSON.stringify({ iss: ACCESS_ORIGIN })).toString("base64url")}.signature`,
    },
  };
}

function createAccessSync(principal?: string) {
  const sync = createAuthenticatedGitHubIdentitySync(accessParams(principal));
  assert(sync);
  return sync;
}

function stubIdentityFetch(
  metadata: typeof fetch,
  access = { id: 101, email: "ada@example.test" },
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(ACCESS_ORIGIN)) {
      return jsonResponse({ ...access, idp: { type: "github" } });
    }
    return metadata(input, init);
  });
}

beforeEach(() => {
  vi.stubEnv("GH_TOKEN", undefined);
  vi.stubEnv("GITHUB_TOKEN", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawStateDatabaseForTest();
});

describe("GitHub public identity metadata cache", () => {
  it("deduplicates concurrent metadata without caching Access verification or local profiles", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const gate = createDeferred();
      const metadata = vi.fn<typeof fetch>().mockImplementation(async () => {
        await gate.promise;
        return jsonResponse({ id: 101, login: "ada", name: "Ada" });
      });
      const transport = stubIdentityFetch(metadata);
      const pending = Promise.all([createAccessSync()(), createAccessSync()()]);
      await vi.waitFor(() =>
        expect(transport).toHaveBeenCalledTimes(metadata.mock.calls.length + 2),
      );
      gate.resolve();
      const [first, second] = await pending;
      expect(second.profileId).toBe(first.profileId);
      expect(metadata).toHaveBeenCalledOnce();
      setDisplayName(first.profileId, "Locally Edited");
      await createAccessSync()();
      expect(getUserProfileListItem(first.profileId).displayName).toBe("Locally Edited");
      expect(metadata).toHaveBeenCalledOnce();
      expect(transport).toHaveBeenCalledTimes(4);
    });
  });

  it("refreshes expired metadata conditionally and extends freshness on a 304", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const metadata = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ id: 101, login: "ada" }, { etag: '"profile-v1"' }))
        .mockResolvedValueOnce(new Response(null, { status: 304 }))
        .mockResolvedValueOnce(
          jsonResponse({ id: 101, login: "ada-renamed" }, { etag: '"profile-v2"' }),
        );
      stubIdentityFetch(metadata);
      const first = await createAccessSync()();
      clock.mockReturnValue(1_800_000_000_000 + CACHE_TTL_MS - 1);
      await expect(createAccessSync()()).resolves.toMatchObject({ profileId: first.profileId });
      expect(metadata).toHaveBeenCalledOnce();
      clock.mockReturnValue(1_800_000_000_000 + CACHE_TTL_MS);
      await expect(createAccessSync()()).resolves.toMatchObject({
        updatedAt: 1_800_000_000_000 + CACHE_TTL_MS,
      });
      expect(new Headers(metadata.mock.calls[1]?.[1]?.headers).get("if-none-match")).toBe(
        '"profile-v1"',
      );
      clock.mockReturnValue(1_800_000_000_000 + 2 * CACHE_TTL_MS - 1);
      await createAccessSync()();
      expect(metadata).toHaveBeenCalledTimes(2);
      clock.mockReturnValue(1_800_000_000_000 + 2 * CACHE_TTL_MS);
      await createAccessSync()();
      expect(getUserProfileListItem(first.profileId).githubIdentity?.login).toBe("ada-renamed");
    });
  });

  it("separates account and credential keys and rejects unavailable configured credentials", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const access = { id: 101, email: "ada@example.test" };
      const metadata = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          jsonResponse(
            { id: access.id, login: access.id === 101 ? "ada" : "grace" },
            { etag: '"metadata-v1"' },
          ),
        );
      stubIdentityFetch(metadata, access);
      setRuntimeConfigSnapshot({ gateway: { controlUi: { github: { token: "first-token" } } } });
      await createAccessSync()();
      setRuntimeConfigSnapshot({ gateway: { controlUi: { github: { token: "second-token" } } } });
      await createAccessSync()();
      expect(new Headers(metadata.mock.calls[1]?.[1]?.headers).has("if-none-match")).toBe(false);
      access.id = 102;
      const second = await createAccessSync()();
      expect(getUserProfileListItem(second.profileId).githubIdentity?.login).toBe("grace");
      expect(metadata).toHaveBeenCalledTimes(3);
      setRuntimeConfigSnapshot({
        gateway: {
          controlUi: {
            github: { token: { source: "env", provider: "default", id: "UNAVAILABLE_TOKEN" } },
          },
        },
      });
      await expect(createAccessSync()()).rejects.toBeInstanceOf(SecretSurfaceUnavailableError);
      expect(metadata).toHaveBeenCalledTimes(3);
    });
  });

  it("never reuses an anonymous ETag for an authenticated refresh", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      setRuntimeConfigSnapshot({ gateway: { controlUi: { github: { token: "service-token" } } } });
      const metadata = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(jsonResponse({ id: 101, login: "ada" }, { etag: '"anonymous-v1"' }))
        .mockResolvedValueOnce(
          jsonResponse({ id: 101, login: "ada" }, { etag: '"authenticated-v1"' }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 304 }));
      stubIdentityFetch(metadata);
      await createAccessSync()();
      await createAccessSync()();
      expect(new Headers(metadata.mock.calls[2]?.[1]?.headers).get("if-none-match")).toBeNull();
      clock.mockReturnValue(1_800_000_000_000 + CACHE_TTL_MS);
      await createAccessSync()();
      expect(new Headers(metadata.mock.calls[3]?.[1]?.headers).get("if-none-match")).toBe(
        '"authenticated-v1"',
      );
      expect(metadata).toHaveBeenCalledTimes(4);
    });
  });

  it.each([
    { name: "deleted account", response: () => new Response(null, { status: 404 }) },
    { name: "permission failure", response: () => new Response(null, { status: 403 }) },
    { name: "account mismatch", response: () => jsonResponse({ id: 102, login: "other" }) },
    { name: "malformed response", response: () => new Response("{") },
    {
      name: "unsafe redirect",
      response: () =>
        new Response(null, { status: 302, headers: { location: "https://other.test/identity" } }),
    },
  ])(
    "invalidates expired metadata after a $name without using the durable outage binding",
    async ({ response }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
        const metadata = vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(jsonResponse({ id: 101, login: "ada" }, { etag: '"profile-v1"' }))
          .mockImplementationOnce(async () => response())
          .mockResolvedValueOnce(jsonResponse({ id: 101, login: "ada-renamed" }));
        stubIdentityFetch(metadata);
        const first = await createAccessSync()();
        clock.mockReturnValue(1_800_000_000_000 + CACHE_TTL_MS);
        await expect(createAccessSync()()).rejects.toMatchObject({ retryable: false });
        await createAccessSync()();
        expect(new Headers(metadata.mock.calls[2]?.[1]?.headers).has("if-none-match")).toBe(false);
        expect(getUserProfileListItem(first.profileId).githubIdentity?.login).toBe("ada-renamed");
        expect(metadata).toHaveBeenCalledTimes(3);
      });
    },
  );

  it("rechecks live Access and local role revocation on HTTP metadata cache hits", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const access = { id: 101, email: "ada@example.test" };
      const metadata = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => jsonResponse({ id: 101, login: "ada" }));
      const transport = stubIdentityFetch(metadata, access);
      const auth = accessParams();
      const req = new IncomingMessage(new Socket());
      req.headers = auth.requestHeaders ?? {};
      const cfg = {
        gateway: {
          auth: auth.authConfig,
          roles: {
            default: "guest",
            definitions: {
              maintainer: {
                sessions: { others: "view" as const },
                agents: "*" as const,
                scopes: ["operator.admin" as const],
              },
              guest: { sessions: { others: "none" as const }, agents: [] as string[], scopes: [] },
            },
          },
        },
      };
      const changed = vi.fn();
      const stop = onUserProfilesChanged(changed);
      try {
        const resolve = () =>
          resolveAuthenticatedHttpUserProfile({ authResult: auth.authResult, req, cfg });
        const first = await resolve();
        assert(first.authenticatedUserProfile);
        const profileId = first.authenticatedUserProfile.profileId;
        changed.mockClear();
        clock.mockReturnValue(1_800_000_001_000);
        const warm = await resolve();
        expect(changed).not.toHaveBeenCalled();
        expect(warm.authenticatedUserProfile?.updatedAt).toBe(
          first.authenticatedUserProfile.updatedAt,
        );
        setUserProfileRole(profileId, "maintainer");
        invalidateOperatorRolePolicy(profileId);
        expect((await resolve()).operatorRolePolicy?.scopes).toContain("operator.admin");
        setUserProfileRole(profileId, null);
        invalidateOperatorRolePolicy(profileId);
        expect((await resolve()).operatorRolePolicy?.scopes).toEqual([]);
        access.email = "other@example.test";
        await expect(resolve()).rejects.toThrow("principal did not match");
        expect(metadata).toHaveBeenCalledOnce();
        expect(transport).toHaveBeenCalledTimes(6);
      } finally {
        stop();
        req.destroy();
      }
    });
  });

  it("binds a new email on a metadata cache hit before reusing its durable profile", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const access = { id: 101, email: "ada@example.test" };
      const metadata = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => jsonResponse({ id: 101, login: "ada" }));
      const transport = stubIdentityFetch(metadata, access);
      const first = await createAccessSync()();
      const changed = vi.fn();
      const stop = onUserProfilesChanged(changed);
      try {
        access.email = "ada-new@example.test";
        const second = await createAccessSync(access.email)();
        expect(second.profileId).toBe(first.profileId);
        expect(getUserProfileListItem(first.profileId).emails).toEqual([
          "ada-new@example.test",
          "ada@example.test",
        ]);
        expect(changed).toHaveBeenCalledOnce();
        changed.mockClear();
        await createAccessSync(access.email)();
        expect(changed).not.toHaveBeenCalled();
        expect(metadata).toHaveBeenCalledOnce();
        expect(transport).toHaveBeenCalledTimes(4);
      } finally {
        stop();
      }
    });
  });

  it("uses only an exact durable binding during expired metadata quota cooldown", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const access = { id: 101, email: "ada@example.test" };
      const metadata = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ id: 101, login: "ada" }))
        .mockImplementation(
          async () => new Response(null, { status: 429, headers: { "retry-after": "90" } }),
        );
      stubIdentityFetch(metadata, access);
      const first = await createAccessSync()();
      clock.mockReturnValue(1_800_000_000_000 + CACHE_TTL_MS);
      await expect(createAccessSync()()).resolves.toMatchObject({ profileId: first.profileId });
      await expect(createAccessSync()()).resolves.toMatchObject({ profileId: first.profileId });
      access.email = "new-principal@example.test";
      await expect(createAccessSync(access.email)()).rejects.toMatchObject({ statusCode: 429 });
      expect(metadata).toHaveBeenCalledTimes(2);
    });
  });

  it("reverifies mutable Tailscale logins when an account name is reassigned", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const transport = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse({ id: 101, login: "ada" }))
        .mockResolvedValueOnce(jsonResponse({ id: 102, login: "ada" }));
      const sync = () => {
        const resolve = createAuthenticatedGitHubIdentitySync({
          authResult: {
            ok: true,
            method: "tailscale",
            user: "ada@github",
            tailscaleIdentity: { login: "ada@github", name: "Ada" },
          },
        });
        assert(resolve);
        return resolve();
      };
      const first = await sync();
      const second = await sync();
      expect(second.profileId).not.toBe(first.profileId);
      expect(transport).toHaveBeenCalledTimes(2);
    });
  });
});
