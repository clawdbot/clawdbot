import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  runReleaseValidationCampaignPublish,
  validateReleaseValidationCampaignArtifact,
} from "../../scripts/github/release-validation-campaign.mjs";

const TAG = "v2026.8.1-beta.3";
const TRAIN = "v2026.8.1";
const RELEASE_COMMIT = "a".repeat(40);
const GUIDANCE_SHA = "b".repeat(40);

function surface(name: string) {
  return [
    `### [${name}](https://docs.openclaw.ai/maturity/taxonomy#${name.toLowerCase()})`,
    "",
    "| **Maturity score** | M4 Stable |",
    "| --- | --- |",
    "| **What changed** | Runtime behavior changed. |",
    "| **Recommended testing** | Run `{{OPENCLAW}} status`; it exits successfully. |",
    "| **Testing notes** | |",
  ].join("\n");
}

function campaignBody(tag = TAG) {
  return [
    `<!-- openclaw-release-validation:${TRAIN} -->`,
    "",
    `- Current beta: [${tag}](https://github.com/openclaw/openclaw/releases/tag/${tag})`,
    `- Beta commit: \`${RELEASE_COMMIT}\``,
    `- Guidance main commit: \`${GUIDANCE_SHA}\``,
    "- Test target: latest immutable `origin/main`",
    "",
    "> [!NOTE]",
    "> Priorities use the live maturity scorecard.",
    "",
    "<!-- validation-guidance:start -->",
    "",
    "## Priority surfaces for this release",
    "",
    surface("Gateway"),
    "",
    surface("Channels"),
    "",
    surface("Models"),
    "",
    `## Priority surfaces since ${tag}`,
    "",
    surface("Agents"),
    "",
    surface("Sessions"),
    "",
    surface("Approvals"),
    "<!-- validation-guidance:end -->",
    "",
    "## Participate",
    "",
    "Run the release-validation skill.",
  ].join("\n");
}

function betaArtifact(tag = TAG) {
  return {
    schema: "openclaw.release-validation-campaign/v1",
    operation: "upsert",
    tag,
    stableTrain: TRAIN,
    releaseUrl: `https://github.com/openclaw/openclaw/releases/tag/${tag}`,
    releaseCommit: RELEASE_COMMIT,
    guidanceMainSha: GUIDANCE_SHA,
    title: "OpenClaw 2026.8.1 beta feedback",
    body: campaignBody(tag),
  };
}

function issue(number: number, body: string, labels = ["release-validation"]) {
  return {
    number,
    state: "open",
    title: "old title",
    body,
    html_url: `https://github.com/openclaw/openclaw/issues/${number}`,
    labels: labels.map((name) => ({ name })),
  };
}

function harness(initialIssues: ReturnType<typeof issue>[]) {
  const issues = new Map(initialIssues.map((candidate) => [candidate.number, candidate]));
  const calls = {
    comments: [] as Array<Record<string, unknown>>,
    creates: [] as Array<Record<string, unknown>>,
    labels: [] as Array<Record<string, unknown>>,
    updates: [] as Array<Record<string, unknown>>,
  };
  let nextNumber = 100;
  const github = {
    paginate: async () => [...issues.values()].filter((candidate) => candidate.state === "open"),
    rest: {
      issues: {
        listForRepo: async () => ({ data: [] }),
        getLabel: async () => ({ data: {} }),
        createLabel: async (args: Record<string, unknown>) => {
          calls.labels.push(args);
          return { data: {} };
        },
        createComment: async (args: Record<string, unknown>) => {
          calls.comments.push(args);
          return { data: {} };
        },
        create: async (args: Record<string, unknown>) => {
          calls.creates.push(args);
          const created = issue(nextNumber++, String(args.body));
          created.title = String(args.title);
          issues.set(created.number, created);
          return { data: created };
        },
        update: async (args: Record<string, unknown>) => {
          calls.updates.push(args);
          const current = issues.get(Number(args.issue_number));
          if (!current) {
            throw new Error("missing issue");
          }
          Object.assign(current, args);
          if (Array.isArray(args.labels)) {
            current.labels = args.labels.map((name) => ({ name: String(name) }));
          }
          return { data: current };
        },
        get: async ({ issue_number }: { issue_number: number }) => {
          const current = issues.get(issue_number);
          if (!current) {
            throw new Error("missing issue");
          }
          return { data: current };
        },
      },
    },
  };
  const core = { info: () => {}, setOutput: () => {} };
  return { calls, core, github };
}

describe("release-validation campaign artifact", () => {
  it("accepts the exact beta campaign contract", () => {
    expect(() =>
      validateReleaseValidationCampaignArtifact(betaArtifact(), {
        expectedTag: TAG,
        expectedReleaseCommit: RELEASE_COMMIT,
        expectedGuidanceMainSha: GUIDANCE_SHA,
      }),
    ).not.toThrow();
  });

  it("rejects non-empty testing notes and local paths", () => {
    const notes = betaArtifact();
    notes.body = notes.body.replace("| **Testing notes** | |", "| **Testing notes** | failed |");
    expect(() => validateReleaseValidationCampaignArtifact(notes)).toThrow("testing-notes row");

    const path = betaArtifact();
    path.body = path.body.replace("Runtime behavior changed.", "/Users/test/private.log");
    expect(() => validateReleaseValidationCampaignArtifact(path)).toThrow("local filesystem path");
  });
});

describe("release-validation campaign publisher", () => {
  it("creates the canonical campaign when none exists", async () => {
    const { calls, core, github } = harness([]);

    const result = await runReleaseValidationCampaignPublish({
      github,
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      core,
      artifact: betaArtifact(),
    });

    expect(result.action).toBe("create");
    expect(calls.creates).toEqual([
      expect.objectContaining({
        title: "OpenClaw 2026.8.1 beta feedback",
        labels: ["release-validation"],
      }),
    ]);
  });

  it("updates the matching train and closes an older campaign", async () => {
    const matching = issue(10, campaignBody());
    const older = issue(
      9,
      campaignBody().replaceAll(TRAIN, "v2026.7.1").replaceAll("2026.8.1", "2026.7.1"),
    );
    const { calls, core, github } = harness([matching, older]);

    const result = await runReleaseValidationCampaignPublish({
      github,
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      core,
      artifact: betaArtifact(),
      expectedTag: TAG,
      expectedReleaseCommit: RELEASE_COMMIT,
      expectedGuidanceMainSha: GUIDANCE_SHA,
    });

    expect(result).toEqual({
      action: "update",
      issueNumber: 10,
      issueUrl: "https://github.com/openclaw/openclaw/issues/10",
    });
    expect(calls.updates).toContainEqual(
      expect.objectContaining({ issue_number: 10, labels: ["release-validation"] }),
    );
    expect(calls.comments).toContainEqual(
      expect.objectContaining({ issue_number: 9, body: expect.stringContaining("issues/10") }),
    );
    expect(calls.updates).toContainEqual(
      expect.objectContaining({ issue_number: 9, state: "closed", state_reason: "completed" }),
    );
  });

  it("migrates one explicitly selected legacy campaign", async () => {
    const legacy = issue(
      10,
      campaignBody().replace(
        `<!-- openclaw-release-validation:${TRAIN} -->`,
        `<!-- openclaw-release-validation:${TAG} -->`,
      ),
      ["maintainer"],
    );
    const { calls, core, github } = harness([legacy]);

    const result = await runReleaseValidationCampaignPublish({
      github,
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      core,
      artifact: betaArtifact(),
      campaignIssueNumber: 10,
    });

    expect(result.action).toBe("update");
    expect(calls.creates).toHaveLength(0);
    expect(calls.updates).toContainEqual(
      expect.objectContaining({ issue_number: 10, labels: ["release-validation"] }),
    );
  });

  it("refuses to replace newer guidance with an older beta", async () => {
    const newerTag = "v2026.8.1-beta.4";
    const { core, github } = harness([issue(10, campaignBody(newerTag))]);

    await expect(
      runReleaseValidationCampaignPublish({
        github,
        context: { repo: { owner: "openclaw", repo: "openclaw" } },
        core,
        artifact: betaArtifact(),
      }),
    ).rejects.toThrow("older v2026.8.1-beta.3");
  });

  it("closes the matching train after a stable release", async () => {
    const { calls, core, github } = harness([
      issue(10, campaignBody(), ["release-validation", "keep"]),
    ]);

    const result = await runReleaseValidationCampaignPublish({
      github,
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      core,
      artifact: {
        schema: "openclaw.release-validation-campaign/v1",
        operation: "close",
        tag: TRAIN,
        stableTrain: TRAIN,
        releaseUrl: `https://github.com/openclaw/openclaw/releases/tag/${TRAIN}`,
      },
    });

    expect(result.action).toBe("close");
    expect(calls.comments).toEqual([
      expect.objectContaining({ issue_number: 10, body: expect.stringContaining(`/tag/${TRAIN}`) }),
    ]);
    expect(calls.updates).toEqual([
      expect.objectContaining({ issue_number: 10, state: "closed", labels: ["keep"] }),
    ]);
  });
});

describe("release-validation skill runner workflow", () => {
  it("keeps Codex read-only and publishes only through the validated artifact", () => {
    const workflow = readFileSync(".github/workflows/release-validation-skill-runner.yml", "utf8");

    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).not.toContain("issues: write");
    expect(workflow).toContain("RELEASE_VALIDATION_ARTIFACT_PATH");
    expect(workflow).toContain("validateReleaseValidationCampaignArtifact");
    expect(workflow.indexOf("openai/codex-action@")).toBeLessThan(
      workflow.indexOf("actions/create-github-app-token@"),
    );
  });
});
