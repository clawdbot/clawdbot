import { describe, expect, it } from "vitest";
import { runPrConvergenceAuditCli } from "../../scripts/pr-convergence-audit-cli.mjs";

const repo = "openclaw/openclaw";
const pr = 42;
const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function createProvider({ withPass }: { withPass: boolean }) {
  return {
    async fetchPullRequest() {
      return {
        number: pr,
        html_url: `https://github.com/${repo}/pull/${pr}`,
        head: { sha: headSha, ref: "feat/audit" },
        last_edited_at: null,
      };
    },
    async fetchFormalReviews() {
      return { items: [], complete: true };
    },
    async fetchInlineReviewComments() {
      return { items: [], complete: true };
    },
    async fetchIssueComments() {
      return {
        items: withPass
          ? [
              {
                id: 1,
                html_url: `https://github.com/${repo}/pull/${pr}#issuecomment-1`,
                created_at: "2026-08-10T00:00:00Z",
                updated_at: "2026-08-10T00:00:00Z",
                user: { login: "clawsweeper[bot]", type: "Bot" },
                performed_via_github_app: { slug: "clawsweeper" },
                body: `<!-- clawsweeper-verdict:pass item=${pr} sha=${headSha} confidence=high -->`,
              },
            ]
          : [],
        complete: true,
      };
    },
    async fetchRequestedReviewers() {
      return { logins: [], complete: true };
    },
    async fetchCheckRuns() {
      return { items: [], complete: true, requiredPolicy: "resolved" as const };
    },
  };
}

describe("PR convergence audit CLI", () => {
  it("returns success and structured JSON only for READY", async () => {
    let output = "";
    const status = await runPrConvergenceAuditCli({
      argv: [String(pr), "--repo", repo],
      provider: createProvider({ withPass: true }),
      resolveRepo: () => {
        throw new Error("explicit repository should be used");
      },
      write: (value) => {
        output += value;
      },
    });

    expect(status).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ decision: "READY", pr, repo, headSha });
  });

  it("returns a failing status with structured UNKNOWN evidence", async () => {
    let output = "";
    const status = await runPrConvergenceAuditCli({
      argv: [String(pr), "--repo", repo],
      provider: createProvider({ withPass: false }),
      write: (value) => {
        output += value;
      },
    });

    expect(status).toBe(1);
    expect(JSON.parse(output)).toMatchObject({
      decision: "UNKNOWN",
      reason: expect.stringContaining("No trusted exact-head ClawSweeper pass"),
    });
  });
});
