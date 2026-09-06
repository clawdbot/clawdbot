import type { GithubSourceConfig, Person, Roster, SourceLogger } from "../../../types.js";

export const config: GithubSourceConfig = {
  token: "synthetic-test-credential",
  orgs: ["example"],
  teams: [{ org: "example", slug: "builders" }],
  includeDirectCollaborators: false,
  excludeRepos: [],
  apiBaseUrl: "https://api.github.test",
  ignoreCommentPatterns: [],
};
export const sinceMs = Date.parse("2026-08-20T00:00:00Z");
export const untilMs = Date.parse("2026-08-21T00:00:00Z");
export const window = { sinceMs, untilMs };
export const at = "2026-08-20T12:00:00Z";
export const logger: SourceLogger = { info() {}, warn() {}, error() {} };
const people: Person[] = ["builder", "reviewer", "helper"].map((login) => ({
  github: [login],
}));
export const roster: Roster = {
  members: people,
  byLogin: new Map(
    people.flatMap((person) => person.github.map((login): [string, Person] => [login, person])),
  ),
  byDiscordId: new Map(),
};
export function repo(name = "app", archived = false) {
  return { full_name: `example/${name}`, archived, pushed_at: at };
}
export function issue(number = 1, repoName = "app") {
  return {
    number,
    title: `Issue ${number}`,
    html_url: `https://github.test/example/${repoName}/issues/${number}`,
    repository_url: `https://api.github.test/repos/example/${repoName}`,
    user: { login: "builder" },
    created_at: at,
    closed_at: null,
  };
}
export function commit(sha = "abc", message = "Ship the fix", repoName = "app") {
  return {
    sha,
    html_url: `https://github.test/example/${repoName}/commit/${sha}`,
    author: { login: "builder" },
    commit: { message, author: { date: at }, committer: { date: at } },
    repository: repo(repoName),
  };
}
export function json(body: unknown, headers?: HeadersInit, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}
export function emptyRoute(url: URL): Response {
  if (url.pathname === "/orgs/example/repos") return json([repo()]);
  if (url.pathname.startsWith("/search/")) return json({ total_count: 0, items: [] });
  return json([]);
}
