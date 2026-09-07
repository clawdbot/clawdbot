import { z } from "zod";
import { truncateGraphemes } from "../../text.js";
import type {
  ActivityWindow,
  GithubItem,
  GithubSource,
  GithubSourceConfig,
  Person,
  Roster,
  SourceRuntime,
  SourceStatus,
} from "../../types.js";
import { checkAbort } from "../http.js";
import { ABORT_LABEL, GithubClient, GithubHttpError, parse, pathWithQuery } from "./client.js";
import {
  advisorySchema,
  collaboratorSchema,
  commentSchema,
  commitSchema,
  issueSchema,
  pullSchema,
  repoSchema,
  searchCommitSchema,
  userSchema,
} from "./schemas.js";
import { search, searchPath, searchSeconds } from "./search.js";

type Repository = z.infer<typeof repoSchema>;

function newStatus(): SourceStatus {
  return {
    ok: true,
    warnings: [],
    stats: { apiCalls: 0, reposScanned: 0, searchSplits: 0, advisoriesSkipped: 0 },
  };
}

function repoPath(repo: string): string {
  return `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;
}

function inWindow(date: string | null | undefined, window: ActivityWindow): boolean {
  const atMs = date ? Date.parse(date) : Number.NaN;
  return atMs >= window.sinceMs && atMs < window.untilMs;
}

function commentTitle(body: string | null | undefined): string {
  const firstLine =
    body
      ?.split(/\r\n?|\n/, 1)[0]
      ?.trim()
      .replace(/\s+/g, " ") || "Comment";
  return truncateGraphemes(firstLine, 140);
}

async function listRepos(
  client: GithubClient,
  cfg: GithubSourceConfig,
): Promise<Map<string, Repository>> {
  const repos = new Map<string, Repository>();
  const excluded = new Set(cfg.excludeRepos.map((repo) => repo.toLowerCase()));
  for (const org of new Set(cfg.orgs)) {
    await client.attempt(
      `List repositories for ${org}`,
      async () => {
        for await (const repo of client.pages(
          pathWithQuery(`/orgs/${encodeURIComponent(org)}/repos`, { type: "all" }),
          repoSchema,
        )) {
          if (!repo.archived && !excluded.has(repo.full_name.toLowerCase())) {
            repos.set(repo.full_name.toLowerCase(), repo);
          }
        }
      },
      true,
    );
  }
  return repos;
}

function coauthors(message: string, roster: Roster): string[] {
  const logins = new Set<string>();
  for (const match of message.matchAll(
    /^Co-authored-by:[ \t]*(.*?)[ \t]*(?:<([^<>\r\n]+)>)?[ \t]*$/gim,
  )) {
    const name = match[1]?.trim() ?? "";
    const email = match[2]?.trim() ?? "";
    const fromEmail = /^(?:\d+\+)?([a-z\d-]+)@users\.noreply\.github\.com$/i.exec(email)?.[1];
    const fromName = /^@?([a-z\d-]+)$/i.exec(name)?.[1];
    const login = (fromEmail ?? fromName)?.toLowerCase();
    if (login && (fromEmail || name.startsWith("@") || roster.byLogin.has(login))) {
      logins.add(login);
    }
  }
  return [...logins].toSorted();
}

export function createGithubSource(runtime: SourceRuntime): GithubSource {
  return {
    async loadRoster(cfg) {
      const status = newStatus();
      const client = new GithubClient(cfg, runtime, status);
      const people = new Map<string, Person>();
      const add = (login: string) => people.set(login.toLowerCase(), { github: [login] });
      for (const team of cfg.teams) {
        await client.attempt(
          `Load team ${team.org}/${team.slug}`,
          async () => {
            for await (const user of client.pages(
              pathWithQuery(
                `/orgs/${encodeURIComponent(team.org)}/teams/${encodeURIComponent(team.slug)}/members`,
                {},
              ),
              userSchema,
            )) {
              add(user.login);
            }
          },
          true,
        );
      }
      if (cfg.includeDirectCollaborators) {
        for (const repo of (await listRepos(client, cfg)).values()) {
          await client.attempt(
            `Load collaborators for ${repo.full_name}`,
            async () => {
              for await (const user of client.pages(
                pathWithQuery(`${repoPath(repo.full_name)}/collaborators`, {
                  affiliation: "direct",
                }),
                collaboratorSchema,
              )) {
                if (
                  user.permissions?.push ||
                  user.permissions?.maintain ||
                  user.permissions?.admin
                ) {
                  add(user.login);
                }
              }
            },
            true,
          );
        }
      }
      checkAbort(runtime.signal, ABORT_LABEL);
      runtime.logger.info(`team-reports: GitHub roster loaded: ${people.size} people`);
      return {
        people: [...people]
          .toSorted(([a], [b]) => a.localeCompare(b, "en"))
          .map(([, person]) => person),
        status,
      };
    },

    async collect(cfg, window, roster) {
      const status = newStatus();
      const client = new GithubClient(cfg, runtime, status);
      checkAbort(runtime.signal, ABORT_LABEL);
      if (
        !Number.isFinite(window.sinceMs) ||
        !Number.isFinite(window.untilMs) ||
        window.untilMs <= window.sinceMs
      ) {
        throw new Error("Invalid GitHub activity window");
      }
      const repos = await listRepos(client, cfg);
      runtime.logger.info(`team-reports: GitHub repos listed: ${repos.size}`);
      const items = new Map<string, GithubItem>();
      const active = new Set<string>();
      const updatedRepos = new Set<string>();
      // updated_at is an item's LAST update, so a later edit would hide in-window comments during
      // historical regeneration; bound discovery by now and let the comment endpoints filter events.
      const discoveryWindow: ActivityWindow = {
        sinceMs: window.sinceMs,
        untilMs: Math.max(window.untilMs, Date.now()),
      };
      const seenIssues = new Set<string>();
      const add = (item: GithubItem) => {
        checkAbort(runtime.signal, ABORT_LABEL);
        if (item.atMs >= window.sinceMs && item.atMs < window.untilMs) {
          items.set(`${item.kind}\0${item.url}\0${item.actor.toLowerCase()}\0${item.atMs}`, item);
        }
      };
      const addCommit = (repo: string, commit: z.infer<typeof commitSchema>) => {
        const date = commit.commit.committer?.date;
        if (!inWindow(date, window)) {
          return;
        }
        active.add(repo.toLowerCase());
        add({
          kind: "commit",
          repo,
          title: commit.commit.message.split(/\r?\n/, 1)[0] ?? "",
          url: commit.html_url,
          atMs: Date.parse(date ?? ""),
          actor: commit.author?.login ?? "",
          coauthors: coauthors(commit.commit.message, roster),
        });
      };
      const collectRepoCommits = async (candidates: Repository[]) => {
        for (const repo of candidates) {
          await client.attempt(`Commits for ${repo.full_name}`, async () => {
            for await (const commit of client.pages(
              pathWithQuery(`${repoPath(repo.full_name)}/commits`, {
                since: new Date(window.sinceMs).toISOString(),
                until: new Date(window.untilMs).toISOString(),
              }),
              commitSchema,
            )) {
              addCommit(repo.full_name, commit);
            }
          });
        }
      };
      const orgCandidates = new Map<string, Repository[]>();
      for (const org of new Set(cfg.orgs)) {
        const orgRepos = [...repos.values()].filter(
          (repo) =>
            repo.full_name.slice(0, repo.full_name.indexOf("/")).toLowerCase() ===
            org.toLowerCase(),
        );
        if (orgRepos.length === 0) {
          continue;
        }
        // pushed_at also discovers commit-only repos; do not require issue activity to scan commits.
        const candidates = orgRepos.filter(
          (repo) => !repo.pushed_at || Date.parse(repo.pushed_at) >= window.sinceMs,
        );
        orgCandidates.set(org, candidates);
        for (const repo of candidates) {
          active.add(repo.full_name.toLowerCase());
        }
        for (const [qualifier, type] of [
          ["created", "issue"],
          ["created", "pull-request"],
          ["closed", "issue"],
          ["closed", "pull-request"],
          ["merged", "pull-request"],
        ] as const) {
          await client.attempt(`${type} ${qualifier} search for ${org}`, async () => {
            for await (const issue of search(
              client,
              { kind: "issues", qualifier, type },
              org,
              window,
              issueSchema,
            )) {
              const repoName = /\/repos\/([^/]+\/[^/]+)\/?$/
                .exec(issue.repository_url)?.[1]
                ?.toLowerCase();
              const repo = repoName ? repos.get(repoName) : undefined;
              if (!repo) {
                continue;
              }
              const key = `${repo.full_name.toLowerCase()}#${issue.number}`;
              if (seenIssues.has(key)) {
                continue;
              }
              // Deduplicate event searches before emitting events or looking up the merger.
              seenIssues.add(key);
              active.add(repo.full_name.toLowerCase());
              const common = {
                repo: repo.full_name,
                number: issue.number,
                title: issue.title,
                url: issue.html_url,
                actor: issue.user?.login ?? "",
              };
              if (inWindow(issue.created_at, window)) {
                add({
                  ...common,
                  kind: issue.pull_request ? "pr_opened" : "issue_opened",
                  atMs: Date.parse(issue.created_at),
                });
              }
              if (issue.pull_request?.merged_at) {
                if (!inWindow(issue.pull_request.merged_at, window)) {
                  continue;
                }
                let actor: string | undefined;
                await client.attempt(`Merger for ${key}`, async () => {
                  const pull = parse(
                    pullSchema,
                    (await client.get(`${repoPath(repo.full_name)}/pulls/${issue.number}`)).data,
                  );
                  actor = pull.merged_by?.login;
                });
                if (actor) {
                  add({
                    ...common,
                    actor,
                    kind: "pr_merged",
                    atMs: Date.parse(issue.pull_request.merged_at),
                  });
                }
              } else if (inWindow(issue.closed_at, window)) {
                add({
                  ...common,
                  kind: issue.pull_request ? "pr_closed" : "issue_closed",
                  atMs: Date.parse(issue.closed_at ?? ""),
                });
              }
            }
          });
        }
        for (const type of ["issue", "pull-request"] as const) {
          await client.attempt(`${type} updated search for ${org}`, async () => {
            for await (const issue of search(
              client,
              { kind: "issues", qualifier: "updated", type },
              org,
              discoveryWindow,
              issueSchema,
            )) {
              const repoName = /\/repos\/([^/]+\/[^/]+)\/?$/
                .exec(issue.repository_url)?.[1]
                ?.toLowerCase();
              if (repoName && repos.has(repoName)) {
                updatedRepos.add(repoName);
              }
            }
          });
        }
      }
      runtime.logger.info(
        `team-reports: GitHub issue searches done: ${items.size} items, ${updatedRepos.size} updated-search repos`,
      );
      const strategies = new Set<string>();
      for (const [org, candidates] of orgCandidates) {
        if (candidates.length === 0) {
          continue;
        }
        if (candidates.length === 1) {
          // A single REST list costs no more requests and avoids the smaller search quota.
          strategies.add("per-repo");
          await collectRepoCommits(candidates);
        } else {
          await client.attempt(`Commit search for ${org}`, async () => {
            const first = await client.get(
              searchPath(
                { kind: "commits", qualifier: "committer-date" },
                org,
                ...searchSeconds(window),
              ),
            );
            const count = parse(
              z.object({ total_count: z.number().int().nonnegative() }),
              first.data,
            ).total_count;
            // Reuse the probe when search is cheaper; prefer repo lists when estimated search pages exceed repo count.
            if (Math.ceil(count / 100) > candidates.length) {
              strategies.add("per-repo");
              await collectRepoCommits(candidates);
            } else {
              strategies.add("search");
              for await (const commit of search(
                client,
                { kind: "commits", qualifier: "committer-date" },
                org,
                window,
                searchCommitSchema,
                first,
              )) {
                const repo = repos.get(commit.repository.full_name.toLowerCase());
                if (repo) {
                  addCommit(repo.full_name, commit);
                }
              }
            }
          });
        }
      }
      status.stats.commitStrategy = strategies.size > 1 ? "mixed" : ([...strategies][0] ?? "none");
      runtime.logger.info(
        `team-reports: GitHub commits done: ${status.stats.commitStrategy}, ${[...items.values()].filter((item) => item.kind === "commit").length} items`,
      );
      for (const key of updatedRepos) {
        active.add(key);
      }
      for (const key of [...active].toSorted()) {
        const repo = repos.get(key);
        if (!repo) {
          continue;
        }
        status.stats.reposScanned = Number(status.stats.reposScanned) + 1;
        for (const [endpoint, kind] of [
          ["issues/comments", "issue_comment"],
          ["pulls/comments", "review_comment"],
        ] as const) {
          await client.attempt(`${kind} for ${repo.full_name}`, async () => {
            for await (const comment of client.pages(
              pathWithQuery(`${repoPath(repo.full_name)}/${endpoint}`, {
                since: new Date(window.sinceMs).toISOString(),
              }),
              commentSchema,
            )) {
              if (inWindow(comment.created_at, window)) {
                add({
                  kind,
                  repo: repo.full_name,
                  title: commentTitle(comment.body),
                  body: comment.body ?? "",
                  url: comment.html_url,
                  atMs: Date.parse(comment.created_at),
                  actor: comment.user?.login ?? "",
                });
              }
            }
          });
        }
      }
      let advisoryReposScanned = 0;
      for (const [, repo] of [...repos].toSorted(([a], [b]) => a.localeCompare(b, "en"))) {
        advisoryReposScanned++;
        await client.attempt(`Advisories for ${repo.full_name}`, async () => {
          try {
            for await (const advisory of client.pages(
              pathWithQuery(`${repoPath(repo.full_name)}/security-advisories`, {
                sort: "updated",
                direction: "desc",
              }),
              advisorySchema,
            )) {
              // Newest-first updates let us stop before fetching any older pages.
              if (advisory.updated_at && Date.parse(advisory.updated_at) < window.sinceMs) {
                break;
              }
              const date = inWindow(advisory.updated_at, window)
                ? advisory.updated_at
                : advisory.published_at;
              if (!inWindow(date, window)) {
                continue;
              }
              const actors = new Set(
                [
                  advisory.publisher?.login,
                  ...(advisory.credits ?? []).map((credit) => credit.user?.login ?? credit.login),
                ].filter((login): login is string => Boolean(login)),
              );
              for (const actor of actors) {
                add({
                  kind: "security_advisory",
                  repo: repo.full_name,
                  title: advisory.summary,
                  url: advisory.html_url,
                  atMs: Date.parse(date ?? ""),
                  actor,
                });
              }
            }
          } catch (error) {
            checkAbort(runtime.signal, ABORT_LABEL);
            if (
              error instanceof GithubHttpError &&
              (error.status === 403 || error.status === 404)
            ) {
              status.stats.advisoriesSkipped = Number(status.stats.advisoriesSkipped) + 1;
            } else {
              throw error;
            }
          }
        });
      }
      checkAbort(runtime.signal, ABORT_LABEL);
      runtime.logger.info(
        `team-reports: GitHub comments scanned: ${status.stats.reposScanned} repos; advisories scanned: ${advisoryReposScanned} repos`,
      );
      if (Number(status.stats.advisoriesSkipped) > 0) {
        runtime.logger.info(
          `team-reports: GitHub advisories skipped: ${status.stats.advisoriesSkipped} repos (HTTP 403/404; no advisories visible)`,
        );
      }
      return {
        items: [...items.values()].toSorted(
          (a, b) =>
            a.atMs - b.atMs ||
            a.url.localeCompare(b.url, "en") ||
            a.kind.localeCompare(b.kind, "en") ||
            a.actor.localeCompare(b.actor, "en"),
        ),
        status,
      };
    },
  };
}
