import { describe, expect, it, vi } from "vitest";
import {
  buildFixturePlan,
  buildIsolatedRuntimePlan,
  createRunState,
  getOrCreateCampaignIssue,
  loadScenarioManifest,
  recordSubsystemResult,
  renderMissionDetails,
  renderMissionOverview,
  renderRunComment,
  selectLatestBetaRelease,
} from "../../.agents/skills/openclaw-release-validation/scripts/release-validation.mts";

describe("openclaw release validation", () => {
  it("selects the newest published OpenClaw beta and ignores unrelated prereleases", () => {
    expect(
      selectLatestBetaRelease([
        {
          tagName: "pr-124528-profiles",
          isDraft: false,
          isPrerelease: true,
          publishedAt: "2026-08-16T10:15:43Z",
        },
        {
          tagName: "v2026.8.1-beta.2",
          isDraft: false,
          isPrerelease: true,
          publishedAt: "2026-08-15T05:36:23Z",
        },
        {
          tagName: "v2026.8.1-beta.10",
          isDraft: false,
          isPrerelease: true,
          publishedAt: "2026-08-17T05:36:23Z",
        },
        {
          tagName: "v2026.8.1-beta.11",
          isDraft: true,
          isPrerelease: true,
          publishedAt: "2026-08-18T05:36:23Z",
        },
      ]),
    ).toBe("v2026.8.1-beta.10");
  });

  it("joins the existing version campaign without creating a duplicate issue", async () => {
    const createIssue = vi.fn();

    await expect(
      getOrCreateCampaignIssue({
        releaseTag: "v2026.8.1-beta.3",
        listIssues: async () => [
          {
            number: 124600,
            url: "https://github.com/openclaw/openclaw/issues/124600",
            body: "<!-- openclaw-release-validation:v2026.8.1-beta.3 -->",
          },
        ],
        createIssue,
      }),
    ).resolves.toEqual({
      number: 124600,
      url: "https://github.com/openclaw/openclaw/issues/124600",
      created: false,
    });
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("starts every subsystem as needing coverage for the selected fixture", () => {
    const state = createRunState({
      runId: "run-123",
      candidateTag: "v2026.8.1-beta.3",
      candidateSha: "a".repeat(40),
      fixture: "copied",
      issueNumber: 124600,
      envName: "release-validation-run-123",
      sourceGateway: {
        kind: "ocm",
        name: "beta",
        version: "2026.6.1-beta.1",
        commit: "b".repeat(40),
        wasRunning: false,
      },
      scenarios: [
        { id: "pairing", title: "Pairing" },
        { id: "channels", title: "Channels" },
      ],
    });

    expect(state).toMatchObject({
      schemaVersion: 1,
      run: {
        id: "run-123",
        candidateTag: "v2026.8.1-beta.3",
        fixture: "copied",
        sourceGateway: {
          kind: "ocm",
          name: "beta",
          version: "2026.6.1-beta.1",
          commit: "b".repeat(40),
        },
      },
      subsystems: {
        pairing: { title: "Pairing", status: "needs coverage", notes: "" },
        channels: { title: "Channels", status: "needs coverage", notes: "" },
      },
      promotionVote: null,
    });
  });

  it("counts honest failures as completed coverage and requires failure notes", () => {
    const state = createRunState({
      runId: "run-123",
      candidateTag: "v2026.8.1-beta.3",
      candidateSha: "a".repeat(40),
      fixture: "clean",
      issueNumber: 124600,
      envName: "release-validation-run-123",
      scenarios: [{ id: "control-ui", title: "Control UI" }],
    });

    expect(() => recordSubsystemResult(state, "control-ui", { status: "fail", notes: "" })).toThrow(
      "notes are required",
    );

    const updated = recordSubsystemResult(state, "control-ui", {
      status: "fail",
      notes: "Compaction lost the last user turn.",
    });
    expect(updated.subsystems["control-ui"]).toMatchObject({
      status: "fail",
      notes: "Compaction lost the last user turn.",
    });
  });

  it("renders one redacted, resumable GitHub ledger comment per run", () => {
    const state = createRunState({
      runId: "run-123",
      candidateTag: "v2026.8.1-beta.3",
      candidateSha: "a".repeat(40),
      fixture: "copied",
      issueNumber: 124600,
      envName: "release-validation-run-123",
      sourceGateway: {
        kind: "ocm",
        name: "beta",
        version: "2026.6.1-beta.1",
        commit: "b".repeat(40),
        wasRunning: false,
      },
      scenarios: [{ id: "memory", title: "Memory" }],
    });
    const updated = recordSubsystemResult(state, "memory", {
      status: "pass",
      notes: "Remembered the canary after restart.",
    });

    const comment = renderRunComment({ ...updated, promotionVote: "yes" });

    expect(comment).toContain("<!-- openclaw-release-validation-run:run-123 -->");
    expect(comment).toContain("**Candidate:** `v2026.8.1-beta.3`");
    expect(comment).toContain("**Source:** `beta` · `2026.6.1-beta.1`");
    expect(comment).toContain("| Memory | pass | Remembered the canary after restart. |");
    expect(comment).toContain("**Polished enough to promote?** Yes");
  });

  it("copies real state into a run-owned root before upgrading the imported fixture", () => {
    const plan = buildFixturePlan({
      fixture: "copied",
      candidate: { kind: "published", version: "2026.8.1-beta.3" },
      envName: "release-validation-run-123",
      runRoot: "/tmp/release-validation/run-123",
      sourceGateway: {
        kind: "ocm",
        name: "beta",
        version: "2026.6.1-beta.1",
        commit: "b".repeat(40),
        wasRunning: true,
        stateDir: "/home/tester/.ocm/envs/beta/.openclaw",
      },
    });

    expect(plan.map((step) => step.operation)).toEqual([
      "stop-source",
      "copy-state",
      "adopt-copy",
      "upgrade-copy",
      "start-copy",
      "verify-copy",
    ]);
    expect(plan[1]).toMatchObject({
      source: "/home/tester/.ocm/envs/beta/.openclaw",
      destination: "/tmp/release-validation/run-123/source-state",
    });
    expect(plan[3]?.args).toEqual([
      "upgrade",
      "release-validation-run-123",
      "--version",
      "2026.8.1-beta.3",
      "--json",
    ]);
    expect(plan.some((step) => step.destination === "/home/tester/.ocm/envs/beta/.openclaw")).toBe(
      false,
    );
  });

  it("builds source candidates only from a detached run-owned checkout", () => {
    const plan = buildIsolatedRuntimePlan({
      ref: "723259273aa8f640d7d8c44d0730f082436691d5",
      repoRoot: "/src/openclaw",
      originUrl: "https://github.com/openclaw/openclaw",
      checkout: "/tmp/release-validation/run-123/openclaw",
      runtimeName: "release-validation-run-123",
    });

    expect(plan[0]).toMatchObject({
      command: "git",
      args: [
        "clone",
        "--no-checkout",
        "--dissociate",
        "--reference-if-able",
        "/src/openclaw",
        "https://github.com/openclaw/openclaw",
        "/tmp/release-validation/run-123/openclaw",
      ],
    });
    expect(plan).toContainEqual({
      operation: "checkout-detached",
      command: "git",
      args: [
        "-C",
        "/tmp/release-validation/run-123/openclaw",
        "checkout",
        "--detach",
        "723259273aa8f640d7d8c44d0730f082436691d5",
      ],
    });
    expect(plan.at(-2)).toMatchObject({
      command: "ocm",
      args: [
        "runtime",
        "build-local",
        "release-validation-run-123",
        "--repo",
        "/tmp/release-validation/run-123/openclaw",
        "--force",
      ],
    });
  });

  it("loads the curated taxonomy-linked subsystem mission matrix", () => {
    const manifest = loadScenarioManifest();

    expect(manifest.subsystems.map((entry) => entry.id)).toEqual([
      "pairing",
      "channels",
      "control-ui",
      "tui",
      "onboarding",
      "slash-commands",
      "memory",
      "subagents",
      "agents",
      "cron",
      "sessions",
      "context-engine",
      "skill-workshop",
      "mcp",
      "models",
      "approvals",
      "compaction",
      "codex-harness",
      "openclaw-harness",
    ]);
    for (const subsystem of manifest.subsystems) {
      expect(subsystem.taxonomyIds.length).toBeGreaterThan(0);
      expect(subsystem.instructions.clean.length).toBeGreaterThan(0);
      expect(subsystem.instructions.copied.length).toBeGreaterThan(0);
      expect(subsystem.passEvidence.length).toBeGreaterThan(0);
    }
  });

  it("shows a compact selection overview before revealing one chosen mission", () => {
    const manifest = loadScenarioManifest();
    const overview = renderMissionOverview(manifest, "copied");

    expect(overview).toContain("Choose any numbers or names");
    expect(overview).toContain("1. Pairing");
    expect(overview).toContain("19. OpenClaw harness");
    expect(overview).not.toContain("Pair one new client or sender");

    const details = renderMissionDetails(manifest, "copied", "pairing");
    expect(details).toContain("Pair one new client or sender");
    expect(details).not.toContain("Channels");
  });
});
