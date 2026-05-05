import { describe, expect, it } from "vitest";
import {
  candidateLabels,
  classifyPullRequestCandidateLabels,
  managedLabelSpecs,
  runBarnacleAutoResponse,
} from "../../scripts/github/barnacle-auto-response.mjs";

const blankTemplateBody = [
  "## Summary",
  "",
  "Describe the problem and fix in 2–5 bullets:",
  "",
  "- Problem:",
  "- Why it matters:",
  "- What changed:",
  "- What did NOT change (scope boundary):",
  "",
  "## Linked Issue/PR",
  "",
  "- Closes #",
  "- Related #",
  "",
  "## Root Cause (if applicable)",
  "",
  "- Root cause:",
  "",
  "## Regression Test Plan (if applicable)",
  "",
  "- Target test or file:",
].join("\n");

function pr(title: string, body = blankTemplateBody) {
  return {
    title,
    body,
  };
}

function realBehaviorProofBody(evidence: string, overrides: Record<string, string> = {}) {
  const fields = {
    behavior: "Gateway status now reports the Discord channel as ready.",
    environment: "macOS 15.4, Node 24, local OpenClaw gateway, redacted Discord token.",
    steps: "pnpm openclaw gateway restart and pnpm openclaw gateway status",
    evidence,
    observedResult: "The gateway stayed connected and Discord reported ready.",
    notTested: "No known gaps.",
    ...overrides,
  };
  return [
    "## Real behavior proof",
    "",
    `- Behavior or issue addressed: ${fields.behavior}`,
    `- Real environment tested: ${fields.environment}`,
    `- Exact steps or command run after this patch: ${fields.steps}`,
    `- Evidence after fix: ${fields.evidence}`,
    `- Observed result after fix: ${fields.observedResult}`,
    `- What was not tested: ${fields.notTested}`,
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
  const github = {
    paginate: async () => files,
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
        listFiles: async () => files,
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

describe("barnacle-auto-response", () => {
  it("keeps Barnacle-owned labels documented and ClawHub spelled correctly", () => {
    expect(managedLabelSpecs["r: skill"].description).toContain("ClawHub");
    expect(managedLabelSpecs["r: skill"].description).not.toContain("Clawdhub");
    expect(managedLabelSpecs.dirty.description).toContain("dirty/unrelated");
    expect(managedLabelSpecs["r: support"].description).toContain("support requests");
    expect(managedLabelSpecs["r: false-positive"].description).toContain("false positive");
    expect(managedLabelSpecs["r: third-party-extension"].description).toContain("ClawHub");
    expect(managedLabelSpecs["r: too-many-prs"].description).toContain("twenty active PRs");

    for (const label of Object.values(candidateLabels)) {
      expect(managedLabelSpecs[label]).toBeDefined();
      expect(managedLabelSpecs[label].description).toMatch(/^Candidate:/);
    }
  });

  it("labels docs-only discoverability churn without closing it", () => {
    const labels = classifyPullRequestCandidateLabels(pr("Update README translation"), [
      file("README.md"),
    ]);

    expect(labels).toEqual(
      expect.arrayContaining([
        candidateLabels.blankTemplate,
        candidateLabels.lowSignalDocs,
        candidateLabels.docsDiscoverability,
      ]),
    );
  });

  it("does not treat template boilerplate as behavior evidence for test-only churn", () => {
    const labels = classifyPullRequestCandidateLabels(pr("Add test coverage"), [
      file("src/gateway/foo.test.ts"),
    ]);

    expect(labels).toEqual(
      expect.arrayContaining([candidateLabels.blankTemplate, candidateLabels.testOnlyNoBug]),
    );
  });

  it("labels external PRs that are missing real behavior proof", () => {
    const labels = classifyPullRequestCandidateLabels(pr("Fix gateway startup"), [
      file("src/gateway/server.ts"),
    ]);

    expect(labels).toContain(candidateLabels.needsRealBehaviorProof);
    expect(labels).not.toContain(candidateLabels.mockOnlyProof);
  });

  it("labels external PRs whose proof is only tests or mocks", () => {
    const labels = classifyPullRequestCandidateLabels(
      pr(
        "Fix gateway startup",
        realBehaviorProofBody("pnpm test passed with Vitest mocks.", {
          steps: "pnpm test",
          observedResult: "CI passes.",
        }),
      ),
      [file("src/gateway/server.ts")],
    );

    expect(labels).toContain(candidateLabels.mockOnlyProof);
    expect(labels).not.toContain(candidateLabels.needsRealBehaviorProof);
  });

  it("does not label external PRs that include real behavior proof", () => {
    const labels = classifyPullRequestCandidateLabels(
      pr(
        "Fix gateway startup",
        realBehaviorProofBody("![after](https://github.com/user-attachments/assets/gateway-ready)"),
      ),
      [file("src/gateway/server.ts")],
    );

    expect(labels).not.toContain(candidateLabels.needsRealBehaviorProof);
    expect(labels).not.toContain(candidateLabels.mockOnlyProof);
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

    expect(calls.addLabels).toEqual([]);
    expect(calls.createComment).toEqual([]);
    expect(calls.removeLabel).toEqual([]);
    expect(calls.update).toEqual([]);
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

    expect(calls.addLabels).toEqual([]);
    expect(calls.createComment).toEqual([]);
    expect(calls.removeLabel).toEqual([]);
    expect(calls.update).toEqual([]);
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

    expect(calls.addLabels).toEqual([]);
    expect(calls.createComment).toEqual([]);
    expect(calls.update).toEqual([]);
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

    expect(calls.createComment).toEqual([]);
    expect(calls.update).toEqual([]);
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

    expect(calls.createComment).toContainEqual(
      expect.objectContaining({
        body: expect.stringContaining("false positive"),
      }),
    );
    expect(calls.update).toContainEqual(expect.objectContaining({ state: "closed" }));
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

    expect(calls.createComment).toEqual([]);
    expect(calls.update).toEqual([]);
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

      expect(calls.removeLabel).toContainEqual(
        expect.objectContaining({ name: "r: too-many-prs" }),
      );
      expect(calls.createComment).not.toContainEqual(
        expect.objectContaining({
          body: expect.stringContaining("more than 20 active PRs"),
        }),
      );
      expect(calls.update).not.toContainEqual(expect.objectContaining({ state: "closed" }));
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

    expect(calls.removeLabel).toContainEqual(expect.objectContaining({ name: "r: too-many-prs" }));
    expect(calls.createComment).toEqual([]);
    expect(calls.update).toEqual([]);
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

    expect(calls.removeLabel).toContainEqual(expect.objectContaining({ name: "r: too-many-prs" }));
    expect(calls.createComment).toEqual([]);
    expect(calls.update).toEqual([]);
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

    expect(calls.addLabels).toContainEqual(
      expect.objectContaining({
        labels: expect.arrayContaining([candidateLabels.dirtyCandidate]),
      }),
    );
    expect(calls.createComment).toEqual([]);
    expect(calls.update).toEqual([]);
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

    expect(calls.addLabels).toContainEqual(
      expect.objectContaining({
        labels: expect.arrayContaining([candidateLabels.needsRealBehaviorProof]),
      }),
    );
    expect(calls.createComment).toEqual([]);
    expect(calls.update).toEqual([]);
  });

  it("removes stale proof labels when override is present", async () => {
    const { calls, github } = barnacleGithub([file("src/gateway/server.ts")]);

    await runBarnacleAutoResponse({
      github,
      context: barnacleContext({}, [candidateLabels.needsRealBehaviorProof, "proof: override"]),
      core: {
        info: () => undefined,
      },
    });

    expect(calls.removeLabel).toContainEqual(
      expect.objectContaining({ name: candidateLabels.needsRealBehaviorProof }),
    );
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

    expect(calls.createComment).toContainEqual(
      expect.objectContaining({
        body: expect.stringContaining("ClawHub"),
      }),
    );
    expect(calls.update).toContainEqual(expect.objectContaining({ state: "closed" }));
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

    expect(calls.createComment).toEqual([]);
    expect(calls.update).toEqual([]);
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

    expect(calls.removeLabel).toContainEqual(expect.objectContaining({ name: "trigger-response" }));
    expect(calls.createComment).toContainEqual(
      expect.objectContaining({
        body: expect.stringContaining("does not include real behavior proof"),
      }),
    );
    expect(calls.update).toContainEqual(expect.objectContaining({ state: "closed" }));
  });
});
