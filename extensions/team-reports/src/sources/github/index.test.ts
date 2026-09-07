import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceRuntime } from "../../types.js";
import { createGithubSource } from "./index.js";
import {
  advisory,
  at,
  commit,
  config,
  emptyRoute,
  issue,
  issuesUpdatedAfterWindow,
  json,
  logger,
  repo,
  roster,
  sinceMs,
  untilMs,
  window,
} from "./responses.fixtures.js";

function source(
  route: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  signal?: AbortSignal,
) {
  const logs = { ...logger, info: vi.fn() };
  const fetchImpl = vi.fn<NonNullable<SourceRuntime["fetchImpl"]>>((input, init) =>
    Promise.resolve(route(new URL(input), init)),
  );
  return { api: createGithubSource({ logger: logs, fetchImpl, signal }), fetchImpl, logs };
}

afterEach(() => vi.useRealTimers());

describe("GitHub reports source", () => {
  it("resolves relative next-page links against the current endpoint on GHES", async () => {
    const { api, fetchImpl } = source((url) => {
      expect(url.pathname).toBe("/api/v3/orgs/example/teams/builders/members");
      return url.searchParams.has("page")
        ? json([{ login: "reviewer" }])
        : json([{ login: "builder" }], { Link: '<?page=2&per_page=100>; rel="next"' });
    });
    const result = await api.loadRoster({ ...config, apiBaseUrl: "https://github.test/api/v3" });
    expect(result.status.ok).toBe(true);
    expect(result.people.map((person) => person.github[0])).toEqual(["builder", "reviewer"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("paginates teams and direct collaborators, keeping only write access and eligible repos", async () => {
    const { api, fetchImpl, logs } = source((url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${config.token}`);
      expect(headers.get("accept")).toBe("application/vnd.github+json");
      expect(headers.get("x-github-api-version")).toBe("2022-11-28");
      if (url.pathname.endsWith("/members")) {
        return url.searchParams.has("page")
          ? json([{ login: "reviewer" }])
          : json([{ login: "builder" }], { Link: `<${url}&page=2>; rel="next"` });
      }
      if (url.pathname.endsWith("/repos")) {
        return json([repo(), repo("old", true), repo("excluded")]);
      }
      if (url.pathname.endsWith("/collaborators")) {
        expect(url.searchParams.get("affiliation")).toBe("direct");
        return json([
          { login: "helper", permissions: { push: true } },
          { login: "owner", permissions: { admin: true } },
          { login: "maintainer", permissions: { maintain: true } },
          { login: "reader", permissions: { pull: true } },
        ]);
      }
      throw new Error("Unexpected request");
    });
    const result = await api.loadRoster({
      ...config,
      includeDirectCollaborators: true,
      excludeRepos: ["example/excluded"],
    });
    expect(result.status.ok).toBe(true);
    expect(result.people.map((person) => person.github[0])).toEqual([
      "builder",
      "helper",
      "maintainer",
      "owner",
      "reviewer",
    ]);
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url).includes("/collaborators")),
    ).toHaveLength(1);
    expect(logs.info.mock.calls).toEqual([["team-reports: GitHub roster loaded: 5 people"]]);
  });

  it("qualifies every issue search by type for fine-grained tokens", async () => {
    const { api, fetchImpl } = source(emptyRoute);
    const result = await api.collect(config, window, roster);
    const queries = fetchImpl.mock.calls
      .map(([input]) => new URL(input))
      .filter((url) => url.pathname === "/search/issues")
      .map((url) => url.searchParams.get("q") ?? "");

    expect(result.status.warnings).toEqual([]);
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query).toMatch(/(?:^|\s)is:(?:issue|pull-request)(?=\s|$)/);
      if (query.includes(" merged:")) {
        expect(query).toContain(" is:pull-request ");
      }
    }
    expect(queries).toEqual([
      "org:example is:issue created:2026-08-20T00:00:00.000Z..2026-08-20T23:59:59.000Z",
      "org:example is:pull-request created:2026-08-20T00:00:00.000Z..2026-08-20T23:59:59.000Z",
      "org:example is:issue closed:2026-08-20T00:00:00.000Z..2026-08-20T23:59:59.000Z",
      "org:example is:pull-request closed:2026-08-20T00:00:00.000Z..2026-08-20T23:59:59.000Z",
      "org:example is:pull-request merged:2026-08-20T00:00:00.000Z..2026-08-20T23:59:59.000Z",
    ]);
  });

  it("credits event dates despite later updates and deduplicates overlapping searches", async () => {
    const { opened, merged, openedAndClosed } = issuesUpdatedAfterWindow;
    const { api, fetchImpl } = source((url) => {
      if (url.pathname === "/search/issues") {
        const query = url.searchParams.get("q") ?? "";
        const items = query.includes(" is:issue created:")
          ? [opened, openedAndClosed]
          : query.includes(" is:issue closed:")
            ? [openedAndClosed]
            : query.includes(" is:pull-request closed:") ||
                query.includes(" is:pull-request merged:")
              ? [merged]
              : [];
        return json({ total_count: items.length, items });
      }
      if (url.pathname === "/repos/example/app/pulls/2") {
        return json({ merged_by: { login: "reviewer" } });
      }
      return emptyRoute(url);
    });
    const result = await api.collect(config, window, roster);
    expect(result.items).toEqual([
      expect.objectContaining({ kind: "issue_opened", number: 1, actor: "builder" }),
      expect.objectContaining({ kind: "pr_merged", number: 2, actor: "reviewer" }),
      expect.objectContaining({ kind: "issue_closed", number: 3, actor: "builder" }),
      expect.objectContaining({ kind: "issue_opened", number: 3, actor: "builder" }),
    ]);
    expect(result.status.warnings).toEqual([]);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("/pulls/2"))).toHaveLength(
      1,
    );
  });

  it.each([
    ["created", "issue"],
    ["created", "pull-request"],
    ["closed", "issue"],
    ["closed", "pull-request"],
    ["merged", "pull-request"],
  ])(
    "splits and paginates capped %s is:%s searches, warns on incomplete results and deduplicates PR lookups",
    async (qualifier, type) => {
      const merged = { ...issue(2), pull_request: { merged_at: at }, closed_at: at };
      const oldMerge = {
        ...issue(3),
        created_at: "2026-08-19T00:00:00Z",
        pull_request: { merged_at: "2026-08-19T01:00:00Z" },
        closed_at: "2026-08-19T01:00:00Z",
      };
      let searches = 0;
      const queries: string[] = [];
      const { api, fetchImpl } = source((url) => {
        if (url.pathname === "/search/issues") {
          const query = url.searchParams.get("q") ?? "";
          queries.push(query);
          if (!query.includes(` is:${type} ${qualifier}:`)) {
            const items = query.includes(" is:pull-request ") ? [merged] : [];
            return json({ total_count: items.length, items });
          }
          searches++;
          if (searches === 1) {
            return json({ total_count: 1000, items: [] });
          }
          if (searches === 2) {
            return json(
              { total_count: 3, items: [type === "issue" ? issue() : merged] },
              { Link: `<${url}&page=2>; rel="next"` },
            );
          }
          if (searches === 3) {
            return json({
              total_count: 3,
              incomplete_results: true,
              items: type === "issue" ? [issue()] : [oldMerge, merged],
            });
          }
          return json({ total_count: 0, items: [] });
        }
        if (url.pathname === "/repos/example/app/pulls/2") {
          return json({ merged_by: { login: "reviewer" } });
        }
        return emptyRoute(url);
      });
      const result = await api.collect(config, window, roster);
      expect(result.items.filter((item) => item.kind === "pr_merged")).toEqual([
        expect.objectContaining({ actor: "reviewer", number: 2, atMs: Date.parse(at) }),
      ]);
      expect(result.items.some((item) => item.kind === "pr_closed")).toBe(false);
      expect(result.status.stats.searchSplits).toBe(1);
      expect(result.status.stale).toBe(true);
      expect(result.status.warnings).toEqual([
        expect.stringContaining("incomplete search results"),
      ]);
      expect(queries).toHaveLength(8);
      expect(queries.filter((query) => query.includes(` is:${type} ${qualifier}:`))).toEqual([
        `org:example is:${type} ${qualifier}:2026-08-20T00:00:00.000Z..2026-08-20T23:59:59.000Z`,
        `org:example is:${type} ${qualifier}:2026-08-20T00:00:00.000Z..2026-08-20T11:59:59.000Z`,
        `org:example is:${type} ${qualifier}:2026-08-20T00:00:00.000Z..2026-08-20T11:59:59.000Z`,
        `org:example is:${type} ${qualifier}:2026-08-20T12:00:00.000Z..2026-08-20T23:59:59.000Z`,
      ]);
      expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("/pulls/2"))).toHaveLength(
        1,
      );
      expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/pulls/3"))).toBe(false);
    },
  );

  it("collects commit coauthors from mapped login and noreply trailers, dropping unknown names", async () => {
    const { api, logs } = source((url) =>
      url.pathname.endsWith("/commits")
        ? json([
            commit(
              "abc",
              "Fix parsing\n\nCo-authored-by: @reviewer <r@example.test>\nCo-authored-by: Helper Name <123+helper@users.noreply.github.com>\nCo-authored-by: reviewer <r@example.test>\nCo-authored-by: Unknown Person <x@example.test>\nCo-authored-by: stranger <x@example.test>\nCo-authored-by: Guest Person <456+guest@users.noreply.github.com>\nCo-authored-by: @visitor <v@example.test>",
            ),
          ])
        : emptyRoute(url),
    );
    const result = await api.collect(config, window, roster);
    expect(result.items).toEqual([
      expect.objectContaining({
        kind: "commit",
        actor: "builder",
        title: "Fix parsing",
        coauthors: ["guest", "helper", "reviewer", "visitor"],
      }),
    ]);
    expect(result.status.stats.commitStrategy).toBe("per-repo");
    expect(logs.info).toHaveBeenCalledWith("team-reports: GitHub commits done: per-repo, 1 items");
  });

  it("splits commit searches and paginates their result pages", async () => {
    let searches = 0;
    const { api } = source((url) => {
      if (url.pathname === "/orgs/example/repos") {
        return json(Array.from({ length: 12 }, (_, i) => repo(`app${i}`)));
      }
      if (url.pathname === "/search/commits") {
        expect(url.searchParams.get("q")).toContain(" committer-date:");
        searches++;
        if (searches === 1) {
          return json({ total_count: 1000, items: [] });
        }
        if (searches === 2) {
          return json(
            { total_count: 2, items: [commit("later", "Later", "app0")] },
            { Link: `<${url}&page=2>; rel="next"` },
          );
        }
        if (searches === 3) {
          return json({ total_count: 2, items: [commit("earlier", "Earlier", "app0")] });
        }
        return json({ total_count: 0, items: [] });
      }
      return emptyRoute(url);
    });
    const result = await api.collect(config, window, roster);
    expect(result.items.map((item) => item.title)).toEqual(["Earlier", "Later"]);
    expect(result.status.stats.searchSplits).toBe(1);
    expect(result.status.stats.commitStrategy).toBe("search");
    expect(searches).toBe(4);
  });

  it("skips excluded and archived search results, isolates repo failures and keeps comment bodies", async () => {
    const { api } = source((url) => {
      if (url.pathname === "/orgs/example/repos") {
        return json([repo(), repo("other"), repo("old", true), repo("excluded")]);
      }
      if (
        url.pathname === "/search/issues" &&
        url.searchParams.get("q")?.includes(" is:issue created:")
      ) {
        return json({
          total_count: 4,
          items: [issue(), issue(1, "other"), issue(3, "old"), issue(4, "excluded")],
        });
      }
      if (url.pathname === "/repos/example/app/issues/comments") {
        return json({ message: config.token }, {}, 403);
      }
      if (url.pathname === "/repos/example/other/issues/comments") {
        return json([
          {
            user: { login: "reviewer" },
            body: " Full body ",
            created_at: at,
            html_url: "https://github.test/comment/1",
          },
          {
            user: { login: "reviewer" },
            body: "outside",
            created_at: new Date(untilMs).toISOString(),
            html_url: "https://github.test/comment/2",
          },
        ]);
      }
      return emptyRoute(url);
    });
    const result = await api.collect(
      { ...config, excludeRepos: ["example/excluded"] },
      window,
      roster,
    );
    expect(result.status.ok).toBe(true);
    expect(result.status.warnings).toEqual([expect.stringContaining("example/app")]);
    expect(JSON.stringify(result.status)).not.toContain(config.token);
    expect(result.items.map((item) => item.repo)).not.toContain("example/old");
    expect(result.items.map((item) => item.repo)).not.toContain("example/excluded");
    expect(result.items.filter((item) => item.kind === "issue_opened")).toHaveLength(2);
    expect(result.items.filter((item) => item.kind === "issue_comment")).toEqual([
      expect.objectContaining({ body: " Full body ", actor: "reviewer" }),
    ]);
  });

  it.each([
    ["issues/comments", "issue_comment"],
    ["pulls/comments", "review_comment"],
  ])("bounds %s titles while preserving full comment bodies", async (endpoint, kind) => {
    const comments = [
      { body: "  First\t  line  \r\nFull body stays here", title: "First line" },
      { body: "x".repeat(140), title: "x".repeat(140) },
      { body: `${"x".repeat(141)}\nMore details`, title: `${"x".repeat(139)}…` },
      { body: "🇦🇹".repeat(140), title: "🇦🇹".repeat(140) },
      { body: `${"🇦🇹".repeat(141)}\nMore details`, title: `${"🇦🇹".repeat(139)}…` },
      { body: "e\u0301".repeat(140), title: "e\u0301".repeat(140) },
      { body: `${"e\u0301".repeat(141)}\nMore details`, title: `${"e\u0301".repeat(139)}…` },
      { body: " \t\nLater line", title: "Comment" },
      { body: "", title: "Comment" },
      { body: null, title: "Comment" },
    ];
    const { api } = source((url) => {
      if (url.pathname === `/repos/example/app/${endpoint}`) {
        return json(
          comments.map(({ body }, index) => ({
            user: { login: "reviewer" },
            body,
            created_at: at,
            html_url: `https://github.test/comment/${index}`,
          })),
        );
      }
      return emptyRoute(url);
    });
    const result = await api.collect(config, window, roster);
    expect(result.status.ok).toBe(true);
    expect(result.items).toEqual(
      comments.map(({ body, title }, index) =>
        expect.objectContaining({
          kind,
          title,
          body: body ?? "",
          url: `https://github.test/comment/${index}`,
        }),
      ),
    );
  });

  it.each([
    { shape: "repository credits", credits: advisory.credits, actors: ["helper", "reviewer"] },
    {
      shape: "nested users",
      credits: [{ user: { login: "reviewer" } }, { user: { login: "reviewer" } }],
      actors: ["helper", "reviewer"],
    },
    {
      shape: "mixed credits with nested user precedence",
      credits: [
        { login: "ignored", user: { login: "reviewer" } },
        { login: "builder", user: null },
      ],
      actors: ["builder", "helper", "reviewer"],
    },
    { shape: "null credits", credits: null, actors: ["helper"] },
    { shape: "omitted credits", credits: undefined, actors: ["helper"] },
  ])(
    "accepts advisory $shape and attributes visible actors without stale warnings",
    async ({ credits, actors }) => {
      const { api } = source((url) =>
        url.pathname.endsWith("/security-advisories")
          ? json([{ ...advisory, credits }])
          : emptyRoute(url),
      );
      const result = await api.collect(config, window, roster);
      expect(result.status.warnings).toEqual([]);
      expect(result.status.stale).not.toBe(true);
      expect(result.items.map(({ kind, actor }) => ({ kind, actor }))).toEqual(
        actors.map((actor) => ({ kind: "security_advisory", actor })),
      );
    },
  );

  it.each([403, 404])(
    "skips unreadable advisories (HTTP %s) without marking the day stale",
    async (httpStatus) => {
      const { api, logs } = source((url) => {
        if (url.pathname === "/orgs/example/repos") {
          return json([repo(), repo("other")]);
        }
        if (url.pathname.endsWith("/security-advisories")) {
          return url.pathname.includes("/app/")
            ? json({ message: config.token }, {}, httpStatus)
            : json([advisory]);
        }
        return emptyRoute(url);
      });
      const result = await api.collect(config, window, roster);
      expect(result.status.ok).toBe(true);
      expect(result.status.warnings).toEqual([]);
      expect(result.status.stale).not.toBe(true);
      expect(result.status.stats.advisoriesSkipped).toBe(1);
      expect(result.items).toEqual([
        expect.objectContaining({
          kind: "security_advisory",
          repo: "example/other",
          actor: "helper",
        }),
        expect.objectContaining({
          kind: "security_advisory",
          repo: "example/other",
          actor: "reviewer",
        }),
      ]);
      expect(logs.info).toHaveBeenCalledWith(
        expect.stringMatching(/^team-reports: .*1.*no advisories visible/),
      );
      expect(JSON.stringify([result.status, logs.info.mock.calls])).not.toContain(config.token);
    },
  );

  it.each([401, 500])(
    "keeps advisory HTTP %s failures visible as stale warnings",
    async (httpStatus) => {
      vi.useFakeTimers();
      const { api } = source((url) =>
        url.pathname.endsWith("/security-advisories")
          ? json({ message: config.token }, {}, httpStatus)
          : emptyRoute(url),
      );
      const pending = api.collect(config, window, roster);
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(result.status.stale).toBe(true);
      expect(result.status.warnings).toEqual([
        `Advisories for example/app: HTTP ${httpStatus}; check token permissions and repository access`,
      ]);
      expect(result.status.stats.advisoriesSkipped).toBe(0);
    },
  );

  it("emits opened/closed events and advisory credit within half-open windows", async () => {
    const { api, logs } = source((url) => {
      if (url.pathname === "/search/issues" && url.searchParams.get("q")?.includes(" created:")) {
        const items = url.searchParams.get("q")?.includes(" is:pull-request ")
          ? [{ ...issue(2), pull_request: { merged_at: null }, closed_at: at }]
          : [
              { ...issue(), created_at: new Date(sinceMs).toISOString(), closed_at: at },
              { ...issue(3), created_at: new Date(untilMs).toISOString() },
            ];
        return json({
          total_count: items.length,
          items,
        });
      }
      if (url.pathname.endsWith("/security-advisories")) {
        return json([
          {
            ...advisory,
            credits: [{ user: { login: "reviewer" } }, { user: { login: "reviewer" } }],
          },
        ]);
      }
      return emptyRoute(url);
    });
    const result = await api.collect(config, window, roster);
    expect(result.items.filter((item) => item.number === 3)).toHaveLength(0);
    expect(result.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining([
        "issue_opened",
        "issue_closed",
        "pr_opened",
        "pr_closed",
        "security_advisory",
      ]),
    );
    expect(
      result.items.filter((item) => item.kind === "security_advisory").map((item) => item.actor),
    ).toEqual(["helper", "reviewer"]);
    expect(logs.info.mock.calls).toEqual([
      ["team-reports: GitHub repos listed: 1"],
      ["team-reports: GitHub issue searches done: 4 items"],
      ["team-reports: GitHub commits done: per-repo, 0 items"],
      ["team-reports: GitHub comments/advisories scanned: 1 repos"],
    ]);
  });

  it.each([403, 429])("waits for the rate reset on HTTP %s and records quota", async (code) => {
    vi.useFakeTimers();
    vi.setSystemTime(sinceMs);
    let calls = 0;
    const { api } = source(() => {
      calls++;
      return calls === 1
        ? json(
            {},
            {
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": String((sinceMs + 2000) / 1000),
              "Retry-After": "1",
            },
            code,
          )
        : json([{ login: "builder" }], { "X-RateLimit-Remaining": "4999" });
    });
    const pending = api.loadRoster(config);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(calls).toBe(2);
    expect(result.status.stats.apiCalls).toBe(2);
    expect(result.status.stats.rateLimitRemaining).toBe(4999);
  });

  it("never includes transport failures or server payloads in logs and status", async () => {
    const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const api = createGithubSource({
      logger: logs,
      fetchImpl: async () => {
        throw new Error(`transport ${config.token}`);
      },
    });
    const result = await api.loadRoster(config);
    expect(result.status.ok).toBe(false);
    expect(result.status.warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify([result, logs.warn.mock.calls, logs.error.mock.calls])).not.toContain(
      config.token,
    );
  });

  it("aborts between pages without fetching the next page or exposing abort reasons", async () => {
    const controller = new AbortController();
    const { api, fetchImpl } = source((url) => {
      controller.abort(new Error(config.token));
      return json([{ login: "builder" }], { Link: `<${url}&page=2>; rel="next"` });
    }, controller.signal);
    await expect(api.loadRoster(config)).rejects.toThrow("aborted");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["created", "issue"],
    ["created", "pull-request"],
    ["closed", "issue"],
    ["closed", "pull-request"],
    ["merged", "pull-request"],
  ])(
    "aborts a %s is:%s search without fetching more pages or searches",
    async (qualifier, type) => {
      const controller = new AbortController();
      const queries: string[] = [];
      const { api, fetchImpl } = source((url) => {
        if (url.pathname === "/search/issues") {
          const query = url.searchParams.get("q") ?? "";
          queries.push(query);
          if (query.includes(` is:${type} ${qualifier}:`)) {
            controller.abort(new Error(config.token));
            return json(
              { total_count: 2, items: [issue()] },
              { Link: `<${url}&page=2>; rel="next"` },
            );
          }
        }
        return emptyRoute(url);
      }, controller.signal);
      await expect(api.collect(config, window, roster)).rejects.toThrow(
        "GitHub collection aborted",
      );
      expect(queries.at(-1)).toContain(` is:${type} ${qualifier}:`);
      expect(fetchImpl).toHaveBeenCalledTimes(queries.length + 1);
    },
  );

  it("cancels a rate limit sleep promptly", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { api, fetchImpl } = source(
      () => json({}, { "Retry-After": "3600" }, 429),
      controller.signal,
    );
    const pending = api.loadRoster(config);
    const rejected = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await rejected;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses cross-origin pagination before forwarding credentials", async () => {
    const { api, fetchImpl } = source(() =>
      json([{ login: "builder" }], { Link: '<https://elsewhere.test/members>; rel="next"' }),
    );
    const result = await api.loadRoster(config);
    expect(result.status.ok).toBe(false);
    expect(result.status.warnings.length).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
