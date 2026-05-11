import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMantisVisualDriver, runMantisVisualTask } from "./visual-task.runtime.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.stat(targetPath);
  } catch (error) {
    expect((error as { code?: unknown }).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected path to be missing: ${targetPath}`);
}

function expectArgsContainSequence(args: readonly string[], expected: readonly string[]): void {
  const startIndex = args.findIndex((_, index) => {
    return expected.every((value, offset) => args[index + offset] === value);
  });
  expect(startIndex).toBeGreaterThanOrEqual(0);
}

describe("mantis visual task runtime", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-visual-task-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it("records a visible browser task and keeps screenshot/video artifacts", async () => {
    const commands: { args: readonly string[]; command: string }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
      if (command === "/tmp/crabbox" && args[0] === "warmup") {
        return { stdout: "ready lease cbx_abc123\n", stderr: "" };
      }
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        return {
          stdout: `${JSON.stringify({
            id: "cbx_abc123",
            provider: "hetzner",
            slug: "brisk-mantis",
            state: "active",
          })}\n`,
          stderr: "",
        };
      }
      if (command === "/tmp/crabbox" && args[0] === "record") {
        const outputPath = args[args.indexOf("--output") + 1];
        const outputDir = args[args.indexOf("--output-dir") + 1];
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, "mp4");
        await fs.writeFile(path.join(outputDir, "visual-task.png"), "png");
        await fs.writeFile(
          path.join(outputDir, "mantis-visual-task-driver-result.json"),
          `${JSON.stringify({
            browserUrl: "https://example.net",
            finishedAt: "2026-05-04T12:00:05.000Z",
            matched: true,
            outputDir,
            screenshotPath: path.join(outputDir, "visual-task.png"),
            startedAt: "2026-05-04T12:00:01.000Z",
            status: "pass",
            vision: {
              mode: "metadata",
              timeoutMs: 120000,
            },
          })}\n`,
        );
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisVisualTask({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      duration: "12s",
      env: { PATH: process.env.PATH },
      now: () => new Date("2026-05-04T12:00:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/visual-task-test",
      repoRoot,
      settleMs: 0,
      visionMode: "metadata",
    });

    expect(result.status).toBe("pass");
    expect(commands.map((entry) => [entry.command, entry.args[0]])).toEqual([
      ["/tmp/crabbox", "warmup"],
      ["/tmp/crabbox", "inspect"],
      ["/tmp/crabbox", "record"],
      ["/tmp/crabbox", "stop"],
    ]);
    const recordArgs = commands.find((entry) => entry.args[0] === "record")?.args ?? [];
    const finalVideoPath = path.join(
      repoRoot,
      ".artifacts/qa-e2e/mantis/visual-task-test/visual-task.mp4",
    );
    const stagedVideoPath = recordArgs[recordArgs.indexOf("--output") + 1];
    expectArgsContainSequence(recordArgs, ["--duration", "12s"]);
    expectArgsContainSequence(recordArgs, ["--output", stagedVideoPath ?? ""]);
    expectArgsContainSequence(recordArgs, [
      "--while",
      "--",
      "pnpm",
      "--dir",
      repoRoot,
      "openclaw",
      "qa",
      "mantis",
      "visual-driver",
    ]);
    expect(stagedVideoPath).not.toBe(finalVideoPath);
    expect(path.basename(stagedVideoPath ?? "")).toContain(path.basename(finalVideoPath));
    expect(path.basename(stagedVideoPath ?? "")).toMatch(/\.part$/);
    await expectPathMissing(stagedVideoPath ?? "");
    await expect(fs.readFile(result.screenshotPath ?? "", "utf8")).resolves.toBe("png");
    await expect(fs.readFile(result.videoPath ?? "", "utf8")).resolves.toBe("mp4");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      crabbox: { id: string; vncCommand: string };
      status: string;
      visionMode: string;
    };
    expect(summary.crabbox.id).toBe("cbx_abc123");
    expect(summary.crabbox.vncCommand).toBe(
      "/tmp/crabbox vnc --provider hetzner --id cbx_abc123 --open",
    );
    expect(summary.status).toBe("pass");
    expect(summary.visionMode).toBe("metadata");
  });

  it("fails when recording breaks after the visual driver passes", async () => {
    const commands: { args: readonly string[]; command: string }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
      if (command === "/tmp/crabbox" && args[0] === "warmup") {
        return { stdout: "ready lease cbx_abc123\n", stderr: "" };
      }
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        return {
          stdout: `${JSON.stringify({
            id: "cbx_abc123",
            provider: "hetzner",
            slug: "brisk-mantis",
            state: "active",
          })}\n`,
          stderr: "",
        };
      }
      if (command === "/tmp/crabbox" && args[0] === "record") {
        const outputDir = args[args.indexOf("--output-dir") + 1];
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(path.join(outputDir, "visual-task.png"), "png");
        await fs.writeFile(
          path.join(outputDir, "mantis-visual-task-driver-result.json"),
          `${JSON.stringify({
            browserUrl: "https://example.net",
            finishedAt: "2026-05-04T12:00:05.000Z",
            matched: true,
            outputDir,
            screenshotPath: path.join(outputDir, "visual-task.png"),
            startedAt: "2026-05-04T12:00:01.000Z",
            status: "pass",
            vision: {
              mode: "metadata",
              timeoutMs: 120000,
            },
          })}\n`,
        );
        throw new Error("crabbox record failed after driver exit");
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisVisualTask({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      env: { PATH: process.env.PATH },
      now: () => new Date("2026-05-04T12:00:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/visual-task-recording-fail",
      repoRoot,
      settleMs: 0,
      visionMode: "metadata",
    });

    expect(result.status).toBe("fail");
    expect(result.videoPath).toBeUndefined();
    expect(commands.map((entry) => [entry.command, entry.args[0]])).toEqual([
      ["/tmp/crabbox", "warmup"],
      ["/tmp/crabbox", "inspect"],
      ["/tmp/crabbox", "record"],
    ]);
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      error?: string;
      recording?: { error?: string; required: boolean };
      status: string;
    };
    expect(summary.error).toBe("crabbox record failed after driver exit");
    expect(summary.recording?.error).toBe("crabbox record failed after driver exit");
    expect(summary.recording?.required).toBe(true);
    expect(summary.status).toBe("fail");
  });

  it("preserves the video artifact when recording fails after writing output", async () => {
    const commands: { args: readonly string[]; command: string }[] = [];
    let stagedVideoPath = "";
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
      if (command === "/tmp/crabbox" && args[0] === "warmup") {
        return { stdout: "ready lease cbx_abc123\n", stderr: "" };
      }
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        return {
          stdout: `${JSON.stringify({
            id: "cbx_abc123",
            provider: "hetzner",
            slug: "brisk-mantis",
            state: "active",
          })}\n`,
          stderr: "",
        };
      }
      if (command === "/tmp/crabbox" && args[0] === "record") {
        const outputPath = args[args.indexOf("--output") + 1];
        const outputDir = args[args.indexOf("--output-dir") + 1];
        stagedVideoPath = outputPath;
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, "mp4");
        await fs.mkdir(outputDir, { recursive: true });
        await fs.writeFile(path.join(outputDir, "visual-task.png"), "png");
        await fs.writeFile(
          path.join(outputDir, "mantis-visual-task-driver-result.json"),
          `${JSON.stringify({
            browserUrl: "https://example.net",
            finishedAt: "2026-05-04T12:00:05.000Z",
            matched: true,
            outputDir,
            screenshotPath: path.join(outputDir, "visual-task.png"),
            startedAt: "2026-05-04T12:00:01.000Z",
            status: "pass",
            vision: {
              mode: "metadata",
              timeoutMs: 120000,
            },
          })}\n`,
        );
        throw new Error("crabbox record failed after writing video");
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisVisualTask({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      env: { PATH: process.env.PATH },
      now: () => new Date("2026-05-04T12:00:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/visual-task-recording-preserved",
      repoRoot,
      settleMs: 0,
      visionMode: "metadata",
    });

    expect(result.status).toBe("fail");
    expect(result.videoPath).toBe(
      path.join(
        repoRoot,
        ".artifacts/qa-e2e/mantis/visual-task-recording-preserved/visual-task.mp4",
      ),
    );
    await expect(fs.readFile(result.videoPath ?? "", "utf8")).resolves.toBe("mp4");
    await expectPathMissing(stagedVideoPath);
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      artifacts?: { videoPath?: string };
      error?: string;
      recording?: { error?: string; required: boolean };
      status: string;
    };
    expect(summary.artifacts?.videoPath).toBe(result.videoPath);
    expect(summary.error).toBe("crabbox record failed after writing video");
    expect(summary.recording?.error).toBe("crabbox record failed after writing video");
    expect(summary.recording?.required).toBe(true);
    expect(summary.status).toBe("fail");
  });

  it("drives a lease, screenshots it, and verifies image-describe text", async () => {
    const commands: { args: readonly string[]; command: string }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
      if (command === "/tmp/crabbox" && args[0] === "screenshot") {
        const outputPath = args[args.indexOf("--output") + 1];
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, "png");
      }
      if (command === "pnpm") {
        return {
          stdout: `\n> openclaw qa mantis visual-driver --vision-prompt '{"visible": boolean}'\n${JSON.stringify(
            {
              ok: true,
              outputs: [
                {
                  kind: "image.description",
                  text: JSON.stringify({
                    evidence: 'The page heading reads "Example Domain".',
                    reason: "The expected text is visible as the main heading.",
                    visible: true,
                  }),
                },
              ],
            },
          )}\n`,
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisVisualDriver({
      browserUrl: "https://example.net",
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      env: { PATH: process.env.PATH },
      expectText: "Example Domain",
      leaseId: "cbx_abc123",
      outputDir: ".artifacts/qa-e2e/mantis/visual-driver-test",
      repoRoot,
      settleMs: 0,
      visionMode: "image-describe",
      visionModel: "openai/gpt-5.4",
      visionPrompt: "Read the page title",
    });

    expect(result.status).toBe("pass");
    expect(commands.map((entry) => [entry.command, entry.args[0], entry.args[1]])).toEqual([
      ["/tmp/crabbox", "desktop", "launch"],
      ["/tmp/crabbox", "screenshot", "--provider"],
      ["pnpm", "--dir", repoRoot],
    ]);
    const launchArgs = commands.find((entry) => entry.args[0] === "desktop")?.args ?? [];
    const launchShellIndex = launchArgs.findIndex((arg) => arg === "--");
    expect(launchArgs.slice(launchShellIndex, launchShellIndex + 3)).toEqual(["--", "sh", "-lc"]);
    expect(launchArgs[launchShellIndex + 3]).toContain("--no-first-run");
    const visionArgs = commands.find((entry) => entry.command === "pnpm")?.args ?? [];
    expectArgsContainSequence(visionArgs, [
      "openclaw",
      "infer",
      "image",
      "describe",
      "--file",
      path.join(repoRoot, ".artifacts/qa-e2e/mantis/visual-driver-test/visual-task.png"),
    ]);
    const promptIndex = visionArgs.indexOf("--prompt");
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(visionArgs[promptIndex + 1]).toContain("return only valid JSON");
    const modelIndex = visionArgs.indexOf("--model");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(visionArgs[modelIndex + 1]).toBe("openai/gpt-5.4");
    expect(result.vision.assertion?.evidence).toBe('The page heading reads "Example Domain".');
    expect(result.vision.assertion?.matched).toBe(true);
    expect(result.vision.assertion?.visible).toBe(true);
  });

  it("fails image-describe text checks when the model gives negative evidence that quotes the target", async () => {
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "/tmp/crabbox" && args[0] === "screenshot") {
        const outputPath = args[args.indexOf("--output") + 1];
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, "png");
      }
      if (command === "pnpm") {
        return {
          stdout: `${JSON.stringify({
            ok: true,
            outputs: [
              {
                kind: "image.description",
                text: 'The screenshot does not contain "Example Domain".',
              },
            ],
          })}\n`,
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisVisualDriver({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      expectText: "Example Domain",
      leaseId: "cbx_abc123",
      outputDir: ".artifacts/qa-e2e/mantis/visual-driver-negative",
      repoRoot,
      settleMs: 0,
      visionMode: "image-describe",
    });

    expect(result.matched).toBe(false);
    expect(result.status).toBe("fail");
    expect(result.vision.assertion?.matched).toBe(false);
    expect(result.vision.assertion?.reason).toBe(
      "Image describe did not return a structured visual assertion.",
    );
  });

  it("fails metadata mode when text evidence is requested", async () => {
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "/tmp/crabbox" && args[0] === "screenshot") {
        const outputPath = args[args.indexOf("--output") + 1];
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, "png");
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisVisualDriver({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      expectText: "Example Domain",
      leaseId: "cbx_abc123",
      outputDir: ".artifacts/qa-e2e/mantis/visual-driver-metadata",
      repoRoot,
      settleMs: 0,
      visionMode: "metadata",
    });

    expect(result.matched).toBe(false);
    expect(result.status).toBe("fail");
    expect(result.vision.mode).toBe("metadata");
  });
});
