import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMantisBeforeAfter } from "./run.runtime.js";

describe("mantis before/after runtime", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-before-after-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it("runs baseline and candidate worktrees and writes stable comparison artifacts", async () => {
    const commands: { args: readonly string[]; command: string; cwd?: string }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
      if (command !== "pnpm" || !args.includes("openclaw")) {
        return;
      }
      const repoRootArg = args[args.indexOf("--repo-root") + 1];
      const outputDirArg = args[args.indexOf("--output-dir") + 1];
      const lane = outputDirArg.endsWith("baseline") ? "baseline" : "candidate";
      const outputDir = path.join(repoRootArg, outputDirArg);
      await fs.mkdir(outputDir, { recursive: true });
      const screenshotPath = path.join(outputDir, `${lane}-timeline.png`);
      await fs.writeFile(screenshotPath, `${lane} screenshot`);
      await fs.writeFile(
        path.join(outputDir, "discord-qa-summary.json"),
        `${JSON.stringify(
          {
            scenarios: [
              {
                artifactPaths: { screenshot: screenshotPath },
                details:
                  lane === "baseline"
                    ? "reaction timeline missing thinking/done"
                    : "reaction timeline matched queued -> thinking -> done",
                id: "discord-status-reactions-tool-only",
                status: lane === "baseline" ? "fail" : "pass",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
    });

    const result = await runMantisBeforeAfter({
      baseline: "bug-sha",
      candidate: "fix-sha",
      commandRunner: runner,
      now: () => new Date("2026-05-03T12:00:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/test-run",
      repoRoot,
      skipBuild: true,
      skipInstall: true,
    });

    expect(result.status).toBe("pass");
    expect(
      commands.map((entry) => [
        entry.command,
        entry.args[0],
        entry.args[1],
        entry.args[2],
        entry.args[3],
      ]),
    ).toEqual([
      ["git", "worktree", "add", "--detach", expect.stringContaining("baseline")],
      ["pnpm", "--dir", expect.stringContaining("baseline"), "openclaw", "qa"],
      ["git", "worktree", "add", "--detach", expect.stringContaining("candidate")],
      ["pnpm", "--dir", expect.stringContaining("candidate"), "openclaw", "qa"],
    ]);

    const comparison = JSON.parse(await fs.readFile(result.comparisonPath, "utf8")) as {
      baseline: { reproduced: boolean; status: string };
      candidate: { fixed: boolean; status: string };
      pass: boolean;
    };
    expect(comparison).toMatchObject({
      baseline: { reproduced: true, status: "fail" },
      candidate: { fixed: true, status: "pass" },
      pass: true,
    });
    await expect(
      fs.readFile(path.join(result.outputDir, "baseline", "baseline.png"), "utf8"),
    ).resolves.toBe("baseline screenshot");
    await expect(
      fs.readFile(path.join(result.outputDir, "candidate", "candidate.png"), "utf8"),
    ).resolves.toBe("candidate screenshot");
  });
});
