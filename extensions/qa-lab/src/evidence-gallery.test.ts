// Qa Lab tests cover generic QA evidence gallery behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildQaEvidenceGalleryModel,
  resolveQaEvidenceArtifactFileByIndex,
  resolveQaEvidenceArtifactFile,
  resolveQaEvidenceProducerFile,
  resolveQaEvidenceFile,
} from "./evidence-gallery.js";
import {
  QA_EVIDENCE_FILENAME,
  buildVitestEvidenceSummary,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";

async function createTempRepo() {
  return fs.mkdtemp(path.join(os.tmpdir(), "qa-evidence-gallery-"));
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function producerRootLeakSegments(repoRoot: string) {
  if (process.platform !== "win32") {
    return [`nested${repoRoot}`];
  }
  return [
    "nested",
    ...repoRoot
      .split(/[\\/]+/u)
      .filter(Boolean)
      .map((part) => part.replace(/[^A-Za-z0-9._-]/gu, "_")),
  ];
}

function repoRelativePath(repoRoot: string, filePath: string) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function vitestArtifactEvidence(params: {
  id: string;
  title: string;
  artifact: { kind: string; path: string };
}): QaEvidenceSummaryJson {
  return {
    kind: "openclaw.qa.evidence-summary",
    schemaVersion: 2,
    generatedAt: "2026-06-17T12:00:00.000Z",
    evidenceMode: "full",
    entries: [
      {
        test: { kind: "vitest-test", id: params.id, title: params.title },
        coverage: [{ id: "qa.artifact", role: "primary" }],
        execution: {
          runner: "vitest",
          environment: { ref: "gallery-test", os: "darwin", nodeVersion: "v24.0.0" },
          provider: {
            id: "mock-openai",
            live: false,
            model: { name: "mock-openai/gpt-5.6-luna", ref: "mock-openai/gpt-5.6-luna" },
          },
          packageSource: { kind: "source-checkout" },
          artifacts: [{ ...params.artifact, source: "vitest" }],
        },
        result: { status: "pass" },
      },
    ],
  };
}

describe("evidence gallery", () => {
  it("builds a generic gallery model for non-UX QA Lab evidence", async () => {
    const repoRoot = await createTempRepo();
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "vitest");
    await fs.mkdir(path.join(outputDir, "runner"), { recursive: true });
    await fs.writeFile(path.join(outputDir, "runner", "result.json"), '{"ok":true}\n', "utf8");
    await fs.writeFile(path.join(outputDir, "runner", "output.log"), "vitest pass\n", "utf8");

    const evidence: QaEvidenceSummaryJson = buildVitestEvidenceSummary({
      artifactPaths: [
        { kind: "runner-result", path: "runner/result.json" },
        { kind: "log", path: "runner/output.log" },
      ],
      env: {
        OPENCLAW_QA_REF: "gallery-test",
      } as NodeJS.ProcessEnv,
      generatedAt: "2026-06-17T12:00:00.000Z",
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      targets: [
        {
          id: "qa-lab.generic-vitest",
          title: "Generic Vitest evidence",
          sourcePath: "extensions/qa-lab/src/generic.test.ts",
          primaryCoverageIds: ["qa.generic"],
        },
        {
          id: "qa-lab.no-artifacts",
          title: "Generic entry without artifacts",
          sourcePath: "extensions/qa-lab/src/no-artifacts.test.ts",
          primaryCoverageIds: ["qa.empty"],
        },
      ],
      results: [
        {
          id: "qa-lab.generic-vitest",
          status: "pass",
          durationMs: 42,
        },
        {
          id: "qa-lab.no-artifacts",
          status: "skipped",
          durationMs: 1,
        },
      ],
    });
    evidence.entries[1] = {
      ...evidence.entries[1],
      execution: {
        ...evidence.entries[1].execution!,
        artifacts: [],
      },
    };
    const evidencePath = path.join(outputDir, QA_EVIDENCE_FILENAME);
    await writeJson(evidencePath, evidence);

    const model = await buildQaEvidenceGalleryModel({
      evidencePath: outputDir,
      repoRoot,
    });

    expect(model.counts).toMatchObject({ pass: 1, skipped: 1, fail: 0, blocked: 0 });
    expect(model.evidencePath).toBe(".artifacts/qa-e2e/vitest/qa-evidence.json");
    expect(model.producerContext).toBeNull();
    expect(model.entries).toHaveLength(2);
    expect(model.entries[0]).toMatchObject({
      id: "qa-lab.generic-vitest",
      kind: "vitest-test",
      artifacts: [
        expect.objectContaining({
          exists: true,
          kind: "runner-result",
          href: "/api/evidence/artifact?evidencePath=.artifacts%2Fqa-e2e%2Fvitest%2Fqa-evidence.json&entryIndex=0&artifactIndex=0",
          mediaKind: "json",
          preview: '{\n  "ok": true\n}',
        }),
        expect.objectContaining({
          exists: true,
          kind: "log",
          mediaKind: "text",
          preview: "vitest pass\n",
        }),
      ],
    });
    expect(model.entries[1]).toMatchObject({
      id: "qa-lab.no-artifacts",
      artifacts: [],
    });
  });

  it("sanitizes local roots from gallery failure reasons", async () => {
    const repoRoot = await createTempRepo();
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "vitest");
    await fs.mkdir(outputDir, { recursive: true });
    const evidence: QaEvidenceSummaryJson = vitestArtifactEvidence({
      id: "qa-lab.failure-path",
      title: "Failure path evidence",
      artifact: { kind: "log", path: "missing.log" },
    });
    evidence.entries[0] = {
      ...evidence.entries[0],
      result: {
        status: "blocked",
        failure: {
          class: "blocked",
          reason: `Command failed at ${repoRoot}/openclaw.mjs and file://${repoRoot}/trace.log`,
        },
      },
    };
    await writeJson(path.join(outputDir, QA_EVIDENCE_FILENAME), evidence);

    const model = await buildQaEvidenceGalleryModel({
      evidencePath: outputDir,
      repoRoot,
    });

    expect(model.entries[0].failureReason).toBe(
      "Command failed at <repo-root>/openclaw.mjs and file://<repo-root>/trace.log",
    );
    expect(JSON.stringify(model)).not.toContain(repoRoot);
  });

  it("normalizes absolute source and declared artifact paths for gallery links", async () => {
    const repoRoot = await createTempRepo();
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "vitest");
    const artifactPath = path.join(outputDir, "absolute.log");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(
      artifactPath,
      `absolute artifact ${repoRoot}\nfile://${repoRoot}/trace.log\n`,
      "utf8",
    );
    const relativeLeakArtifactPath = `nested${repoRoot}/relative.log`;
    const relativeLeakFile = path.resolve(outputDir, relativeLeakArtifactPath);
    await fs.mkdir(path.dirname(relativeLeakFile), { recursive: true });
    await fs.writeFile(relativeLeakFile, "relative artifact\n", "utf8");
    const evidence: QaEvidenceSummaryJson = vitestArtifactEvidence({
      id: "qa-lab.absolute-artifact-path",
      title: "Absolute artifact path",
      artifact: { kind: "log", path: artifactPath },
    });
    evidence.profile = `${repoRoot}/qa-profile`;
    evidence.entries[0] = {
      ...evidence.entries[0],
      coverage: [{ id: `${repoRoot}/coverage`, role: `${repoRoot}/role` }],
      execution: {
        ...evidence.entries[0].execution!,
        artifacts: [
          {
            ...evidence.entries[0].execution!.artifacts[0],
            kind: `${repoRoot}/log`,
            source: `${repoRoot}/vitest`,
          },
          {
            kind: "log",
            path: relativeLeakArtifactPath,
            source: "vitest",
          },
        ],
      },
      test: {
        ...evidence.entries[0].test,
        id: `${repoRoot}/qa-lab.absolute-artifact-path`,
        kind: `${repoRoot}/vitest-test`,
        source: { path: path.join(repoRoot, "extensions/qa-lab/src/absolute.test.ts") },
        title: `Absolute artifact path at ${repoRoot}`,
      },
    };
    await writeJson(path.join(outputDir, QA_EVIDENCE_FILENAME), evidence);

    const model = await buildQaEvidenceGalleryModel({
      evidencePath: outputDir,
      repoRoot,
    });

    const artifact = model.entries[0]?.artifacts[0];
    expect(artifact).toMatchObject({
      exists: true,
      kind: "<repo-root>/log",
      path: ".artifacts/qa-e2e/vitest/absolute.log",
      preview: "absolute artifact <repo-root>\nfile://<repo-root>/trace.log\n",
      source: "<repo-root>/vitest",
    });
    expect(artifact?.href).toContain("entryIndex=0&artifactIndex=0");
    const relativeArtifact = model.entries[0]?.artifacts[1];
    expect(relativeArtifact).toMatchObject({
      exists: true,
      path: expect.stringContaining(".artifacts/qa-e2e/vitest/nested"),
      preview: "relative artifact\n",
    });
    expect(decodeURIComponent(relativeArtifact?.href ?? "")).not.toContain(repoRoot);
    expect(relativeArtifact?.href).toContain("entryIndex=0&artifactIndex=1");
    expect(model.entries[0]?.sourcePath).toBe("extensions/qa-lab/src/absolute.test.ts");
    expect(model.entries[0]).toMatchObject({
      coverage: [{ id: "<repo-root>/coverage", role: "<repo-root>/role" }],
      id: "<repo-root>/qa-lab.absolute-artifact-path",
      kind: "<repo-root>/vitest-test",
      title: "Absolute artifact path at <repo-root>",
    });
    expect(model.profile).toBe("<repo-root>/qa-profile");
    expect(JSON.stringify(model)).not.toContain(repoRoot);
    await expect(
      resolveQaEvidenceArtifactFile({
        artifactPath: "<repo-root>/.artifacts/qa-e2e/vitest/absolute.log",
        evidencePath: outputDir,
        repoRoot,
      }),
    ).resolves.toBe(await fs.realpath(artifactPath));
    await expect(
      resolveQaEvidenceArtifactFileByIndex({
        artifactIndex: 1,
        entryIndex: 0,
        evidencePath: outputDir,
        repoRoot,
      }),
    ).resolves.toBe(await fs.realpath(relativeLeakFile));
  });

  it("detects UX Matrix producer context from suite-level evidence artifacts", async () => {
    const repoRoot = await createTempRepo();
    const suiteDir = path.join(repoRoot, ".artifacts", "qa-e2e", "suite");
    const runDir = path.join(
      suiteDir,
      "script",
      ...producerRootLeakSegments(repoRoot),
      "ux-matrix-evidence-dashboard",
      "run-1",
    );
    const expectedWebScreenshotNeedle =
      process.platform === "win32"
        ? ".artifacts/qa-e2e/suite/script/nested"
        : ".artifacts/qa-e2e/suite/script/nested<repo-root>/ux-matrix-evidence-dashboard/run-1/surfaces/web-ui/stages/first-run/screenshot.png";
    const expectedCliLogNeedle =
      process.platform === "win32"
        ? ".artifacts/qa-e2e/suite/script/nested"
        : ".artifacts/qa-e2e/suite/script/nested<repo-root>/ux-matrix-evidence-dashboard/run-1/surfaces/cli/stages/error-state/logs.txt";
    await fs.mkdir(path.join(runDir, "surfaces", "web-ui", "stages", "first-run"), {
      recursive: true,
    });
    await fs.mkdir(path.join(runDir, "surfaces", "cli", "stages", "error-state"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(runDir, "surfaces", "web-ui", "stages", "first-run", "screenshot.png"),
      "png",
    );
    await fs.writeFile(
      path.join(runDir, "surfaces", "cli", "stages", "error-state", "logs.txt"),
      "cli blocked\n",
      "utf8",
    );
    await writeJson(path.join(runDir, "manifest.json"), {
      run: {
        runId: "run-1",
        status: "pass",
      },
    });
    await writeJson(path.join(runDir, "matrix.json"), {
      counts: {
        pass: 1,
        blocked: 1,
        "proof-gap": 1,
      },
      stages: [
        { id: `${repoRoot}/diagnostics`, label: "Diagnostics" },
        { id: "first-run", label: "First run" },
        { id: "error-state", label: "Error state" },
      ],
      surfaces: [
        { id: `${repoRoot}/native`, label: "Native" },
        { id: "web-ui", label: "Web UI" },
        { id: "cli", label: "CLI" },
      ],
      cells: [
        null,
        {
          coverageIds: [`${repoRoot}/ui.control`],
          runner: {
            availability: "local",
            command: `${repoRoot}/openclaw.mjs qa suite --scenario ux-matrix-evidence-dashboard`,
            lane: "web-ui-playwright",
            workflow: `${repoRoot}/.github/workflows/ux-matrix-qa.yml#ux-matrix-local`,
          },
          stage: "first-run",
          status: "pass",
          surface: "web-ui",
        },
        {
          coverageIds: ["cli.entrypoint"],
          runner: {
            availability: "local",
            command: "pnpm openclaw qa suite --scenario ux-matrix-evidence-dashboard",
            lane: "cli-status",
            workflow: ".github/workflows/ux-matrix-qa.yml#ux-matrix-local",
          },
          stage: "first-run",
          status: "proof-gap",
          surface: "cli",
        },
        { stage: "error-state", status: "blocked", surface: "cli" },
      ],
    });
    await writeJson(path.join(runDir, "release-ledger.json"), {
      counts: {
        pass: 1,
        blocked: 1,
        "proof-gap": 1,
      },
    });
    await fs.writeFile(path.join(runDir, "scorecard.md"), "# UX Matrix\n\n- pass: 1\n", "utf8");
    await fs.writeFile(path.join(runDir, "commands.txt"), "node ux matrix\n", "utf8");
    await fs.mkdir(path.join(runDir, "preflight"), { recursive: true });
    await fs.writeFile(path.join(runDir, "preflight", "memory.txt"), "memory ok\n", "utf8");
    await fs.writeFile(
      path.join(runDir, "preflight", "adb-devices.txt"),
      "List of devices\n",
      "utf8",
    );

    await writeJson(path.join(suiteDir, QA_EVIDENCE_FILENAME), {
      kind: "openclaw.qa.evidence-summary",
      schemaVersion: 2,
      generatedAt: "2026-06-17T12:00:00.000Z",
      evidenceMode: "full",
      entries: [
        {
          test: {
            kind: "ux-matrix-cell",
            id: "ux-matrix.web-ui.first-run",
            title: `UX Matrix: web-ui / first-run at ${repoRoot}`,
            source: { path: "scripts/ux-matrix/dashboard.ts" },
          },
          coverage: [{ id: "ui.control", role: "primary" }],
          execution: {
            runner: "ux-matrix-dashboard",
            environment: {
              ref: "gallery-test",
              os: "darwin",
              nodeVersion: "v24.0.0",
            },
            provider: {
              id: "ux-matrix",
              live: false,
              model: { name: null, ref: null },
              fixture: "mocked-control-ui-and-isolated-cli",
            },
            packageSource: { kind: "source-checkout", sha: "abc123" },
            artifacts: [
              {
                kind: "screenshot",
                path: path.join(
                  runDir,
                  "surfaces",
                  "web-ui",
                  "stages",
                  "first-run",
                  "screenshot.png",
                ),
                source: "ux-matrix:web-ui:first-run",
              },
            ],
          },
          result: { status: "pass", timing: { wallMs: 1 } },
        },
        {
          test: {
            kind: "ux-matrix-cell",
            id: "qa-lab.wrapper-cli-error",
            title: "UX Matrix: cli / error-state",
            source: { path: "scripts/ux-matrix/dashboard.ts" },
          },
          coverage: [{ id: "cli.status-snapshots", role: "primary" }],
          execution: {
            runner: "ux-matrix-dashboard",
            environment: {
              ref: "gallery-test",
              os: "darwin",
              nodeVersion: "v24.0.0",
            },
            provider: {
              id: "ux-matrix",
              live: false,
              model: { name: null, ref: null },
              fixture: "mocked-control-ui-and-isolated-cli",
            },
            packageSource: { kind: "source-checkout", sha: "abc123" },
            artifacts: [
              {
                kind: "log",
                path: repoRelativePath(
                  repoRoot,
                  path.join(runDir, "surfaces", "cli", "stages", "error-state", "logs.txt"),
                ),
                source: "ux-matrix:cli:error-state",
              },
            ],
          },
          result: {
            status: "blocked",
            failure: {
              class: "blocked",
              reason: "CLI error-state proof captured a blocked result.",
            },
            timing: { wallMs: 2 },
          },
        },
      ],
    });

    const model = await buildQaEvidenceGalleryModel({
      evidencePath: suiteDir,
      repoRoot,
    });

    expect(model.producerContext).toMatchObject({
      kind: "ux-matrix",
      manifest: {
        runId: "run-1",
        runStatus: "pass",
      },
      matrix: {
        counts: {
          pass: 1,
          blocked: 1,
          "proof-gap": 1,
        },
        stages: ["<repo-root>/diagnostics", "first-run", "error-state"],
        surfaces: ["<repo-root>/native", "web-ui", "cli"],
      },
      releaseLedger: {
        counts: {
          pass: 1,
          blocked: 1,
          "proof-gap": 1,
        },
      },
    });
    expect(model.producerContext?.matrix?.cells).toEqual([
      {
        artifactKinds: ["screenshot"],
        artifactPaths: [expect.stringContaining(expectedWebScreenshotNeedle)],
        coverageIds: ["<repo-root>/ui.control"],
        runner: {
          availability: "local",
          command: "<repo-root>/openclaw.mjs qa suite --scenario ux-matrix-evidence-dashboard",
          lane: "web-ui-playwright",
          workflow: "<repo-root>/.github/workflows/ux-matrix-qa.yml#ux-matrix-local",
        },
        stage: "first-run",
        status: "pass",
        surface: "web-ui",
        testId: "ux-matrix.web-ui.first-run",
        title: "UX Matrix: web-ui / first-run at <repo-root>",
      },
      {
        artifactKinds: [],
        artifactPaths: [],
        coverageIds: ["cli.entrypoint"],
        runner: {
          availability: "local",
          command: "pnpm openclaw qa suite --scenario ux-matrix-evidence-dashboard",
          lane: "cli-status",
          workflow: ".github/workflows/ux-matrix-qa.yml#ux-matrix-local",
        },
        stage: "first-run",
        status: "proof-gap",
        surface: "cli",
        testId: null,
        title: null,
      },
      {
        artifactKinds: ["log"],
        artifactPaths: [expect.stringContaining(expectedCliLogNeedle)],
        coverageIds: [],
        runner: null,
        stage: "error-state",
        status: "blocked",
        surface: "cli",
        testId: "qa-lab.wrapper-cli-error",
        title: "UX Matrix: cli / error-state",
      },
    ]);
    expect(model.producerContext?.scorecard?.preview).toContain("# UX Matrix");
    expect(model.producerContext?.scorecard?.href).toContain("/api/evidence/artifact?");
    expect(decodeURIComponent(model.producerContext?.scorecard?.href ?? "")).not.toContain(
      repoRoot,
    );
    expect(model.producerContext?.commands?.preview).toBe("node ux matrix\n");
    expect(model.producerContext?.commands?.path).toContain("commands.txt");
    expect(decodeURIComponent(model.producerContext?.commands?.href ?? "")).not.toContain(repoRoot);
    expect(model.producerContext?.manifest?.preview).toContain('"runId": "run-1"');
    expect(model.producerContext?.releaseLedger?.preview).toContain('"proof-gap": 1');
    expect(model.producerContext?.preflight.memory?.path).toContain("preflight/memory.txt");
    expect(model.producerContext?.preflight.memory?.preview).toBe("memory ok\n");
    expect(model.producerContext?.preflight.adbDevices?.path).toContain(
      "preflight/adb-devices.txt",
    );
    expect(model.producerContext?.preflight.adbDevices?.preview).toBe("List of devices\n");
    expect(model.evidencePath).toBe(".artifacts/qa-e2e/suite/qa-evidence.json");
    expect(JSON.stringify(model)).not.toContain(repoRoot);
    await expect(
      resolveQaEvidenceProducerFile({
        evidencePath: suiteDir,
        producerFile: "scorecard",
        repoRoot,
      }),
    ).resolves.toBe(await fs.realpath(path.join(runDir, "scorecard.md")));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-evidence-outside-"));
    const outsideCommands = path.join(outsideDir, "commands.txt");
    await fs.writeFile(outsideCommands, "outside secret\n", "utf8");
    await fs.unlink(path.join(runDir, "commands.txt"));
    await fs.symlink(outsideCommands, path.join(runDir, "commands.txt"));
    const symlinkModel = await buildQaEvidenceGalleryModel({
      evidencePath: suiteDir,
      repoRoot,
    });
    expect(symlinkModel.producerContext?.commands).toBeNull();
    expect(JSON.stringify(symlinkModel)).not.toContain("outside secret");
    await expect(
      resolveQaEvidenceArtifactFile({
        artifactPath: path.relative(repoRoot, path.join(runDir, "scorecard.md")),
        evidencePath: suiteDir,
        repoRoot,
      }),
    ).resolves.toBe(await fs.realpath(path.join(runDir, "scorecard.md")));
  });

  it("resolves evidence and declared artifacts inside the repo root only", async () => {
    const repoRoot = await createTempRepo();
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "suite");
    const evidencePath = path.join(outputDir, QA_EVIDENCE_FILENAME);
    await fs.writeFile(path.join(repoRoot, "package.json"), '{"private":true}\n', "utf8");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "artifact.log"), "ok\n", "utf8");
    await writeJson(
      evidencePath,
      vitestArtifactEvidence({
        id: "qa-lab.declared-artifact",
        title: "Declared artifact",
        artifact: { kind: "log", path: "artifact.log" },
      }),
    );

    await expect(resolveQaEvidenceFile({ inputPath: outputDir, repoRoot })).resolves.toBe(
      await fs.realpath(evidencePath),
    );
    await expect(
      resolveQaEvidenceArtifactFile({
        artifactPath: "artifact.log",
        evidencePath,
        repoRoot,
      }),
    ).resolves.toBe(await fs.realpath(path.join(outputDir, "artifact.log")));
    await fs.mkdir(path.join(repoRoot, "runner"), { recursive: true });
    await fs.mkdir(path.join(outputDir, "runner"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "runner", "result.json"), '{"from":"repo"}\n', "utf8");
    await fs.writeFile(
      path.join(outputDir, "runner", "result.json"),
      '{"from":"evidence"}\n',
      "utf8",
    );
    const collisionEvidence = vitestArtifactEvidence({
      id: "qa-lab.colliding-artifact",
      title: "Colliding artifact",
      artifact: { kind: "runner-result", path: "runner/result.json" },
    });
    await writeJson(evidencePath, collisionEvidence);
    await expect(
      resolveQaEvidenceArtifactFile({
        artifactPath: "runner/result.json",
        evidencePath,
        repoRoot,
      }),
    ).resolves.toBe(await fs.realpath(path.join(outputDir, "runner", "result.json")));
    await fs.rm(path.join(outputDir, "runner", "result.json"));
    const missingBundleModel = await buildQaEvidenceGalleryModel({ evidencePath, repoRoot });
    expect(missingBundleModel.entries[0].artifacts[0]).toMatchObject({
      exists: false,
      error: "Evidence artifact not found.",
      preview: null,
    });
    expect(JSON.stringify(missingBundleModel)).not.toContain('"from":"repo"');
    await expect(
      resolveQaEvidenceArtifactFile({
        artifactPath: "package.json",
        evidencePath,
        repoRoot,
      }),
    ).rejects.toThrow("Evidence artifact not found.");
    await fs.writeFile(path.join(outputDir, "undeclared.log"), "undeclared\n", "utf8");
    await expect(
      resolveQaEvidenceArtifactFile({
        artifactPath: "undeclared.log",
        evidencePath,
        repoRoot,
      }),
    ).rejects.toThrow("Evidence artifact is not declared by this evidence summary.");
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-evidence-outside-artifact-"));
    const outsideArtifact = path.join(outsideDir, "artifact.log");
    await fs.writeFile(outsideArtifact, "outside secret\n", "utf8");
    await fs.symlink(outsideArtifact, path.join(outputDir, "escape.log"));
    await writeJson(evidencePath, {
      ...collisionEvidence,
      entries: [
        {
          ...collisionEvidence.entries[0],
          execution: {
            ...collisionEvidence.entries[0].execution,
            artifacts: [{ kind: "log", path: "escape.log", source: "vitest" }],
          },
        },
      ],
    });
    await expect(
      resolveQaEvidenceArtifactFile({
        artifactPath: "escape.log",
        evidencePath,
        repoRoot,
      }),
    ).rejects.toThrow("Evidence artifact not found.");
    await expect(
      resolveQaEvidenceFile({ inputPath: "/tmp/not-openclaw-evidence.json", repoRoot }),
    ).rejects.toThrow("Evidence path not found.");
  });
});
