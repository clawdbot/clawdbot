import { describe, expect, it } from "vitest";
import {
  createGhPrConvergenceProvider,
  resolveCurrentGitHubRepo,
} from "../../scripts/pr-convergence-provider.mjs";

const repo = "openclaw/openclaw";
const pr = 114095;
const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function createGhFixture() {
  const calls: string[][] = [];
  const readGh = (args: string[]) => {
    calls.push(args);
    if (args[0] === "repo") {
      return `${repo}\n`;
    }
    if (args[0] === "pr") {
      return JSON.stringify([
        { name: "CI", bucket: "pass", state: "SUCCESS", link: "https://example.test/ci" },
        {
          name: "Workflow Sanity",
          bucket: "pending",
          state: "PENDING",
          link: "https://example.test/sanity",
        },
      ]);
    }
    if (args[1] === "graphql") {
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              number: pr,
              url: `https://github.com/${repo}/pull/${pr}`,
              headRefName: "feat/audit",
              headRefOid: headSha,
              lastEditedAt: "2026-08-10T00:00:00Z",
              author: { login: "pr-author" },
            },
          },
        },
      });
    }
    const endpoint = args.at(-1) ?? "";
    if (endpoint.includes("requested_reviewers")) {
      return JSON.stringify([{ users: [{ login: "alice" }], teams: [{ slug: "maintainer" }] }]);
    }
    if (endpoint.includes("/reviews?")) {
      return JSON.stringify([[{ id: 1 }], [{ id: 2 }]]);
    }
    if (endpoint.includes("/pulls/") && endpoint.includes("/comments?")) {
      return JSON.stringify([[{ id: 3 }]]);
    }
    if (endpoint.includes("/issues/") && endpoint.includes("/comments?")) {
      return JSON.stringify([[{ id: 4 }]]);
    }
    throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
  };
  return { calls, readGh };
}

describe("GitHub PR convergence provider", () => {
  it("collects complete paginated review evidence and GraphQL PR edit metadata", async () => {
    const fixture = createGhFixture();
    const provider = createGhPrConvergenceProvider({ readGh: fixture.readGh });

    await expect(provider.fetchPullRequest({ repo, pr })).resolves.toEqual({
      number: pr,
      html_url: `https://github.com/${repo}/pull/${pr}`,
      head: { sha: headSha, ref: "feat/audit" },
      last_edited_at: "2026-08-10T00:00:00Z",
      user: { login: "pr-author" },
    });
    await expect(provider.fetchFormalReviews({ repo, pr })).resolves.toEqual({
      items: [{ id: 1 }, { id: 2 }],
      complete: true,
    });
    await expect(provider.fetchInlineReviewComments({ repo, pr })).resolves.toEqual({
      items: [{ id: 3 }],
      complete: true,
    });
    await expect(provider.fetchIssueComments({ repo, pr })).resolves.toEqual({
      items: [{ id: 4 }],
      complete: true,
    });
    await expect(provider.fetchRequestedReviewers({ repo, pr })).resolves.toEqual({
      logins: ["alice", "maintainer"],
      complete: true,
    });
    expect(fixture.calls.filter((args) => args.includes("--paginate"))).toHaveLength(4);
  });

  it("normalizes required checks while preserving pending status", async () => {
    const fixture = createGhFixture();
    const provider = createGhPrConvergenceProvider({ readGh: fixture.readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: [
        expect.objectContaining({
          name: "CI",
          status: "completed",
          conclusion: "success",
          head_sha: headSha,
          required: true,
        }),
        expect.objectContaining({
          name: "Workflow Sanity",
          status: "in_progress",
          conclusion: null,
          head_sha: headSha,
          required: true,
        }),
      ],
      complete: true,
      requiredPolicy: "resolved",
    });
  });

  it("accepts gh's pending-check exit status when it emitted complete JSON", async () => {
    const pending = JSON.stringify([
      { name: "CI", bucket: "pending", state: "PENDING", link: "https://example.test/ci" },
    ]);
    const readGh = (args: string[]) => {
      if (args[0] === "pr") {
        throw Object.assign(new Error("checks pending"), {
          status: 8,
          stdout: pending,
          stderr: "",
        });
      }
      throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: [
        expect.objectContaining({
          name: "CI",
          status: "in_progress",
          conclusion: null,
          required: true,
        }),
      ],
      complete: true,
      requiredPolicy: "resolved",
    });
  });

  it("treats GitHub's empty required-check report as a resolved empty policy", async () => {
    const readGh = (args: string[]) => {
      if (args[0] === "pr") {
        throw Object.assign(new Error("no required checks"), {
          status: 1,
          stdout: "",
          stderr: "no required checks reported on the 'main' branch",
        });
      }
      throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
    };
    const provider = createGhPrConvergenceProvider({ readGh });

    await expect(provider.fetchCheckRuns({ repo, pr, headSha })).resolves.toEqual({
      items: [],
      complete: true,
      requiredPolicy: "resolved",
    });
  });

  it("resolves the repository through the read-only gh seam", () => {
    const fixture = createGhFixture();
    expect(resolveCurrentGitHubRepo({ readGh: fixture.readGh })).toBe(repo);
    expect(fixture.calls[0]).toEqual([
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "--jq",
      ".nameWithOwner",
    ]);
  });
});
