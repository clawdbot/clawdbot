import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMantisSlackDesktopSmoke } from "./slack-desktop-smoke.runtime.js";

describe("mantis Slack desktop smoke runtime", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-slack-desktop-smoke-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it("leases a desktop box, runs Slack QA inside it, copies artifacts, and stops on pass", async () => {
    const commands: { args: readonly string[]; command: string; env?: NodeJS.ProcessEnv }[] = [];
    const runtimeEnv = {
      PATH: process.env.PATH,
      OPENAI_API_KEY: "openai-runtime-key",
      OPENCLAW_QA_SLACK_CHANNEL_ID: "C123",
      OPENCLAW_QA_SLACK_DRIVER_BOT_TOKEN: "driver-token",
      OPENCLAW_QA_SLACK_SUT_APP_TOKEN: "app-token",
      OPENCLAW_QA_SLACK_SUT_BOT_TOKEN: "sut-token",
    };
    const runner = vi.fn(
      async (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        commands.push({ command, args, env: options.env });
        if (command === "/tmp/crabbox" && args[0] === "warmup") {
          return { stdout: "ready lease cbx_abc123\n", stderr: "" };
        }
        if (command === "/tmp/crabbox" && args[0] === "inspect") {
          return {
            stdout: `${JSON.stringify({
              host: "203.0.113.10",
              id: "cbx_abc123",
              provider: "hetzner",
              slug: "bright-mantis",
              sshKey: "/tmp/key",
              sshPort: "2222",
              sshUser: "crabbox",
              state: "active",
            })}\n`,
            stderr: "",
          };
        }
        if (command === "rsync") {
          const outputDir = args.at(-1);
          expect(outputDir).toBeTypeOf("string");
          await fs.mkdir(outputDir as string, { recursive: true });
          if (String(outputDir).endsWith("slack-qa/")) {
            await fs.writeFile(path.join(outputDir as string, "slack-qa-report.md"), "# Slack\n");
          } else {
            await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.png"), "png");
            await fs.writeFile(path.join(outputDir as string, "remote-metadata.json"), "{}\n");
            await fs.writeFile(path.join(outputDir as string, "chrome.log"), "chrome\n");
            await fs.writeFile(path.join(outputDir as string, "slack-desktop-command.log"), "qa\n");
          }
          return { stdout: "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    );

    const result = await runMantisSlackDesktopSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      env: runtimeEnv,
      now: () => new Date("2026-05-04T13:00:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-test",
      primaryModel: "openai/gpt-5.4",
      repoRoot,
      scenarioIds: ["slack-canary"],
      slackUrl: "https://app.slack.com/client/T123/C123",
    });

    expect(result.status).toBe("pass");
    expect(commands.map((entry) => [entry.command, entry.args[0]])).toEqual([
      ["/tmp/crabbox", "warmup"],
      ["/tmp/crabbox", "inspect"],
      ["/tmp/crabbox", "run"],
      ["rsync", "-az"],
      ["rsync", "-az"],
      ["/tmp/crabbox", "stop"],
    ]);
    expect(
      commands.every((entry) => entry.env?.OPENCLAW_LIVE_OPENAI_KEY === "openai-runtime-key"),
    ).toBe(true);
    const runArgs = commands.find(
      (entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "run",
    )?.args;
    expect(runArgs).not.toContain("--no-sync");
    const remoteScript = runArgs?.at(-1);
    expect(remoteScript).toContain("${BROWSER:-}");
    expect(remoteScript).toContain("${CHROME_BIN:-}");
    expect(remoteScript).toContain("pnpm install --frozen-lockfile");
    expect(remoteScript).toContain("pnpm build");
    expect(remoteScript).toContain("openclaw qa slack");
    expect(remoteScript).toContain("--scenario 'slack-canary'");
    expect(remoteScript).toContain("OPENCLAW_MANTIS_SLACK_BROWSER_PROFILE_DIR");
    const rsyncArgs = commands
      .filter((entry) => entry.command === "rsync")
      .flatMap((entry) => entry.args);
    expect(rsyncArgs).not.toContain("--delete");
    expect(rsyncArgs).toEqual(
      expect.arrayContaining([
        "crabbox@203.0.113.10:/tmp/openclaw-mantis-slack-desktop-2026-05-04T13-00-00-000Z/slack-desktop-smoke.png",
        "crabbox@203.0.113.10:/tmp/openclaw-mantis-slack-desktop-2026-05-04T13-00-00-000Z/slack-qa/",
      ]),
    );
    await expect(fs.readFile(result.screenshotPath ?? "", "utf8")).resolves.toBe("png");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      crabbox: { id: string; vncCommand: string };
      status: string;
    };
    expect(summary).toMatchObject({
      crabbox: {
        id: "cbx_abc123",
        vncCommand: "/tmp/crabbox vnc --provider hetzner --id cbx_abc123 --open",
      },
      status: "pass",
    });
  });

  it("copies the screenshot before reporting a failed remote Slack QA run", async () => {
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        return {
          stdout: `${JSON.stringify({
            host: "203.0.113.10",
            id: "cbx_existing",
            provider: "hetzner",
            sshKey: "/tmp/key",
            sshPort: "2222",
            sshUser: "crabbox",
          })}\n`,
          stderr: "",
        };
      }
      if (command === "/tmp/crabbox" && args[0] === "run") {
        throw new Error("remote Slack QA failed");
      }
      if (command === "rsync") {
        const outputDir = args.at(-1);
        await fs.mkdir(outputDir as string, { recursive: true });
        await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.png"), "png");
        await fs.writeFile(path.join(outputDir as string, "remote-metadata.json"), "{}\n");
        await fs.writeFile(path.join(outputDir as string, "chrome.log"), "chrome\n");
        await fs.writeFile(path.join(outputDir as string, "slack-desktop-command.log"), "qa\n");
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisSlackDesktopSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      leaseId: "cbx_existing",
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-fail",
      repoRoot,
    });

    expect(result.status).toBe("fail");
    expect(result.screenshotPath).toBe(path.join(result.outputDir, "slack-desktop-smoke.png"));
    await expect(
      fs.readFile(path.join(result.outputDir, "slack-desktop-smoke.png"), "utf8"),
    ).resolves.toBe("png");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      artifacts: { screenshotPath?: string };
      error?: string;
      status: string;
    };
    expect(summary.status).toBe("fail");
    expect(summary.error).toContain("remote Slack QA failed");
    expect(summary.artifacts.screenshotPath).toContain("slack-desktop-smoke.png");
  });

  it("accepts Blacksmith Testbox lease ids from Crabbox warmup", async () => {
    const commands: { args: readonly string[]; command: string }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
      if (command === "/tmp/crabbox" && args[0] === "warmup") {
        return { stdout: "ready: tbx_abc-123_more\n", stderr: "" };
      }
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        return {
          stdout: `${JSON.stringify({
            host: "203.0.113.10",
            id: "tbx_abc-123_more",
            provider: "blacksmith-testbox",
            sshKey: "/tmp/key",
            sshPort: "2222",
            sshUser: "crabbox",
            state: "active",
          })}\n`,
          stderr: "",
        };
      }
      if (command === "rsync") {
        const outputDir = args.at(-1);
        await fs.mkdir(outputDir as string, { recursive: true });
        if (String(outputDir).endsWith("slack-qa/")) {
          await fs.writeFile(path.join(outputDir as string, "slack-qa-report.md"), "# Slack\n");
        } else {
          await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.png"), "png");
          await fs.writeFile(path.join(outputDir as string, "remote-metadata.json"), "{}\n");
          await fs.writeFile(path.join(outputDir as string, "chrome.log"), "chrome\n");
          await fs.writeFile(path.join(outputDir as string, "slack-desktop-command.log"), "qa\n");
        }
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisSlackDesktopSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      now: () => new Date("2026-05-04T13:30:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-testbox",
      provider: "blacksmith-testbox",
      repoRoot,
    });

    expect(result.status).toBe("pass");
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          args: expect.arrayContaining(["--id", "tbx_abc-123_more"]),
          command: "/tmp/crabbox",
        }),
      ]),
    );
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      crabbox: { id: string; provider: string };
    };
    expect(summary.crabbox).toMatchObject({
      id: "tbx_abc-123_more",
      provider: "blacksmith-testbox",
    });
  });
});
