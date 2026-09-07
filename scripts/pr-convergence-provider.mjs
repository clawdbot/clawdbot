import { execGhRead } from "./lib/plain-gh.mjs";

const PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      url
      headRefName
      headRefOid
      lastEditedAt
      author {
        login
      }
    }
  }
}`;

function defaultReadGh(args) {
  return execGhRead(args, { encoding: "utf8" });
}

function parseJson(raw, label) {
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
}

function splitRepo(repo) {
  const match = String(repo).match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    throw new Error(`invalid GitHub repository identity: ${repo}`);
  }
  return { owner: match[1], name: match[2] };
}

function flattenArrayPages(value, label) {
  if (!Array.isArray(value) || value.some((page) => !Array.isArray(page))) {
    throw new Error(`${label} returned an invalid paginated response`);
  }
  return value.flat();
}

function commandFailureText(error) {
  return [error?.message, error?.stderr, error?.stdout]
    .map((value) => String(value ?? ""))
    .filter(Boolean)
    .join("\n");
}

function commandFailureStdout(error) {
  return String(error?.stdout ?? "").trim();
}

function normalizeRequiredCheck(check, headSha, index) {
  const bucket = String(check?.bucket ?? "").toLowerCase();
  if (!bucket || !["pass", "fail", "pending", "skipping"].includes(bucket)) {
    throw new Error(`required check ${String(check?.name ?? index)} has an unknown bucket`);
  }
  return {
    id: `${String(check?.name ?? "check")}:${index}`,
    name: String(check?.name ?? `check-${index}`),
    status: bucket === "pending" ? "in_progress" : "completed",
    conclusion: bucket === "pending" ? null : bucket === "fail" ? "failure" : "success",
    head_sha: headSha,
    html_url: String(check?.link ?? ""),
    required: true,
  };
}

/**
 * Create the live, read-only GitHub evidence provider used by the landing gate.
 * @param {{ readGh?: (args: string[]) => string }} [options]
 */
export function createGhPrConvergenceProvider({ readGh = defaultReadGh } = {}) {
  const readJson = (args, label) => parseJson(readGh(args), label);
  const readArrayPages = (endpoint, label) =>
    flattenArrayPages(readJson(["api", "--paginate", "--slurp", endpoint], label), label);

  return {
    async fetchPullRequest({ repo, pr }) {
      const { owner, name } = splitRepo(repo);
      const response = readJson(
        [
          "api",
          "graphql",
          "-f",
          `query=${PULL_REQUEST_QUERY}`,
          "-F",
          `owner=${owner}`,
          "-F",
          `name=${name}`,
          "-F",
          `number=${pr}`,
        ],
        "pull request identity query",
      );
      if (Array.isArray(response?.errors) && response.errors.length > 0) {
        throw new Error("pull request identity query returned GraphQL errors");
      }
      const pull = response?.data?.repository?.pullRequest;
      if (!pull) {
        throw new Error(`pull request #${pr} was not found in ${repo}`);
      }
      /** @type {{
       *   number: number;
       *   html_url: string;
       *   head: { sha: string; ref: string };
       *   last_edited_at: string | null;
       *   user?: { login: string };
       * }} */
      const normalizedPull = {
        number: pull.number,
        html_url: pull.url,
        head: { sha: pull.headRefOid, ref: pull.headRefName },
        last_edited_at: pull.lastEditedAt ?? null,
        user: { login: pull.author?.login ?? "" },
      };
      return normalizedPull;
    },

    async fetchFormalReviews({ repo, pr }) {
      return {
        items: readArrayPages(`repos/${repo}/pulls/${pr}/reviews?per_page=100`, "formal reviews"),
        complete: true,
      };
    },

    async fetchInlineReviewComments({ repo, pr }) {
      return {
        items: readArrayPages(
          `repos/${repo}/pulls/${pr}/comments?per_page=100`,
          "inline review comments",
        ),
        complete: true,
      };
    },

    async fetchIssueComments({ repo, pr }) {
      return {
        items: readArrayPages(`repos/${repo}/issues/${pr}/comments?per_page=100`, "issue comments"),
        complete: true,
      };
    },

    async fetchRequestedReviewers({ repo, pr }) {
      const pages = readJson(
        [
          "api",
          "--paginate",
          "--slurp",
          `repos/${repo}/pulls/${pr}/requested_reviewers?per_page=100`,
        ],
        "requested reviewers",
      );
      if (!Array.isArray(pages) || pages.some((page) => page == null || typeof page !== "object")) {
        throw new Error("requested reviewers returned an invalid paginated response");
      }
      const logins = [];
      for (const page of pages) {
        if (Array.isArray(page.users)) {
          logins.push(...page.users.map((user) => user?.login));
        }
        if (Array.isArray(page.teams)) {
          logins.push(...page.teams.map((team) => team?.slug));
        }
      }
      if (logins.some((login) => typeof login !== "string" || !login)) {
        throw new Error("requested reviewers returned an invalid actor identity");
      }
      return { logins, complete: true };
    },

    async fetchCheckRuns({ repo, pr, headSha }) {
      let raw;
      try {
        raw = readGh([
          "pr",
          "checks",
          String(pr),
          "--repo",
          repo,
          "--required",
          "--json",
          "name,bucket,state,link",
        ]);
      } catch (error) {
        const failure = commandFailureText(error);
        if (/no required checks reported on the .+ branch/i.test(failure)) {
          return { items: [], complete: true, requiredPolicy: "resolved" };
        }
        if (error?.status !== 8 || !commandFailureStdout(error)) {
          throw error;
        }
        raw = commandFailureStdout(error);
      }
      const checks = parseJson(raw, "required checks");
      if (!Array.isArray(checks)) {
        throw new Error("required checks returned an invalid response");
      }
      return {
        items: checks.map((check, index) => normalizeRequiredCheck(check, headSha, index)),
        complete: true,
        requiredPolicy: "resolved",
      };
    },
  };
}

/** @param {{ readGh?: (args: string[]) => string }} [options] */
export function resolveCurrentGitHubRepo({ readGh = defaultReadGh } = {}) {
  const repo = readGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  splitRepo(repo);
  return repo;
}
