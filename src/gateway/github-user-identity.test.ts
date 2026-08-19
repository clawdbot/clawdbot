import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  ensureProfileForTailscaleIdentity,
  getUserProfileListItem,
} from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { ControlUiGitHubError } from "./control-ui-github-api.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";

function githubResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function accessAssertion(issuer: unknown): string {
  const payload = Buffer.from(JSON.stringify({ iss: issuer })).toString("base64url");
  return `header.${payload}.signature`;
}

function cloudflareSync(params: {
  principal?: string;
  assertion?: string;
  userHeader?: string;
  requiredHeaders?: string[];
}) {
  return createAuthenticatedGitHubIdentitySync({
    authResult: {
      ok: true,
      method: "trusted-proxy",
      user: params.principal ?? "ada@example.com",
    },
    authConfig: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: params.userHeader ?? "cf-access-authenticated-user-email",
        requiredHeaders: params.requiredHeaders ?? ["CF-Access-JWT-Assertion"],
      },
    },
    requestHeaders: {
      "cf-access-authenticated-user-email": params.principal ?? "ada@example.com",
      "cf-access-jwt-assertion":
        params.assertion ?? accessAssertion("https://team.cloudflareaccess.com"),
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("authenticated GitHub identity sync", () => {
  it("resolves the canonical public account without authentication", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForTailscaleIdentity({ login: "octocat@github" });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(githubResponse({ id: 583231, login: "OctoCat" }));

      const sync = createAuthenticatedGitHubIdentitySync({
        authResult: {
          ok: true,
          method: "tailscale",
          user: "octocat@github",
          tailscaleIdentity: { login: "octocat@github", name: "Octo Cat" },
        },
      });

      await expect(sync?.()).resolves.toMatchObject({
        profileId: profile.id,
      });
      expect(getUserProfileListItem(profile.id).githubIdentity).toMatchObject({
        login: "OctoCat",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.github.com/users/octocat",
        expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }),
      );
      const headers = fetchMock.mock.calls[0]?.[1]?.headers;
      expect(headers).toMatchObject({
        Accept: "application/vnd.github+json",
        "User-Agent": "OpenClaw-Control-UI",
        "X-GitHub-Api-Version": "2022-11-28",
      });
      expect(headers).not.toHaveProperty("Authorization");
    });
  });

  it.each([
    {
      name: "not found",
      response: githubResponse({ message: "Not Found" }, 404),
      statusCode: 404,
    },
    {
      name: "rate limited",
      response: githubResponse({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0" }),
      statusCode: 429,
    },
    { name: "malformed", response: githubResponse({ id: "583231" }), statusCode: 502 },
  ])("maps a $name response", async ({ response, statusCode }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
      const sync = createAuthenticatedGitHubIdentitySync({
        authResult: {
          ok: true,
          method: "tailscale",
          user: "octocat@github",
          tailscaleIdentity: { login: "octocat@github", name: "Octo Cat" },
        },
      });
      await expect(sync?.()).rejects.toMatchObject({
        statusCode,
      } satisfies Partial<ControlUiGitHubError>);
    });
  });

  it("maps network failures and rejects invalid usernames before fetch", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
      const sync = createAuthenticatedGitHubIdentitySync({
        authResult: {
          ok: true,
          method: "tailscale",
          user: "octocat@github",
          tailscaleIdentity: { login: "octocat@github", name: "Octo Cat" },
        },
      });
      await expect(sync?.()).rejects.toMatchObject({
        statusCode: 502,
      } satisfies Partial<ControlUiGitHubError>);
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  it("deduplicates concurrent authenticated profile sync", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForTailscaleIdentity({ login: "ada@github" });
      let resolveLookup: ((response: Response) => void) | undefined;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(
        async () =>
          await new Promise<Response>((resolve) => {
            resolveLookup = resolve;
          }),
      );

      const sync = createAuthenticatedGitHubIdentitySync({
        authResult: {
          ok: true,
          method: "tailscale",
          user: "ada@github",
          tailscaleIdentity: { login: "ada@github", name: "Ada" },
        },
      });
      const first = sync?.();
      const second = sync?.();
      expect(second).toBe(first);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      resolveLookup?.(githubResponse({ id: 583231, login: "Ada" }));

      await expect(first).resolves.toMatchObject({ profileId: profile.id });
      expect(getUserProfileListItem(profile.id).githubIdentity).toMatchObject({ login: "Ada" });
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  it("preserves verified identity after lookup failure and retries later", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForTailscaleIdentity({ login: "ada@github" });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(githubResponse({ id: 583231, login: "Ada" }))
        .mockRejectedValueOnce(new Error("network unavailable"))
        .mockResolvedValueOnce(githubResponse({ id: 583231, login: "Ada-Renamed" }));

      const firstConnection = createAuthenticatedGitHubIdentitySync({
        authResult: {
          ok: true,
          method: "tailscale",
          user: "ada@github",
          tailscaleIdentity: { login: "ada@github", name: "Ada" },
        },
      });
      await firstConnection?.();
      const failingConnection = createAuthenticatedGitHubIdentitySync({
        authResult: {
          ok: true,
          method: "tailscale",
          user: "ada@github",
          tailscaleIdentity: { login: "ada@github", name: "Ada" },
        },
      });
      await expect(failingConnection?.()).rejects.toMatchObject({ statusCode: 502 });
      expect(getUserProfileListItem(profile.id).githubIdentity).toMatchObject({ login: "Ada" });

      await failingConnection?.();
      expect(getUserProfileListItem(profile.id).githubIdentity).toMatchObject({
        login: "Ada-Renamed",
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  it("activates only the standard required-header Cloudflare Access contract", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      expect(cloudflareSync({})).toBeTypeOf("function");
      expect(cloudflareSync({ userHeader: "x-forwarded-user" })).toBeUndefined();
      expect(cloudflareSync({ requiredHeaders: ["x-forwarded-proto"] })).toBeUndefined();
    });
  });

  it("binds Cloudflare identity to email, GitHub IdP, numeric id, and canonical GitHub login", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          githubResponse({
            id: 58493,
            email: "ADA@example.com",
            name: "Ada Display Name",
            idp: { id: "github-oauth", type: "github" },
          }),
        )
        .mockResolvedValueOnce(githubResponse({ id: 58493, login: "steipete" }));

      const sync = cloudflareSync({});
      const result = await sync?.();
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "https://team.cloudflareaccess.com/cdn-cgi/access/get-identity",
        expect.objectContaining({
          headers: {
            Cookie: expect.stringMatching(/^CF_Authorization=/u),
          },
          redirect: "manual",
          signal: expect.any(AbortSignal),
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://api.github.com/user/58493",
        expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }),
      );
      expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty("Authorization");
      expect(getUserProfileListItem(result!.profileId)).toMatchObject({
        displayName: "Ada Display Name",
        emails: ["ada@example.com"],
        githubIdentity: { login: "steipete" },
      });
    });
  });

  it.each([
    { name: "malformed JWT", assertion: "not-a-jwt" },
    { name: "oversized JWT", assertion: "x".repeat(16 * 1024 + 1) },
    { name: "non-HTTPS issuer", issuer: "http://team.cloudflareaccess.com" },
    { name: "credentialed issuer", issuer: "https://user@team.cloudflareaccess.com" },
    { name: "non-root issuer", issuer: "https://team.cloudflareaccess.com/path" },
    { name: "hostile suffix", issuer: "https://team.cloudflareaccess.com.evil.test" },
  ])("rejects a $name before network access", async ({ assertion, issuer }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const sync = cloudflareSync({
        assertion: assertion ?? accessAssertion(issuer),
      });
      await expect(sync?.()).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      name: "redirect",
      access: githubResponse({}, 302, { location: "https://evil.test/identity" }),
    },
    { name: "non-object response", access: githubResponse([]) },
    {
      name: "malformed JSON",
      access: new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
    },
    {
      name: "mismatched email",
      access: githubResponse({
        id: 58493,
        email: "mallory@example.com",
        idp: { type: "github" },
      }),
    },
    {
      name: "non-GitHub IdP",
      access: githubResponse({
        id: 58493,
        email: "ada@example.com",
        idp: { type: "google" },
      }),
    },
    {
      name: "invalid account id",
      access: githubResponse({
        id: "58493",
        email: "ada@example.com",
        idp: { type: "github" },
      }),
    },
  ])("fails safely for a $name", async ({ access }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForTailscaleIdentity({ login: "ada@passkey" });
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(access);
      const sync = cloudflareSync({});
      await expect(sync?.()).rejects.toThrow();
      expect(getUserProfileListItem(profile.id).githubIdentity).toBeNull();
    });
  });

  it("rejects a GitHub account-id mismatch without erasing prior identity", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const initialFetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          githubResponse({
            id: 58493,
            email: "ada@example.com",
            idp: { type: "github" },
          }),
        )
        .mockResolvedValueOnce(githubResponse({ id: 58493, login: "steipete" }));
      const first = await cloudflareSync({})?.();
      initialFetch
        .mockResolvedValueOnce(
          githubResponse({
            id: 58493,
            email: "ada@example.com",
            idp: { type: "github" },
          }),
        )
        .mockResolvedValueOnce(githubResponse({ id: 99999, login: "mallory" }));

      await expect(cloudflareSync({})?.()).rejects.toThrow();
      expect(getUserProfileListItem(first!.profileId).githubIdentity).toMatchObject({
        login: "steipete",
      });
    });
  });

  it.each([
    {
      name: "GitHub rate limit",
      githubResult: githubResponse({ message: "rate limit" }, 403, {
        "x-ratelimit-remaining": "0",
      }),
    },
    { name: "GitHub network failure", githubError: new Error("network unavailable") },
  ])("preserves prior identity after a $name", async ({ githubResult, githubError }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          githubResponse({
            id: 58493,
            email: "ada@example.com",
            idp: { type: "github" },
          }),
        )
        .mockResolvedValueOnce(githubResponse({ id: 58493, login: "steipete" }));
      const first = await cloudflareSync({})?.();
      fetchMock.mockResolvedValueOnce(
        githubResponse({
          id: 58493,
          email: "ada@example.com",
          idp: { type: "github" },
        }),
      );
      if (githubError) {
        fetchMock.mockRejectedValueOnce(githubError);
      } else {
        fetchMock.mockResolvedValueOnce(githubResult!);
      }

      await expect(cloudflareSync({})?.()).rejects.toThrow();
      expect(getUserProfileListItem(first!.profileId).githubIdentity).toMatchObject({
        login: "steipete",
      });
    });
  });

  it("redacts the Access assertion from network failures and retries on the same connection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const assertion = accessAssertion("https://team.cloudflareaccess.com");
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error(`network rejected ${assertion}`))
        .mockResolvedValueOnce(
          githubResponse({
            id: 58493,
            email: "ada@example.com",
            idp: { type: "github" },
          }),
        )
        .mockResolvedValueOnce(githubResponse({ id: 58493, login: "steipete" }));
      const sync = cloudflareSync({ assertion });

      const error = await sync?.().catch((failure: unknown) => failure);
      expect(String(error)).not.toContain(assertion);
      const result = await sync?.();
      expect(result?.profileId).toBeTypeOf("string");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
