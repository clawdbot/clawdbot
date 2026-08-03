// Barnacle Auto Response tests cover barnacle auto response script behavior.
import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  candidateLabels,
  classifyPullRequestCandidateLabels,
  managedLabelSpecs,
  runBarnacleAutoResponse,
} from "../../scripts/github/barnacle-auto-response.mjs";
import {
  PROOF_OVERRIDE_LABEL,
  PROOF_SUFFICIENT_LABEL,
} from "../../scripts/github/real-behavior-proof-policy.mjs";

const clawSweeperProofSuppliedLabel = "proof: supplied";
const blankTemplateBody = readFileSync(
  new URL("../../.github/pull_request_template.md", import.meta.url),
  "utf8",
);

function pr(title: string, body = blankTemplateBody) {
  return {
    title,
    body,
  };
}

function prContextBody(evidence: string, overrides: Record<string, string> = {}) {
  const fields = {
    problem: "Gateway status did not report the Discord channel as ready.",
    evidence,
    ...overrides,
  };
  return [
    "## What Problem This Solves",
    "",
    fields.problem,
    "",
    "## Evidence",
    "",
    fields.evidence,
  ].join("\n");
}

function file(filename: string, status = "modified") {
  return {
    filename,
    status,
  };
}

function barnacleContext(
  pullRequest: Record<string, unknown>,
  labels: string[] = [],
  options: Record<string, unknown> = {},
) {
  return {
    repo: {
      owner: "openclaw",
      repo: "openclaw",
    },
    payload: {
      action: options.action ?? "opened",
      label: options.label,
      sender: options.sender,
      pull_request: {
        number: 123,
        title: "Cleanup plugin docs",
        body: blankTemplateBody,
        author_association: "CONTRIBUTOR",
        user: {
          login: "contributor",
        },
        labels: labels.map((name) => ({ name })),
        ...pullRequest,
      },
    },
  };
}

function barnacleIssueContext(
  issue: Record<string, unknown>,
  labels: string[] = [],
  options: Record<string, unknown> = {},
) {
  return {
    repo: {
      owner: "openclaw",
      repo: "openclaw",
    },
    payload: {
      action: options.action ?? "opened",
      label: options.label,
      sender: options.sender,
      issue: {
        number: 456,
        title: "OpenClaw issue",
        body: "",
        author_association: "CONTRIBUTOR",
        user: {
          login: "contributor",
        },
        labels: labels.map((name) => ({ name })),
        ...issue,
      },
      comment: options.comment,
    },
  };
}

function barnacleGithub(
  files: ReturnType<typeof file>[],
  options: {
    maintainerLogins?: string[];
    removeLabelNotFound?: string[];
    repositoryRoles?: Record<string, string>;
    comments?: Array<{
      body: string;
      performed_via_github_app?: { slug: string };
      user?: { login: string; type: string };
    }>;
  } = {},
) {
  const maintainerLogins = new Set(
    (options.maintainerLogins ?? []).map((login) => login.toLowerCase()),
  );
  const removeLabelNotFound = new Set(options.removeLabelNotFound ?? []);
  const repositoryRoles = Object.fromEntries(
    Object.entries(options.repositoryRoles ?? {}).map(([login, role]) => [
      login.toLowerCase(),
      role,
    ]),
  );
  const calls = {
    addLabels: [] as Array<{ issue_number: number; labels: string[] }>,
    createComment: [] as Array<{ issue_number: number; body: string }>,
    lock: [] as Array<{ issue_number: number; lock_reason?: string }>,
    removeLabel: [] as Array<{ issue_number: number; name: string }>,
    update: [] as Array<{ issue_number: number; state?: string }>,
  };
  const listFiles = async () => files;
  const listComments = async () => options.comments ?? [];
  const github = {
    paginate: async (fn: unknown) => (fn === listComments ? (options.comments ?? []) : files),
    rest: {
      issues: {
        addLabels: async (params: { issue_number: number; labels: string[] }) => {
          calls.addLabels.push(params);
        },
        createComment: async (params: { issue_number: number; body: string }) => {
          calls.createComment.push(params);
        },
        createLabel: async () => undefined,
        getLabel: async (params: { name: string }) => ({
          data: {
            color:
              managedLabelSpecs[params.name as keyof typeof managedLabelSpecs]?.color ?? "C5DEF5",
            description:
              managedLabelSpecs[params.name as keyof typeof managedLabelSpecs]?.description ?? "",
          },
        }),
        listComments,
        lock: async (params: { issue_number: number; lock_reason?: string }) => {
          calls.lock.push(params);
        },
        removeLabel: async (params: { issue_number: number; name: string }) => {
          calls.removeLabel.push(params);
          if (removeLabelNotFound.has(params.name)) {
            const error = new Error("not found") as Error & { status: number };
            error.status = 404;
            throw error;
          }
        },
        update: async (params: { issue_number: number; state?: string }) => {
          calls.update.push(params);
        },
        updateLabel: async () => undefined,
      },
      pulls: {
        listFiles,
      },
      repos: {
        getCollaboratorPermissionLevel: async ({ username }: { username: string }) => {
          const role = repositoryRoles[username.toLowerCase()] ?? "read";
          return {
            data: {
              permission: role,
              role_name: role,
            },
          };
        },
      },
      teams: {
        getMembershipForUserInOrg: async ({ username }: { username: string }) => {
          if (maintainerLogins.has(username.toLowerCase())) {
            return {
              data: {
                state: "active",
              },
            };
          }
          const error = new Error("not found") as Error & { status: number };
          error.status = 404;
          throw error;
        },
      },
    },
  };
  return { calls, github };
}

function expectedIssueUpdate(issue_number: number, state: string) {
  return {
    owner: "openclaw",
    repo: "openclaw",
    issue_number,
    state,
  };
}

function expectedRemoveLabel(issue_number: number, name: string) {
  return {
    owner: "openclaw",
    repo: "openclaw",
    issue_number,
    name,
  };
}

function expectedAddLabels(issue_number: number, labels: string[]) {
  return {
    owner: "openclaw",
    repo: "openclaw",
    issue_number,
    labels,
  };
}

function managedLabelDescription(label: string): string {
  return expectDefined(managedLabelSpecs[label], `managed label ${label}`).description;
}

describe("barnacle-auto-response", () => {
  it("keeps Barnacle-owned labels documented and ClawHub spelled correctly", () => {
    expect(managedLabelDescription("r: skill")).toContain("ClawHub");
    expect(managedLabelDescription("r: skill")).not.toContain("Clawdhub");
    expect(managedLabelDescription("dirty")).toContain("dirty/unrelated");
    expect(managedLabelDescription("r: support")).toContain("support requests");
    expect(managedLabelDescription("r: false-positive")).toContain("false positive");
    expect(managedLabelDescription("r: third-party-extension")).toContain("ClawHub");
    expect(managedLabelDescription("r: bluebubbles")).toContain("deprecated");
    expect(managedLabelDescription("r: too-many-prs")).toContain("twenty active PRs");
    for (const label of Object.values(candidateLabels)) {
      expect(managedLabelSpecs).toHaveProperty(label);
      expect(managedLabelDescription(label)).toMatch(/^Candidate:/);
    }
  });

  it("labels docs-only discoverability churn without closing it", () => {
    const labels = classifyPullRequestCandidateLabels(pr("Update README translation"), [
      file("README.md"),
    ]);

    expect(labels).toEqual([
      candidateLabels.blankTemplate,
      candidateLabels.needsPrContext,
      candidateLabels.lowSignalDocs,
      candidateLabels.docsDiscoverability,
    ]);
  });

  it("does not treat template boilerplate as behavior evidence for test-only churn", () => {
    const labels = classifyPullRequestCandidateLabels(pr("Add test coverage"), [
      file("src/gateway/foo.test.ts"),
    ]);

    expect(labels).toEqual([
      candidateLabels.blankTemplate,
      candidateLabels.needsPrContext,
      candidateLabels.testOnlyNoBug,
    ]);
  });

  it("uses the latest case-insensitive context sections after template boilerplate", () => {
    const body = [
      blankTemplateBody,
      "## What problem this solves",
      "",
      "Gateway status did not report the Discord channel as ready.",
      "",
      "## evidence",
      "",
      "pnpm test passed.",
    ].join("\n\n");
    const labels = classifyPullRequestCandidateLabels(pr("Fix gateway status", body), [
      file("src/gateway/server.ts"),
    ]);

    expect(labels).not.toContain(clawSweeperProofSuppliedLabel);
    expect(labels).not.toContain(candidateLabels.blankTemplate);
    expect(labels).not.toContain(candidateLabels.needsPrContext);
  });

  it("labels external PRs that are missing context or evidence", () => {
    const labels = classifyPullRequestCandidateLabels(pr("Fix gateway startup"), [
      file("src/gateway/server.ts"),
    ]);

    expect(labels).toContain(candidateLabels.needsPrContext);
  });

  it("accepts focused test evidence without assigning a proof label", () => {
    const labels = classifyPullRequestCandidateLabels(
      pr("Fix gateway startup", prContextBody("pnpm test passed with Vitest mocks.")),
      [file("src/gateway/server.ts")],
    );

    expect(labels).not.toContain(clawSweeperProofSuppliedLabel);
    expect(labels).not.toContain(candidateLabels.needsPrContext);
  });

  it("accepts external PR evidence without assigning a proof label", () => {
    const labels = classifyPullRequestCandidateLabels(
      pr(
        "Fix gateway startup",
        prContextBody("![after](https://github.com/user-attachments/assets/gateway-ready)"),
      ),
      [file("src/gateway/server.ts")],
    );

    expect(labels).not.toContain(clawSweeperProofSuppliedLabel);
    expect(labels).not.toContain(candidateLabels.needsPrContext);
  });

  it("accepts CRLF-formatted screenshot evidence without assigning a proof label", () => {
    const labels = classifyPullRequestCandidateLabels(
      pr(
        "Fix gateway startup",
        prContextBody("![after](https://github.com/user-attachments/assets/gateway-ready)").replace(
          /\n/g,
          "\r\n",
        ),
      ),
      [file("src/gateway/server.ts")],
    );

    expect(labels).not.toContain(clawSweeperProofSuppliedLabel);
    expect(labels).not.toContain(candidateLabels.needsPrContext);
  });

  it("uses linked issues as context and suppresses low-signal docs labels", () => {
    const labels = classifyPullRequestCandidateLabels(
      pr("Update docs", `${blankTemplateBody}\n\nRelated #12345`),
      [file("docs/plugins/community.md")],
    );

    expect(labels).not.toContain(candidateLabels.lowSignalDocs);
    expect(labels).not.toContain(candidateLabels.docsDiscoverability);
  });

  it("warns on broad high-surface PRs instead of auto-closing them as dirty", () => {
    const labels = classifyPullRequestCandidateLabels(pr("Cleanup plugin docs"), [
      file("ui/src/app.ts"),
      file("src/gateway/server.ts"),
      file("extensions/slack/src/index.ts"),
      file("docs/plugins/community.md"),
    ]);

    expect(labels).toContain(candidateLabels.dirtyCandidate);
  });

  it("suppresses dirty-candidate when the PR has concrete behavior context", () => {
    const body = [
      "- Problem: gateway crashes when plugin metadata is missing",
      "- Why it matters: users lose the running session",
      "- What changed: add a guard around metadata loading",
    ].join("\n");

    const labels = classifyPullRequestCandidateLabels(pr("Fix gateway crash", body), [
      file("ui/src/app.ts"),
      file("src/gateway/server.ts"),
      file("extensions/slack/src/index.ts"),
      file("docs/plugins/community.md"),
    ]);

    expect(labels).not.toContain(candidateLabels.dirtyCandidate);
  });

  it("does not classify a linked core plugin auto-enable fix as an external plugin candidate", () => {
    const labels = classifyPullRequestCandidateLabels(
      pr(
        "Fix duplicate plugin auto-enable entries",
        [
          "- Problem: openclaw doctor --fix adds duplicate installed plugin entries",
          "- Why it matters: users get noisy config churn",
          "- What changed: respect manifest-provided channel auto-loads",
          "",
          "Fixes #37548",
          "",
          "This touches external plugin install state but fixes core config repair behavior.",
        ].join("\n"),
      ),
      [
        file("src/config/plugin-auto-enable.shared.ts"),
        file("src/config/plugin-auto-enable.channels.test.ts"),
        file("src/config/plugin-auto-enable.test-helpers.ts"),
      ],
    );

    expect(labels).not.toContain(candidateLabels.externalPluginCandidate);
  });

  it("does not mutate maintainer-authored PRs", async () => {
    const { calls, github } = barnacleGithub([
      file("ui/src/app.ts"),
      file("src/gateway/server.ts"),
      file("extensions/slack/src/index.ts"),
      file("docs/plugins/community.md"),
    ]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext({
        author_association: "OWNER",
        user: {
          login: "maintainer",
        },
      }),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.addLabels).toStrictEqual([]);
    expect(calls.createComment).toStrictEqual([]);
    expect(calls.removeLabel).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("leaves stale Barnacle labels alone on maintainer-authored PRs", async () => {
    const { calls, github } = barnacleGithub([
      file("ui/src/app.ts"),
      file("src/gateway/server.ts"),
      file("extensions/slack/src/index.ts"),
      file("docs/plugins/community.md"),
    ]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext(
        {
          author_association: "OWNER",
          user: {
            login: "maintainer",
          },
        },
        [candidateLabels.dirtyCandidate, "r: too-many-prs"],
      ),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.addLabels).toStrictEqual([]);
    expect(calls.createComment).toStrictEqual([]);
    expect(calls.removeLabel).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("does not mutate maintainer-authored issues", async () => {
    const { calls, github } = barnacleGithub([]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleIssueContext({
        title: "TestFlight access",
        author_association: "OWNER",
        user: {
          login: "maintainer",
        },
      }),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.addLabels).toStrictEqual([]);
    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("does not action close labels on maintainer-authored issues", async () => {
    const { calls, github } = barnacleGithub([]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleIssueContext(
        {
          title: "Need help with setup",
          author_association: "MEMBER",
          user: {
            login: "maintainer",
          },
        },
        ["r: support"],
        {
          action: "labeled",
          label: { name: "r: support" },
        },
      ),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("closes issues tagged as false positives", async () => {
    const { calls, github } = barnacleGithub([]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleIssueContext({}, ["r: false-positive"], {
        action: "labeled",
        label: { name: "r: false-positive" },
        sender: { login: "maintainer", type: "User" },
      }),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0]?.issue_number).toBe(456);
    expect(calls.createComment[0]?.body).toContain("false positive");
    expect(calls.update).toStrictEqual([expectedIssueUpdate(456, "closed")]);
  });

  it("does not respond to maintainer comments on contributor items", async () => {
    const { calls, github } = barnacleGithub([], { maintainerLogins: ["maintainer"] });

    await runBarnacleAutoResponse({
      github,
      context: barnacleIssueContext(
        {
          title: "Contributor issue",
          user: {
            login: "contributor",
          },
        },
        [],
        {
          action: "created",
          comment: {
            body: "testflight",
            user: {
              login: "maintainer",
              type: "User",
            },
          },
        },
      ),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("does not close automation PRs for the active PR limit", async () => {
    for (const automationPullRequest of [
      { head: { ref: "clawsweeper/openclaw-openclaw-73880" }, login: "app/openclaw-clawsweeper" },
      { headRefName: "clawsweeper/openclaw-openclaw-73880", login: "app/openclaw-clawsweeper" },
      {
        head: { ref: "clownfish/ghcrawl-156993-autonomous-smoke" },
        login: "app/openclaw-clownfish",
      },
      { headRefName: "clownfish/ghcrawl-156993-autonomous-smoke", login: "app/openclaw-clownfish" },
    ]) {
      const { calls, github } = barnacleGithub([]);
      const { login, ...pullRequest } = automationPullRequest;

      await runBarnacleAutoResponse({
        github,
        context: barnacleContext(
          {
            ...pullRequest,
            user: {
              login,
            },
          },
          ["r: too-many-prs"],
        ),
        core: {
          info: () => undefined,
        },
      });

      expect(calls.removeLabel).toStrictEqual([expectedRemoveLabel(123, "r: too-many-prs")]);
      expect(
        calls.createComment.every((call) => !call.body.includes("more than 20 active PRs")),
      ).toBe(true);
      expect(calls.update).toStrictEqual([]);
    }
  });

  it("removes stale PR-limit labels from GitHub App-authored PRs", async () => {
    const { calls, github } = barnacleGithub([file("README.md")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext(
        {
          user: {
            login: "renovate[bot]",
            type: "Bot",
          },
        },
        ["r: too-many-prs"],
      ),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).toStrictEqual([expectedRemoveLabel(123, "r: too-many-prs")]);
    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("does not close GitHub App-authored PRs when stale PR-limit label removal returns 404", async () => {
    const { calls, github } = barnacleGithub([file("README.md")], {
      removeLabelNotFound: ["r: too-many-prs"],
    });

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext(
        {
          user: {
            login: "renovate[bot]",
            type: "Bot",
          },
        },
        ["r: too-many-prs"],
      ),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).toStrictEqual([expectedRemoveLabel(123, "r: too-many-prs")]);
    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("still adds candidate labels to broad contributor PRs", async () => {
    const { calls, github } = barnacleGithub([
      file("ui/src/app.ts"),
      file("src/gateway/server.ts"),
      file("extensions/slack/src/index.ts"),
      file("docs/plugins/community.md"),
    ]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext({}),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.addLabels).toStrictEqual([
      expectedAddLabels(123, [
        candidateLabels.blankTemplate,
        candidateLabels.needsPrContext,
        candidateLabels.refactorOnly,
        candidateLabels.dirtyCandidate,
      ]),
    ]);
    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("adds proof labels to external PRs without auto-closing by default", async () => {
    const { calls, github } = barnacleGithub([file("src/gateway/server.ts")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext({}),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.addLabels).toStrictEqual([
      expectedAddLabels(123, [
        candidateLabels.blankTemplate,
        candidateLabels.needsPrContext,
        candidateLabels.refactorOnly,
      ]),
    ]);
    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("removes stale context labels without changing ClawSweeper proof labels", async () => {
    const { calls, github } = barnacleGithub([file("src/gateway/server.ts")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext(
        {
          body: prContextBody("pnpm test passed."),
        },
        [
          candidateLabels.needsPrContext,
          "triage: mock-only-proof",
          clawSweeperProofSuppliedLabel,
          PROOF_SUFFICIENT_LABEL,
          PROOF_OVERRIDE_LABEL,
        ],
      ),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).toStrictEqual([
      expectedRemoveLabel(123, candidateLabels.needsPrContext),
    ]);
    expect(calls.update).toStrictEqual([]);
  });

  it("preserves manually applied sufficient proof label when override is added", async () => {
    const { calls, github } = barnacleGithub([file("src/gateway/server.ts")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext(
        {
          body: prContextBody("![after](https://github.com/user-attachments/assets/gateway-ready)"),
        },
        [PROOF_OVERRIDE_LABEL, PROOF_SUFFICIENT_LABEL],
        {
          action: "labeled",
          label: { name: PROOF_OVERRIDE_LABEL },
          sender: { login: "maintainer", type: "User" },
        },
      ),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).toEqual([]);
    expect(calls.addLabels).toEqual([]);
    expect(calls.update).toEqual([]);
  });

  it("removes stale context labels without adding proof labels", async () => {
    const { calls, github } = barnacleGithub([file("src/gateway/server.ts")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext(
        {
          body: prContextBody("![after](https://github.com/user-attachments/assets/gateway-ready)"),
        },
        [candidateLabels.needsPrContext, "triage: mock-only-proof"],
      ),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).toStrictEqual([
      expectedRemoveLabel(123, candidateLabels.needsPrContext),
    ]);
    expect(calls.addLabels).toStrictEqual([]);
  });

  it.each(["edited", "synchronize"])(
    "preserves ClawSweeper sufficient proof labels after PR %s events",
    async (action) => {
      const { calls, github } = barnacleGithub([file("src/gateway/server.ts")]);

      await runBarnacleAutoResponse({
        github,
        context: barnacleContext(
          {
            body: prContextBody(
              "![after](https://github.com/user-attachments/assets/gateway-ready)",
            ),
          },
          [clawSweeperProofSuppliedLabel, PROOF_SUFFICIENT_LABEL],
          { action },
        ),
        core: {
          info: () => undefined,
        },
      });

      expect(calls.removeLabel).toEqual([]);
    },
  );

  it("preserves sufficient proof on synchronize when ClawSweeper passed the exact head", async () => {
    const headSha = "06ee95df6608d29a395c52ba8ab53fdd93a9dc4f";
    const { calls, github } = barnacleGithub([file("src/gateway/server.ts")], {
      comments: [
        {
          user: {
            login: "clawsweeper[bot]",
            type: "Bot",
          },
          performed_via_github_app: {
            slug: "clawsweeper",
          },
          body: `<!-- clawsweeper-verdict:pass item=123 sha=${headSha} confidence=high -->`,
        },
      ],
    });

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext(
        {
          body: blankTemplateBody,
          head: { sha: headSha },
        },
        [PROOF_SUFFICIENT_LABEL],
        { action: "synchronize" },
      ),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).not.toContainEqual(
      expect.objectContaining({ name: PROOF_SUFFICIENT_LABEL }),
    );
  });

  it("preserves sufficient proof on synchronize when the matching marker is forged", async () => {
    const headSha = "06ee95df6608d29a395c52ba8ab53fdd93a9dc4f";
    const { calls, github } = barnacleGithub([file("src/gateway/server.ts")], {
      comments: [
        {
          user: {
            login: "external-contributor",
            type: "User",
          },
          body: `<!-- clawsweeper-verdict:pass item=123 sha=${headSha} confidence=high -->`,
        },
      ],
    });

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext(
        {
          body: blankTemplateBody,
          head: { sha: headSha },
        },
        [PROOF_SUFFICIENT_LABEL],
        { action: "synchronize" },
      ),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).toEqual([]);
  });

  it("preserves stale sufficient proof while ClawSweeper automerge owns the PR", async () => {
    const { calls, github } = barnacleGithub([file("src/gateway/server.ts")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext(
        {
          head: {
            ref: "fix/memory-search-event-loop-yield-81172",
            sha: "0ede3d716805e7d2ced8df37c6666af510dc9e19",
          },
          body: prContextBody("![after](https://github.com/user-attachments/assets/gateway-ready)"),
        },
        [clawSweeperProofSuppliedLabel, PROOF_SUFFICIENT_LABEL, "clawsweeper:automerge"],
        { action: "synchronize" },
      ),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).toEqual([]);
  });

  it("preserves stale sufficient proof on ClawSweeper branch updates", async () => {
    const { calls, github } = barnacleGithub([file("src/gateway/server.ts")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext(
        {
          head: {
            ref: "clawsweeper/repair-pr-83758",
            sha: "0ede3d716805e7d2ced8df37c6666af510dc9e19",
          },
          body: prContextBody("![after](https://github.com/user-attachments/assets/gateway-ready)"),
        },
        [clawSweeperProofSuppliedLabel, PROOF_SUFFICIENT_LABEL],
        { action: "synchronize" },
      ),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).toEqual([]);
  });

  it("preserves stale sufficient proof on ClawSweeper-authored PR updates", async () => {
    const { calls, github } = barnacleGithub([file("src/gateway/server.ts")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext(
        {
          body: prContextBody("![after](https://github.com/user-attachments/assets/gateway-ready)"),
          user: {
            login: "clawsweeper[bot]",
            type: "Bot",
          },
        },
        [clawSweeperProofSuppliedLabel, PROOF_SUFFICIENT_LABEL],
        { action: "synchronize" },
      ),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).not.toContainEqual(
      expect.objectContaining({ name: PROOF_SUFFICIENT_LABEL }),
    );
  });

  it("preserves ClawSweeper's sufficient proof label on ordinary label events", async () => {
    const { calls, github } = barnacleGithub([file("src/gateway/server.ts")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext(
        {
          body: prContextBody("![after](https://github.com/user-attachments/assets/gateway-ready)"),
        },
        [clawSweeperProofSuppliedLabel, PROOF_SUFFICIENT_LABEL],
        {
          action: "labeled",
          label: { name: PROOF_SUFFICIENT_LABEL },
          sender: { login: "openclaw-clawsweeper[bot]", type: "Bot" },
        },
      ),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).toEqual([]);
  });

  it("adds missing context labels even when proof is sufficient", async () => {
    const { calls, github } = barnacleGithub([file("src/gateway/server.ts")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext({}, [PROOF_SUFFICIENT_LABEL], {
        action: "labeled",
        label: { name: "status: ready for maintainer look" },
        sender: { login: "openclaw-clawsweeper[bot]", type: "Bot" },
      }),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).toEqual([]);
    expect(calls.addLabels.flatMap((call) => call.labels)).toContain(
      candidateLabels.needsPrContext,
    );
  });

  it("re-adds missing context labels while sufficient proof is present", async () => {
    const { calls, github } = barnacleGithub([file("src/gateway/server.ts")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext({}, [PROOF_SUFFICIENT_LABEL], {
        action: "unlabeled",
        label: { name: candidateLabels.needsPrContext },
        sender: { login: "maintainer", type: "User" },
      }),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).toEqual([]);
    expect(calls.addLabels.flatMap((call) => call.labels)).toContain(
      candidateLabels.needsPrContext,
    );
  });

  it("keeps context labels when sufficient proof is already present", async () => {
    const { calls, github } = barnacleGithub([file("src/gateway/server.ts")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext({}, [PROOF_SUFFICIENT_LABEL, candidateLabels.needsPrContext], {
        action: "labeled",
        label: { name: "status: ready for maintainer look" },
        sender: { login: "openclaw-clawsweeper[bot]", type: "Bot" },
      }),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).toEqual([]);
    expect(calls.addLabels.flatMap((call) => call.labels)).not.toContain(
      candidateLabels.needsPrContext,
    );
  });

  it("does not let Barnacle veto ClawSweeper's sufficient proof label add", async () => {
    const { calls, github } = barnacleGithub([file("src/gateway/server.ts")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext({}, [PROOF_SUFFICIENT_LABEL], {
        action: "labeled",
        label: { name: PROOF_SUFFICIENT_LABEL },
        sender: { login: "openclaw-clawsweeper[bot]", type: "Bot" },
      }),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).toEqual([]);
    expect(calls.addLabels).toEqual([]);
    expect(calls.update).toEqual([]);
  });

  it("actions manually applied candidate labels", async () => {
    const { calls, github } = barnacleGithub([file("extensions/example/openclaw.plugin.json")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext({}, [candidateLabels.externalPluginCandidate], {
        action: "labeled",
        label: { name: candidateLabels.externalPluginCandidate },
        sender: { login: "maintainer", type: "User" },
      }),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0]?.issue_number).toBe(123);
    expect(calls.createComment[0]?.body).toContain("ClawHub");
    expect(calls.update).toStrictEqual([expectedIssueUpdate(123, "closed")]);
  });

  it("closes manually labeled BlueBubbles requests with imsg migration guidance", async () => {
    const { calls, github } = barnacleGithub([]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleIssueContext({}, ["r: bluebubbles"], {
        action: "labeled",
        label: { name: "r: bluebubbles" },
        sender: { login: "maintainer", type: "User" },
      }),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0]?.issue_number).toBe(456);
    expect(calls.createComment[0]?.body).toContain("/channels/imessage");
    expect(calls.update).toStrictEqual([expectedIssueUpdate(456, "closed")]);
  });

  it("keeps bot-applied candidate labels passive", async () => {
    const { calls, github } = barnacleGithub([file("extensions/example/openclaw.plugin.json")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext({}, [candidateLabels.externalPluginCandidate], {
        action: "labeled",
        label: { name: candidateLabels.externalPluginCandidate },
        sender: { login: "openclaw-bot[bot]", type: "Bot" },
      }),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.createComment).toStrictEqual([]);
    expect(calls.update).toStrictEqual([]);
  });

  it("actions existing candidate labels when a maintainer adds trigger-response", async () => {
    const { calls, github } = barnacleGithub([file("src/gateway/foo.test.ts")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext({}, [candidateLabels.testOnlyNoBug, "trigger-response"], {
        action: "labeled",
        label: { name: "trigger-response" },
        sender: { login: "maintainer", type: "User" },
      }),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).toStrictEqual([expectedRemoveLabel(123, "trigger-response")]);
    expect(calls.createComment).toHaveLength(1);
    expect(calls.createComment[0]?.issue_number).toBe(123);
    expect(calls.createComment[0]?.body).toContain("lacks a clear problem statement or evidence");
    expect(calls.update).toStrictEqual([expectedIssueUpdate(123, "closed")]);
  });
});
