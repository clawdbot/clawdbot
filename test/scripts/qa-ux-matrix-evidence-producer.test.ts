// QA UX Matrix evidence producer tests cover operator-facing CLI behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureUxMatrixVideoDependencies,
  launchUxMatrixChromium,
  runUxMatrixEvidenceProducerCli,
} from "../../scripts/qa/ux-matrix-evidence-producer.js";

async function runCli(...args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const status = await runUxMatrixEvidenceProducerCli(args, {
    error: (message) => stderr.push(message),
    log: (message) => stdout.push(message),
  });
  return {
    status,
    stderr: stderr.length > 0 ? `${stderr.join("\n")}\n` : "",
    stdout: stdout.length > 0 ? `${stdout.join("\n")}\n` : "",
  };
}

function expectNoNodeStack(stderr: string) {
  expect(stderr).not.toContain("Node.js");
  expect(stderr).not.toContain("\n    at ");
}

describe("QA UX Matrix evidence producer CLI", () => {
  it("prints help without generating evidence", async () => {
    const result = await runCli("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Usage: node --import tsx scripts/qa/ux-matrix-evidence-producer.ts",
    );
    expect(result.stderr).toBe("");
  });

  it("prints help after boolean options without consuming valued option slots", async () => {
    const result = await runCli("--skip-visual-proof", "--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Usage: node --import tsx scripts/qa/ux-matrix-evidence-producer.ts",
    );
    expect(result.stderr).toBe("");
  });

  it("reports invalid args without a Node stack trace", async () => {
    const result = await runCli("--wat");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("unsupported UX Matrix producer arg: --wat");
    expectNoNodeStack(result.stderr);
  });

  it("reports missing valued args without a Node stack trace", async () => {
    const result = await runCli("--artifact-base", "--repo-root", ".");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("--artifact-base requires a value");
    expectNoNodeStack(result.stderr);
  });

  it("reports duplicate evidence producer args without a Node stack trace", async () => {
    const duplicateCases = [
      ["--artifact-base", ["--artifact-base", ".artifacts/a", "--artifact-base", ".artifacts/b"]],
      ["--repo-root", ["--artifact-base", ".artifacts/a", "--repo-root", ".", "--repo-root", ".."]],
      [
        "--skip-visual-proof",
        ["--artifact-base", ".artifacts/a", "--skip-visual-proof", "--skip-visual-proof"],
      ],
    ] satisfies Array<[string, string[]]>;

    for (const [flag, args] of duplicateCases) {
      const result = await runCli(...args);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(`${flag} was provided more than once`);
      expectNoNodeStack(result.stderr);
    }
  });

  it("reports short flag values without treating them as help", async () => {
    const artifactBaseResult = await runCli("--artifact-base", "-h");
    const repoRootResult = await runCli(
      "--artifact-base",
      "/tmp/openclaw-ux-test",
      "--repo-root",
      "-h",
    );

    expect(artifactBaseResult.status).toBe(1);
    expect(artifactBaseResult.stdout).toBe("");
    expect(artifactBaseResult.stderr.trim()).toBe("--artifact-base requires a value");
    expectNoNodeStack(artifactBaseResult.stderr);
    expect(repoRootResult.status).toBe(1);
    expect(repoRootResult.stdout).toBe("");
    expect(repoRootResult.stderr.trim()).toBe("--repo-root requires a value");
    expectNoNodeStack(repoRootResult.stderr);
  });

  it("sanitizes local checkout paths from generated evidence artifacts", async () => {
    const artifactBase = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ux-evidence-test-"));
    const fakeRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ux-repo-test-"));
    try {
      const result = await runCli(
        "--artifact-base",
        artifactBase,
        "--repo-root",
        fakeRepoRoot,
        "--skip-visual-proof",
      );

      expect(result.status).toBe(0);
      const evidence = fs.readFileSync(path.join(artifactBase, "qa-evidence.json"), "utf8");
      const cliLog = fs.readFileSync(
        path.join(artifactBase, "surfaces", "cli", "stages", "entrypoint-help", "logs.txt"),
        "utf8",
      );
      const visualLog = fs.readFileSync(
        path.join(
          artifactBase,
          "surfaces",
          "control-ui",
          "stages",
          "screenshot-artifact",
          "logs.txt",
        ),
        "utf8",
      );
      expect(evidence).not.toContain(fakeRepoRoot);
      expect(cliLog).not.toContain(fakeRepoRoot);
      expect(`${evidence}\n${cliLog}`).toContain("<repo-root>");
      expect(visualLog).toBe("blocked: --skip-visual-proof was set\n");

      const evidenceJson = JSON.parse(evidence) as {
        entries: Array<{
          coverage: unknown[];
          execution?: { artifacts: Array<{ kind: string }> };
          test: { id: string };
        }>;
      };
      const matrix = JSON.parse(
        fs.readFileSync(path.join(artifactBase, "matrix.json"), "utf8"),
      ) as { cells: Array<{ coverageIds: unknown[] }> };
      const releaseLedger = JSON.parse(
        fs.readFileSync(path.join(artifactBase, "release-ledger.json"), "utf8"),
      ) as { entries: Array<{ coverageIds: unknown[] }> };
      const manifest = JSON.parse(
        fs.readFileSync(path.join(artifactBase, "manifest.json"), "utf8"),
      ) as { run: Record<string, unknown> };
      const commands = fs.readFileSync(path.join(artifactBase, "commands.txt"), "utf8");

      expect(evidenceJson.entries.map((entry) => entry.test.id)).toEqual([
        "ux-matrix.qa-lab.producer-artifact-fixture",
        "ux-matrix.control-ui.screenshot-artifact",
        "ux-matrix.cli.entrypoint-help",
      ]);
      expect(evidenceJson.entries.every((entry) => entry.coverage.length === 0)).toBe(true);
      expect(matrix.cells.every((cell) => cell.coverageIds.length === 0)).toBe(true);
      expect(releaseLedger.entries.every((entry) => entry.coverageIds.length === 0)).toBe(true);
      expect(manifest.run).not.toHaveProperty("scenarioId");
      expect(commands).toContain(
        "node --import tsx scripts/qa/ux-matrix-evidence-producer.ts --artifact-base",
      );
      expect(commands).not.toContain("qa suite --scenario");
      expect(
        evidenceJson.entries.flatMap(
          (entry) => entry.execution?.artifacts.map((artifact) => artifact.kind) ?? [],
        ),
      ).toEqual(expect.arrayContaining(["html", "log"]));
    } finally {
      fs.rmSync(artifactBase, { recursive: true, force: true });
      fs.rmSync(fakeRepoRoot, { recursive: true, force: true });
    }
  });

  it("falls back to system Chromium when the managed Playwright browser is missing", async () => {
    const browser = { close: vi.fn() };
    const launch = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          [
            "browserType.launch: Executable doesn't exist at /home/user/.cache/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell",
            "Please run the following command to download new browsers:",
            "pnpm exec playwright install",
          ].join("\n"),
        ),
      )
      .mockResolvedValueOnce(browser);

    const result = await launchUxMatrixChromium({
      chromium: { launch } as unknown as NonNullable<
        Parameters<typeof launchUxMatrixChromium>[0]
      >["chromium"],
      systemExecutablePath: "/usr/bin/chromium-browser",
    });

    expect(result).toEqual({
      browser,
      usedSystemExecutablePath: "/usr/bin/chromium-browser",
    });
    expect(launch).toHaveBeenNthCalledWith(1);
    expect(launch).toHaveBeenNthCalledWith(2, {
      executablePath: "/usr/bin/chromium-browser",
    });
  });

  it("ensures Playwright ffmpeg when video proof uses system Chromium", () => {
    const ensureChromium = vi.fn(() => 0);

    ensureUxMatrixVideoDependencies({
      ensureChromium,
      usedSystemExecutablePath: "/usr/bin/chromium-browser",
    });

    expect(ensureChromium).toHaveBeenCalledWith({
      ensureFfmpeg: true,
      systemExecutablePath: "/usr/bin/chromium-browser",
    });
  });
});
