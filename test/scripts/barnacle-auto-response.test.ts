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

function barnacleGithub(files: ReturnType<typeof file>[]) {
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
        getCollaboratorPermissionLevel: async () => ({
          data: {
            role_name: "read",
          },
        }),
      },
      teams: {
        getMembershipForUserInOrg: async () => {
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
    expect(managedLabelSpecs["r: third-party-extension"].description).toContain("ClawHub");
    expect(managedLabelSpecs["r: too-many-prs"].description).toContain("ten active PRs");

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

  it("does not add candidate labels to maintainer-authored PRs", async () => {
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
  });

  it("removes stale Barnacle candidate and PR-limit labels from maintainer-authored PRs", async () => {
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

    expect(calls.removeLabel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: candidateLabels.dirtyCandidate }),
        expect.objectContaining({ name: "r: too-many-prs" }),
      ]),
    );
  });

  it("does not close clownfish PRs for the active PR limit", async () => {
    for (const headRef of [
      { head: { ref: "clownfish/clawsweeper-openclaw-openclaw-73880" } },
      { headRefName: "clownfish/clawsweeper-openclaw-openclaw-73880" },
    ]) {
      const { calls, github } = barnacleGithub([]);

      await runBarnacleAutoResponse({
        github,
        context: barnacleContext(
          {
            ...headRef,
            user: {
              login: "app/openclaw-clownfish",
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
          body: expect.stringContaining("more than 10 active PRs"),
        }),
      );
      expect(calls.update).not.toContainEqual(expect.objectContaining({ state: "closed" }));
    }
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
        body: expect.stringContaining("only changes tests"),
      }),
    );
    expect(calls.update).toContainEqual(expect.objectContaining({ state: "closed" }));
  });
});
