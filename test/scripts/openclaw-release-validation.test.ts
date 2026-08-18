import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  upsertRunComment,
} from "../../.agents/skills/openclaw-release-validation/scripts/release-validation.mts";

const releaseValidationScript = fileURLToPath(
  new URL(
    "../../.agents/skills/openclaw-release-validation/scripts/release-validation.mts",
    import.meta.url,
  ),
);

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
        desiredRunning: false,
        wasListening: false,
        health: "unknown",
        observedAt: "2026-08-17T20:00:00.000Z",
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

  it("renders only release feedback for every tested subsystem", () => {
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
        desiredRunning: false,
        wasListening: false,
        health: "unknown",
        observedAt: "2026-08-17T20:00:00.000Z",
      },
      scenarios: [
        { id: "memory", title: "Memory" },
        { id: "models", title: "Models" },
        { id: "channels", title: "Channels" },
      ],
    });
    let updated = recordSubsystemResult(state, "memory", {
      status: "pass",
      notes: "Remembered the canary from /Users/tester/.openclaw/workspace after restart.",
    });
    updated = recordSubsystemResult(updated, "models", {
      status: "fail",
      notes: "Model switching failed; details saved in ~/validation/models.log.",
    });

    const comment = renderRunComment({
      ...updated,
      promotionVote: "yes",
      finalFeedback:
        "The model switch was clear. API_KEY=secret-value Screenshot: /tmp/release-proof.png",
      releaseIssues: ["Upgrade dropped the selected model; log at ~/.ocm/envs/beta/gateway.log."],
      operationalFindings: ["OCM import failed once before retrying."],
      cleanup: {
        fixtureStopped: true,
        sourceRestoration: "blocked",
        sourceRestorationNote: "Source remains safely stopped.",
        retainedArtifacts: ["~/recovery/run-123/run.json", "~/recovery/run-123/source-backup"],
      },
    });

    expect(comment).toContain("<!-- openclaw-release-validation-run:run-123 -->");
    expect(comment).toContain("**Candidate:** `v2026.8.1-beta.3`");
    expect(comment).toContain(`**Upgrade source:** \`2026.6.1-beta.1\` · \`${"b".repeat(40)}\``);
    expect(comment).toContain("- **Memory — pass**:");
    expect(comment).toContain("- **Models — fail**:");
    expect(comment).not.toContain("Channels");
    expect(comment).toContain("The model switch was clear. API_KEY=[REDACTED]");
    expect(comment).toContain("Upgrade dropped the selected model; log at [LOCAL_PATH]");
    expect(comment).toContain("**Polished enough to promote?** Yes");
    expect(comment).not.toContain("`beta`");
    expect(comment).not.toContain("OCM import failed");
    expect(comment).not.toContain("cleanup");
    expect(comment).not.toContain("restoration");
    expect(comment).not.toContain("Retained recovery artifact");
    expect(comment).not.toMatch(/(?:\/Users\/|\/tmp\/|~\/|\.openclaw|\.ocm)/u);
  });

  it("updates the existing marker comment instead of creating a second comment", async () => {
    const state = createRunState({
      runId: "run-123",
      candidateTag: "v2026.8.1-beta.3",
      candidateSha: "a".repeat(40),
      fixture: "clean",
      issueNumber: 124600,
      envName: "release-validation-run-123",
      scenarios: [],
    });
    const createComment = vi.fn();
    const updateComment = vi.fn(async (commentId: number, body: string) => ({
      id: commentId,
      body,
    }));

    await expect(
      upsertRunComment({
        state,
        listComments: async () => [
          { id: 42, body: "<!-- openclaw-release-validation-run:run-123 -->\nold" },
        ],
        createComment,
        updateComment,
      }),
    ).resolves.toEqual({ commentId: 42, created: false });
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledOnce();
    expect(updateComment.mock.calls[0]?.[1]).toContain(
      "**Polished enough to promote?** No verdict",
    );

    state.github.commentId = 42;
    await expect(
      upsertRunComment({
        state,
        listComments: async () => [],
        createComment,
        updateComment,
      }),
    ).rejects.toThrow("refusing to create a duplicate");
    expect(createComment).not.toHaveBeenCalled();
  });

  it("copies real state into a run-owned root before upgrading the imported fixture", () => {
    const plan = buildFixturePlan({
      fixture: "copied",
      candidate: { kind: "published", version: "v2026.8.1-beta.3" },
      envName: "release-validation-run-123",
      runRoot: "/tmp/release-validation/run-123",
      sourceGateway: {
        kind: "ocm",
        name: "beta",
        version: "2026.6.1-beta.1",
        commit: "b".repeat(40),
        wasRunning: true,
        desiredRunning: true,
        wasListening: true,
        health: "healthy",
        observedAt: "2026-08-17T20:00:00.000Z",
        stateDir: "/home/tester/.ocm/envs/beta/.openclaw",
      },
    });

    expect(plan.map((step) => step.operation)).toEqual([
      "stop-source",
      "stage-copy",
      "adopt-copy",
      "upgrade-copy",
      "normalize-local-gateway",
      "preflight-copy",
      "enforce-plugin-isolation",
      "preview-plugin-updates-after-isolation",
      "enforce-single-channel-owner",
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
      "--runtime",
      "2026.8.1-beta.3",
      "--json",
    ]);
    expect(plan.some((step) => step.destination === "/home/tester/.ocm/envs/beta/.openclaw")).toBe(
      false,
    );
  });

  it.skipIf(process.platform === "win32")(
    "stages copied state without sockets and normalizes source-root config paths",
    async () => {
      const root = mkdtempSync("/tmp/openclaw-rv-");
      const source = path.join(root, "source");
      const destination = path.join(root, "run", "source-state");
      const socketPath = path.join(source, "exec-approvals.sock");
      mkdirSync(path.join(source, "workspace"), { recursive: true });
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(path.join(source, "workspace", "canary.txt"), "preserved\n");
      writeFileSync(
        path.join(source, "openclaw.json"),
        `${JSON.stringify({ agents: { defaults: { workspace: path.join(source, "workspace") } } }, null, 2)}\n`,
      );
      const socket = createServer();
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.listen(socketPath, resolve);
      });

      try {
        const receipt = JSON.parse(
          execFileSync(
            process.execPath,
            [
              releaseValidationScript,
              "stage-copy",
              "--source",
              source,
              "--destination",
              destination,
            ],
            { encoding: "utf8" },
          ),
        ) as { configPathReplacements: number; copiedSockets: number };

        expect(receipt).toMatchObject({ configPathReplacements: 1, copiedSockets: 0 });
        expect(readFileSync(path.join(destination, "workspace", "canary.txt"), "utf8")).toBe(
          "preserved\n",
        );
        expect(readFileSync(path.join(destination, "openclaw.json"), "utf8")).toContain(
          path.join(destination, "workspace"),
        );
        expect(existsSync(path.join(destination, "exec-approvals.sock"))).toBe(false);
      } finally {
        await new Promise<void>((resolve) => socket.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

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

    expect(overview).toContain("Choose one number or name");
    expect(overview).toContain("After it finishes, choose the next one");
    expect(overview).not.toContain("choose `all`");
    expect(overview).toContain("Reply exactly `finish validation` to end the run.");
    expect(overview).toContain("1. Pairing");
    expect(overview).toContain("19. OpenClaw harness");
    expect(overview).not.toContain("Pair one new client or sender");

    const details = renderMissionDetails(manifest, "copied", "pairing");
    expect(details).toContain("Pair one new client or sender");
    expect(details).toContain("Reply exactly `finish validation` to end the run.");
    expect(details).not.toContain("Channels");
  });

  it("blocks plugin lifecycle work when copied registry paths escape the fixture", () => {
    const root = mkdtempSync("/tmp/openclaw-rv-plugin-isolation-");
    const runRoot = path.join(root, "run");
    const runtimeRoot = path.join(root, "runtime");
    const sourceRoot = path.join(root, "source");
    const registryPath = path.join(root, "registry.json");
    mkdirSync(runRoot);
    mkdirSync(runtimeRoot);
    mkdirSync(sourceRoot);
    writeFileSync(
      registryPath,
      JSON.stringify({
        state: "fresh",
        persisted: {
          installRecords: {
            whatsapp: {
              source: "clawhub",
              installPath: path.join(sourceRoot, "extensions", "whatsapp"),
            },
          },
          plugins: [],
        },
        current: {
          installRecords: {
            whatsapp: {
              source: "clawhub",
              installPath: path.join(sourceRoot, "extensions", "whatsapp"),
            },
          },
          plugins: [
            {
              pluginId: "whatsapp",
              enabled: true,
              rootDir: path.join(sourceRoot, "extensions", "whatsapp"),
            },
            {
              pluginId: "telegram",
              enabled: true,
              rootDir: path.join(runtimeRoot, "extensions", "telegram"),
            },
          ],
        },
      }),
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          releaseValidationScript,
          "check-plugin-isolation",
          "--registry",
          registryPath,
          "--allowed-root",
          runRoot,
          "--allowed-root",
          runtimeRoot,
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        violations: [
          {
            pluginId: "whatsapp",
            field: "installPath",
          },
          {
            pluginId: "whatsapp",
            field: "rootDir",
          },
        ],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
