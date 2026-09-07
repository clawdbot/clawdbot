import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerQaConfidenceBundleCli } from "./confidence-bundle-cli.js";
import { exportQaConfidenceBundle, replayQaConfidenceBundle } from "./confidence-bundle.js";
import { buildQaConfidenceReport } from "./confidence-report.js";

describe("portable confidence reports", () => {
  let tempRoot: string;
  let artifactRoot: string;
  let output: string;
  let previousExitCode: typeof process.exitCode;

  beforeEach(async () => {
    tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "qa-bundle-")));
    artifactRoot = path.join(tempRoot, "source");
    output = path.join(tempRoot, "confidence.json");
    await fs.mkdir(artifactRoot);
    previousExitCode = process.exitCode;
  });

  afterEach(async () => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function writeProfile(inputs: Array<{ artifact: string; content?: string }>) {
    const manifest = {
      version: 1 as const,
      profile: "portable-proof",
      lanes: inputs.map((input, index) => ({
        id: `lane-${index}`,
        title: `Lane ${index}`,
        kind: "generic-pass-summary" as const,
        artifact: input.artifact,
        required: true,
        failureVerdict: "product-bug" as const,
      })),
    };
    await fs.writeFile(path.join(artifactRoot, "profile.json"), JSON.stringify(manifest));
    for (const input of inputs) {
      if (input.content !== undefined) {
        await fs.writeFile(path.join(artifactRoot, input.artifact), input.content);
      }
    }
    return manifest;
  }

  async function capture(strictGlobalPass = true) {
    return exportQaConfidenceBundle({
      artifactRoot,
      manifest: "profile.json",
      output,
      strictGlobalPass,
    });
  }

  it("replays the existing classifier deterministically after all original inputs are deleted", async () => {
    const manifest = await writeProfile([
      { artifact: "pass.json", content: '{"pass":true}' },
      { artifact: "fail.json", content: '{"pass":false}' },
      { artifact: "missing.json" },
    ]);
    const exported = await capture();
    const replay = await replayQaConfidenceBundle({
      bundlePath: output,
      expectedSha256: exported.sha256,
    });
    const original = await buildQaConfidenceReport({
      manifest,
      artifactRoot,
      generatedAt: replay.report.generatedAt,
      strictGlobalPass: true,
    });
    expect(replay.report).toEqual(original);
    await fs.rm(artifactRoot, { recursive: true });
    expect(
      await replayQaConfidenceBundle({ bundlePath: output, expectedSha256: exported.sha256 }),
    ).toEqual(replay);
    expect(replay.integrity.scope).toBe("content-only");
    expect(replay.report.pass).toBe(false);
    expect(replay.report.lanes.map((lane) => lane.status)).toEqual(["pass", "fail", "missing"]);
  });

  it.each([true, false])("captures the selected global-pass policy (%s)", async (strict) => {
    await writeProfile([{ artifact: "failure.json", content: '{"pass":false}' }]);
    const exported = await capture(strict);
    const { report } = await replayQaConfidenceBundle({
      bundlePath: output,
      expectedSha256: exported.sha256,
    });
    expect(report.strictGlobalPass).toBe(strict);
    expect(report.pass).toBe(!strict);
    expect(report.globalPass).toBe(false);
  });

  it("preserves invalid JSON as unknown instead of losing the lane or accepting a pass", async () => {
    await writeProfile([{ artifact: "truncated.json", content: '{"pass":true' }]);
    const exported = await capture();
    const { report } = await replayQaConfidenceBundle({
      bundlePath: output,
      expectedSha256: exported.sha256,
    });
    expect(report.pass).toBe(false);
    expect(report.counts.unknown).toBe(1);
    expect(report.lanes[0]?.details).toBe("captured artifact is not valid JSON");
  });

  it("rejects an omitted lane even when a new bundle digest is supplied", async () => {
    await writeProfile([{ artifact: "missing.json" }]);
    await capture();
    const bundle = JSON.parse(await fs.readFile(output, "utf8"));
    bundle.artifacts = bundle.artifacts.filter(
      (entry: { path: string }) => entry.path !== "missing.json",
    );
    const bytes = Buffer.from(JSON.stringify(bundle));
    await fs.writeFile(output, bytes);
    await expect(
      replayQaConfidenceBundle({
        bundlePath: output,
        expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    ).rejects.toThrow("exactly the declared inputs");
  });

  it("does not overwrite an existing export", async () => {
    await writeProfile([{ artifact: "pass.json", content: '{"pass":true}' }]);
    await fs.writeFile(output, "keep this export");
    await expect(capture()).rejects.toMatchObject({ code: "EEXIST" });
    expect(await fs.readFile(output, "utf8")).toBe("keep this export");
  });

  it("runs the real CLI actions and separates verified content from a failing verdict", async () => {
    await writeProfile([{ artifact: "fail.json", content: '{"pass":false}' }]);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const command = () => {
      const program = new Command().exitOverride();
      registerQaConfidenceBundleCli(program.command("qa"));
      return program;
    };
    await command().parseAsync(
      [
        "qa",
        "confidence-export",
        "--manifest",
        "profile.json",
        "--artifact-root",
        artifactRoot,
        "--output",
        output,
        "--strict-global-pass",
      ],
      { from: "user" },
    );
    const exported = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    stdout.mockClear();
    await command().parseAsync(
      ["qa", "confidence-replay", "--bundle", output, "--expected-sha256", exported.sha256],
      { from: "user" },
    );
    const result = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
    expect(result.integrity.digest).toBe(exported.sha256);
    expect(result.report.pass).toBe(false);
    expect(process.exitCode).toBe(1);
    stdout.mockClear();
    await expect(
      command().parseAsync(
        ["qa", "confidence-replay", "--bundle", output, "--expected-sha256", "0".repeat(64)],
        { from: "user" },
      ),
    ).rejects.toThrow();
    expect(stdout).not.toHaveBeenCalled();
  });
});
