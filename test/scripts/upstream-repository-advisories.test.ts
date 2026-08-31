import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublishedRepositoryAdvisories } from "../../scripts/lib/upstream-repository-advisories.mts";

const REGISTRY = "https://registry.npmjs.org";
const REPOSITORY = "fixture/packages";
const ADVISORY_ID = "GHSA-2222-3333-4444";
const NEXT_PAGE =
  '<https://api.github.com/repositories/42/security-advisories?state=published&per_page=100&after=next%2Bcursor>; rel="next"';

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

function vulnerability(range: unknown, name: unknown = "fixture", ecosystem = "npm") {
  return { package: { ecosystem, name }, vulnerable_version_range: range };
}

function advisory(range: unknown = "< 2.0.0", fields: Record<string, unknown> = {}) {
  return {
    ghsa_id: ADVISORY_ID,
    state: "published",
    withdrawn_at: null,
    severity: "high",
    summary: "Fixture vulnerability",
    vulnerabilities: [vulnerability(range)],
    ...fields,
  };
}

function manifest(url: URL, repository: unknown = `git+https://github.com/${REPOSITORY}.git`) {
  const [name, version] = url.pathname.slice(1).split("/").map(decodeURIComponent);
  return Response.json({ name, version, repository });
}

function createSourceFetch(
  handlers: {
    manifest?: Handler;
    repository?: Handler;
    page?: Handler;
  } = {},
) {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.origin === REGISTRY) {
      return handlers.manifest ? handlers.manifest(url, init) : manifest(url);
    }
    if (url.origin !== "https://api.github.com") {
      throw new Error(`Unexpected request origin: ${url.origin}`);
    }
    if (url.pathname.endsWith("/security-advisories")) {
      return handlers.page ? handlers.page(url, init) : Response.json([]);
    }
    return handlers.repository
      ? handlers.repository(url, init)
      : Response.json({ id: 42, full_name: REPOSITORY, private: false, visibility: "public" });
  };
  return { calls, fetchImpl };
}

function scan(fetchImpl: typeof fetch, payload: Record<string, string[]> = { fixture: ["1.0.0"] }) {
  return fetchPublishedRepositoryAdvisories({ payload, registryBaseUrl: REGISTRY, fetchImpl });
}

beforeEach(() => {
  vi.stubEnv("GH_TOKEN", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("published upstream repository advisories", () => {
  it("discovers exact scoped versions once and verifies a shared repository before scanning", async () => {
    const source = createSourceFetch({
      manifest: (url) =>
        manifest(
          url,
          url.pathname.includes("%2F")
            ? { url: "git+https://github.com/FIXTURE/packages.git", directory: "packages/leaf" }
            : "github:Fixture/Packages",
        ),
      page: () =>
        Response.json([
          advisory(">= 0", {
            vulnerabilities: [vulnerability(">= 0"), vulnerability("= 1.2.3", "@scope/leaf")],
          }),
        ]),
    });
    const report = await scan(source.fetchImpl, {
      "@scope/leaf": ["1.2.3", "1.2.3"],
      fixture: ["1.0.0", "0.9.0"],
    });

    expect(source.calls.map(({ url }) => url.pathname)).toEqual([
      "/%40scope%2Fleaf/1.2.3",
      "/fixture/0.9.0",
      "/fixture/1.0.0",
      "/repos/fixture/packages",
      "/repos/fixture/packages/security-advisories",
    ]);
    expect(report.advisories).toMatchObject([
      { packageName: "@scope/leaf", matchedVersions: ["1.2.3"] },
      { packageName: "fixture", matchedVersions: ["0.9.0", "1.0.0"] },
    ]);
    expect(report.coverage).toMatchObject({
      status: "checked",
      packageVersions: 3,
      mappedPackageVersions: 3,
      repositories: 1,
      checkedRepositories: 1,
      issues: [],
    });
  });

  it("sends the token only to fixed GitHub requests and refuses redirects on every request", async () => {
    vi.stubEnv("GH_TOKEN", "synthetic-upstream-test-token");
    const source = createSourceFetch();
    await scan(source.fetchImpl);

    expect(source.calls).toHaveLength(3);
    for (const { url, init } of source.calls) {
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("error");
      expect(headers.get("authorization")).toBe(
        url.origin === REGISTRY ? null : "Bearer synthetic-upstream-test-token",
      );
      if (url.origin !== REGISTRY) {
        expect(url.origin).toBe("https://api.github.com");
      }
    }
  });

  it("does not attach the GitHub token to a registry lookup even when its origin is GitHub", async () => {
    vi.stubEnv("GH_TOKEN", "synthetic-upstream-test-token");
    const headers: Headers[] = [];
    const report = await fetchPublishedRepositoryAdvisories({
      payload: { fixture: ["1.0.0"] },
      registryBaseUrl: "https://api.github.com",
      fetchImpl: async (_input, init) => {
        headers.push(new Headers(init?.headers));
        return Response.json({ name: "fixture", version: "1.0.0" });
      },
    });
    expect(headers).toHaveLength(1);
    expect(expectDefined(headers[0], "registry request headers").has("authorization")).toBe(false);
    expect(report.coverage.status).toBe("partial");
  });

  it("records unsupported locked versions without requesting registry metadata", async () => {
    const source = createSourceFetch();
    const report = await scan(source.fetchImpl, { fixture: ["git+https://example.invalid/pkg"] });
    expect(source.calls).toEqual([]);
    expect(report.coverage).toMatchObject({
      status: "partial",
      issues: [
        { subject: "fixture@git+https://example.invalid/pkg", reason: "unsupported-version" },
      ],
    });
  });

  it.each([
    {
      name: "wrong package",
      data: { name: "another", version: "1.0.0" },
      reason: "invalid-response",
    },
    {
      name: "latest instead of locked version",
      data: { name: "fixture", version: "2.0.0" },
      reason: "invalid-response",
    },
    {
      name: "missing repository",
      data: { name: "fixture", version: "1.0.0" },
      reason: "unsupported-repository",
    },
    {
      name: "non-GitHub",
      repository: "https://gitlab.com/fixture/packages",
      reason: "unsupported-repository",
    },
    {
      name: "userinfo host confusion",
      repository: "https://github.com@evil.example/fixture/packages",
      reason: "unsupported-repository",
    },
    {
      name: "credential-bearing URL",
      repository: "https://user:password@github.com/fixture/packages",
      reason: "unsupported-repository",
    },
    {
      name: "branch URL",
      repository: "https://github.com/fixture/packages/tree/main",
      reason: "unsupported-repository",
    },
  ])("does not scan $name registry metadata", async (entry) => {
    const source = createSourceFetch({
      manifest: (url) =>
        "data" in entry ? Response.json(entry.data) : manifest(url, entry.repository),
    });
    const report = await scan(source.fetchImpl);
    expect(source.calls).toHaveLength(1);
    expect(report.advisories).toEqual([]);
    expect(report.coverage).toMatchObject({
      status: "partial",
      mappedPackageVersions: 0,
      issues: [{ subject: "fixture@1.0.0", reason: entry.reason }],
    });
  });

  it.each([
    { name: "private", data: { id: 42, private: true }, reason: "repository-not-public" },
    { name: "missing visibility", data: { id: 42 }, reason: "repository-not-public" },
    { name: "malformed", data: [], reason: "repository-not-public" },
    { name: "invalid ID", data: { id: "42", private: false }, reason: "invalid-response" },
  ])("does not request advisories from $name repository metadata", async ({ data, reason }) => {
    const source = createSourceFetch({ repository: () => Response.json(data) });
    const report = await scan(source.fetchImpl);
    expect(source.calls.map(({ url }) => url.pathname)).toEqual([
      "/fixture/1.0.0",
      "/repos/fixture/packages",
    ]);
    expect(report.coverage).toMatchObject({
      status: "partial",
      checkedRepositories: 0,
      issues: [{ subject: REPOSITORY, reason }],
    });
  });

  it("reports a redirect without requesting its destination", async () => {
    const source = createSourceFetch({
      repository: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/advisories" },
        }),
    });
    const report = await scan(source.fetchImpl);
    expect(source.calls).toHaveLength(2);
    expect(source.calls.every(({ init }) => init?.redirect === "error")).toBe(true);
    expect(report.coverage).toMatchObject({
      status: "partial",
      issues: [{ subject: REPOSITORY, reason: "request-failed" }],
    });
  });

  it.each([
    {
      range: ">= 0",
      versions: ["0.0.0-alpha", "0.0.0", "1.0.0"],
      matched: ["0.0.0", "0.0.0-alpha", "1.0.0"],
    },
    { range: "> 0", versions: ["0.0.0", "0.0.1", "0.1.0"], matched: ["0.0.1", "0.1.0"] },
    { range: "= 1.0.0", versions: ["1.0.0-rc.1", "1.0.0", "1.0.1"], matched: ["1.0.0"] },
    { range: "= 1.0.0-rc.1", versions: ["1.0.0-rc.1", "1.0.0"], matched: ["1.0.0-rc.1"] },
    {
      range: ">= 1.0.0, < 2.0.0",
      versions: ["0.9.0", "1.0.0", "1.5.0-beta.1", "2.0.0"],
      matched: ["1.0.0", "1.5.0-beta.1"],
    },
    {
      range: "> 1.0.0, <= 2.0.0",
      versions: ["1.0.0", "1.0.1", "2.0.0", "2.0.1"],
      matched: ["1.0.1", "2.0.0"],
    },
    { range: "< 1.0.0", versions: ["0.9.0-beta.1", "1.0.0"], matched: ["0.9.0-beta.1"] },
  ])(
    "compares documented $range bounds without installer prerelease exclusions",
    async ({ range, versions, matched }) => {
      const source = createSourceFetch({ page: () => Response.json([advisory(range)]) });
      const report = await scan(source.fetchImpl, { fixture: versions });
      expect(report.advisories).toMatchObject([{ id: ADVISORY_ID, matchedVersions: matched }]);
      expect(report.advisories).toHaveLength(1);
      expect(report.coverage.status).toBe("checked");
    },
  );

  it("matches only the declared npm package, ignores withdrawn entries, and normalizes medium severity", async () => {
    const source = createSourceFetch({
      page: () =>
        Response.json([
          advisory("< 2.0.0", {
            severity: "medium",
            vulnerabilities: [
              vulnerability("< 2.0.0"),
              vulnerability("< 2.0.0", "Fixture"),
              vulnerability("< 2.0.0", "fixture", "pip"),
              vulnerability("< 2.0.0", "other"),
            ],
          }),
          advisory("< 2.0.0", { withdrawn_at: "2026-01-01T00:00:00Z" }),
        ]),
    });
    const report = await scan(source.fetchImpl);
    expect(report.advisories).toMatchObject([
      {
        packageName: "fixture",
        severity: "moderate",
        matchedVersions: ["1.0.0"],
        url: `https://github.com/${REPOSITORY}/security/advisories/${ADVISORY_ID}`,
      },
    ]);
    expect(report.advisories).toHaveLength(1);
    expect(report.coverage.status).toBe("checked");
  });

  it.each([
    { name: "unpublished", fields: { state: "draft" } },
    { name: "unknown severity", fields: { severity: null } },
    {
      name: "missing npm package identity",
      fields: { vulnerabilities: [vulnerability("< 2.0.0", null)] },
    },
  ])("reports $name advisory evidence as incomplete rather than unaffected", async ({ fields }) => {
    const source = createSourceFetch({ page: () => Response.json([advisory("< 2.0.0", fields)]) });
    const report = await scan(source.fetchImpl);
    expect(report.advisories).toEqual([]);
    expect(report.coverage.status).toBe("partial");
    expect(report.coverage.issues).toContainEqual(
      expect.objectContaining({ reason: "invalid-advisory" }),
    );
  });

  it.each([
    null,
    "",
    ">= 1.0.0 < 2.0.0",
    ">= 1.0.0, < 2.0.0; >= 3.0.0, < 4.0.0",
    "^1.0.0",
    ">= 1.0",
    "< 2.0.0, > 1.0.0",
    "= " + "1".repeat(257),
  ])("retains a confirmed match when a sibling range is malformed (%s)", async (range) => {
    const source = createSourceFetch({
      page: () =>
        Response.json([
          advisory("< 2.0.0", {
            vulnerabilities: [vulnerability("< 2.0.0"), vulnerability(range)],
          }),
        ]),
    });
    const report = await scan(source.fetchImpl);
    expect(report.advisories).toMatchObject([{ id: ADVISORY_ID, matchedVersions: ["1.0.0"] }]);
    expect(report.coverage).toMatchObject({
      status: "partial",
      issues: [{ subject: `fixture#${ADVISORY_ID}`, reason: "invalid-range" }],
    });
  });

  it("uses repository-id pagination cursors without changing the verified target or published-state filter", async () => {
    const source = createSourceFetch({
      page: (url) =>
        url.searchParams.has("after")
          ? Response.json([])
          : Response.json([advisory()], { headers: { link: NEXT_PAGE } }),
    });
    const report = await scan(source.fetchImpl);
    const pages = source.calls.filter(({ url }) => url.pathname.endsWith("/security-advisories"));
    expect(pages).toHaveLength(2);
    const nextPage = expectDefined(pages[1], "next advisory page");
    expect(nextPage.url.pathname).toBe("/repos/fixture/packages/security-advisories");
    expect(Object.fromEntries(nextPage.url.searchParams)).toEqual({
      state: "published",
      per_page: "100",
      after: "next+cursor",
    });
    expect(report.advisories).toHaveLength(1);
    expect(report.coverage.status).toBe("checked");
  });

  it.each([
    "https://evil.example/repositories/42/security-advisories?after=next",
    "https://api.github.com/repos/another/package/security-advisories?state=published&after=next",
    "https://api.github.com/repositories/999/security-advisories?state=published&after=next",
    "https://api.github.com/repositories/42/security-advisories?state=draft&after=next",
    "https://user:password@api.github.com/repositories/42/security-advisories?state=published&after=next",
  ])("does not continue an untrusted pagination link (%s)", async (next) => {
    const source = createSourceFetch({
      page: (url) =>
        Response.json(url.searchParams.has("after") ? [] : [advisory()], {
          headers: url.searchParams.has("after") ? {} : { link: `<${next}>; rel="next"` },
        }),
    });
    const report = await scan(source.fetchImpl);
    expect(
      source.calls.filter(({ url }) => url.pathname.endsWith("/security-advisories")),
    ).toHaveLength(1);
    expect(report.advisories).toHaveLength(1);
    expect(report.coverage).toMatchObject({
      status: "partial",
      checkedRepositories: 0,
      issues: [{ subject: REPOSITORY, reason: "invalid-pagination" }],
    });
  });

  it.each(["unavailable", "oversized", "invalid-json"])(
    "preserves earlier findings when a later page is %s",
    async (failure) => {
      const source = createSourceFetch({
        page: (url) => {
          if (!url.searchParams.has("after")) {
            return Response.json([advisory()], { headers: { link: NEXT_PAGE } });
          }
          if (failure === "unavailable") {
            return new Response(null, { status: 503 });
          }
          if (failure === "oversized") {
            return Response.json(Array.from({ length: 101 }, () => advisory()));
          }
          return new Response("{");
        },
      });
      const report = await scan(source.fetchImpl);
      expect(report.advisories).toHaveLength(1);
      expect(report.coverage.status).toBe("partial");
      expect(report.coverage.checkedRepositories).toBe(0);
      expect(report.coverage.issues).toHaveLength(1);
    },
  );

  it.each(["repeated cursor", "page budget"])(
    "stops at the %s without discarding findings",
    async (limit) => {
      let pages = 0;
      const source = createSourceFetch({
        page: () => {
          pages += 1;
          const cursor = limit === "repeated cursor" ? "same" : String(pages);
          return Response.json(pages === 1 ? [advisory()] : [], {
            headers: {
              link: `<https://api.github.com/repositories/42/security-advisories?state=published&after=${cursor}>; rel="next"`,
            },
          });
        },
      });
      const report = await scan(source.fetchImpl);
      expect(pages).toBe(limit === "repeated cursor" ? 2 : 5);
      expect(report.advisories).toHaveLength(1);
      expect(report.coverage).toMatchObject({
        status: "partial",
        checkedRepositories: 0,
        issues: [
          {
            subject: REPOSITORY,
            reason: limit === "repeated cursor" ? "invalid-pagination" : "budget-exhausted",
          },
        ],
      });
    },
  );

  it("cancels an oversized streamed page and retains earlier findings", async () => {
    const cancel = vi.fn();
    const source = createSourceFetch({
      page: (url) => {
        if (!url.searchParams.has("after")) {
          return Response.json([advisory()], { headers: { link: NEXT_PAGE } });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
            },
            cancel,
          }),
        );
      },
    });
    const report = await scan(source.fetchImpl);
    expect(cancel).toHaveBeenCalledOnce();
    expect(report.advisories).toHaveLength(1);
    expect(report.coverage.status).toBe("partial");
    expect(report.coverage.checkedRepositories).toBe(0);
  });

  it.each(["request", "run"])(
    "settles a stalled page at the %s deadline and preserves findings",
    async (deadline) => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const realSetTimeout = globalThis.setTimeout;
      const requestedTimeouts: Array<number | undefined> = [];
      // Exercise the real timeout race without a 15-second wait or shared fake timers.
      vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, milliseconds, ...args) => {
        requestedTimeouts.push(milliseconds);
        return realSetTimeout(callback, milliseconds === 15_000 ? 1 : milliseconds, ...args);
      });
      const cancel = vi.fn();
      const source = createSourceFetch({
        page: (url) => {
          if (!url.searchParams.has("after")) {
            if (deadline === "run") {
              now = 5 * 60_000 - 5;
            }
            return Response.json([advisory()], { headers: { link: NEXT_PAGE } });
          }
          if (deadline === "request") {
            // A transport that ignores AbortSignal must not prevent the report from settling.
            return new Promise<Response>(() => {});
          }
          now = 5 * 60_000;
          return new Response(new ReadableStream<Uint8Array>({ cancel }));
        },
      });
      const report = await scan(source.fetchImpl);
      expect(requestedTimeouts.at(-1)).toBe(deadline === "run" ? 5 : 15_000);
      expect(cancel).toHaveBeenCalledTimes(deadline === "run" ? 1 : 0);
      expect(report.advisories).toHaveLength(1);
      expect(report.coverage).toMatchObject({
        status: "partial",
        checkedRepositories: 0,
        issues: [
          {
            subject: REPOSITORY,
            reason: deadline === "run" ? "budget-exhausted" : "request-failed",
          },
        ],
      });
    },
  );

  it("bounds input and total requests instead of silently dropping uninspected packages", async () => {
    const versions = Array.from({ length: 2501 }, (_, index) => `1.0.${index}`);
    const source = createSourceFetch({
      manifest: (url) =>
        manifest(url, `https://github.com/fixture/package-${url.pathname.split("/").at(-1)}`),
    });
    const report = await scan(source.fetchImpl, { fixture: versions });
    expect(source.calls.filter(({ url }) => url.origin === REGISTRY)).toHaveLength(2500);
    expect(source.calls).toHaveLength(4000);
    expect(report.coverage).toMatchObject({
      status: "partial",
      packageVersions: 2501,
      mappedPackageVersions: 2500,
    });
    expect(report.coverage.issues).toContainEqual({
      subject: "1 package versions not inspected",
      reason: "budget-exhausted",
    });
    expect(
      report.coverage.issues.some(
        ({ subject, reason }) =>
          subject.startsWith("fixture/package-") && reason === "budget-exhausted",
      ),
    ).toBe(true);
  });

  it("keeps metadata and repository requests within four concurrent operations", async () => {
    let active = 0;
    let peak = 0;
    const source = createSourceFetch({
      manifest: (url) => manifest(url, `https://github.com/fixture/${url.pathname.split("/")[1]}`),
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await Promise.resolve();
        return await source.fetchImpl(input, init);
      } finally {
        active -= 1;
      }
    };
    const payload = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`package-${index}`, ["1.0.0"]]),
    );
    const report = await scan(fetchImpl, payload);
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(report.coverage.status).toBe("checked");
    expect(report.coverage.checkedRepositories).toBe(8);
  });

  it.each([
    { code: 403, remaining: "0", reason: "rate-limited" },
    { code: 429, remaining: "0", reason: "rate-limited" },
    { code: 403, remaining: "100", reason: "request-failed" },
    { code: 401, remaining: "100", reason: "request-failed" },
  ])(
    "stops scheduling GitHub work after HTTP $code (remaining $remaining)",
    async ({ code, remaining, reason: expectedReason }) => {
      const source = createSourceFetch({
        manifest: (url) =>
          manifest(url, `https://github.com/fixture/${url.pathname.split("/")[1]}`),
        page: () =>
          new Response(null, { status: code, headers: { "x-ratelimit-remaining": remaining } }),
      });
      const payload = Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [`package-${index}`, ["1.0.0"]]),
      );
      const report = await scan(source.fetchImpl, payload);
      expect(source.calls.filter(({ url }) => url.origin === REGISTRY)).toHaveLength(8);
      expect(
        source.calls.some(({ url }) =>
          /\/repos\/fixture\/package-[4-7](?:\/|$)/u.test(url.pathname),
        ),
      ).toBe(false);
      expect(report.coverage.status).toBe("partial");
      expect(report.coverage.issues.some(({ reason }) => reason === expectedReason)).toBe(true);
    },
  );
});
