// Qa Lab tests cover slack desktop smoke plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMantisSlackDesktopSmoke } from "./slack-desktop-smoke.runtime.js";

function describeFetchInput(input: RequestInfo | URL) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function describeFetchBody(body: BodyInit | null | undefined) {
  if (body == null) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return `[${body.constructor.name}]`;
}

function phaseStatus(
  phases: Array<{ name: string; status: string }>,
  name: string,
): string | undefined {
  return phases.find((phase) => phase.name === name)?.status;
}

async function writeApprovalCheckpointArtifacts(outputDir: string, scenarioIds: readonly string[]) {
  const checkpointDir = path.join(outputDir, "approval-checkpoints");
  await fs.mkdir(checkpointDir, { recursive: true });
  for (const scenarioId of scenarioIds) {
    for (const state of ["pending", "resolved"] as const) {
      await fs.writeFile(
        path.join(checkpointDir, `${scenarioId}.${state}.json`),
        `${JSON.stringify({
          version: 1,
          scenarioId,
          approvalKind: scenarioId.includes("plugin") ? "plugin" : "exec",
          state,
          approvalId: scenarioId.includes("plugin") ? "plugin:abc" : "exec-abc",
          channelId: "C123456789",
          messageTs: "1.000000",
          threadTs: null,
          decision: state === "resolved" ? "allow-once" : null,
          observedAt: "2026-05-04T13:00:29.000Z",
          message: {
            actionLabels: state === "pending" ? ["Allow Once", "Allow Always", "Deny"] : [],
            blockText:
              state === "pending"
                ? ["Plugin approval required", "Slack plugin approval QA marker"]
                : ["Plugin approval: Allowed once", "Slack plugin approval QA marker"],
            hasNativeActions: state === "pending",
            text:
              state === "pending" ? "Plugin approval required" : "Plugin approval: Allowed once",
          },
        })}\n`,
      );
      await fs.writeFile(
        path.join(checkpointDir, `${scenarioId}.${state}.ack.json`),
        `${JSON.stringify({
          version: 1,
          capturedAt: "2026-05-04T13:00:30.000Z",
          scenarioId,
          screenshotPath: `${checkpointDir}/${scenarioId}-${state}.png`,
          state,
        })}\n`,
      );
      await fs.writeFile(path.join(checkpointDir, `${scenarioId}-${state}.png`), "png");
    }
  }
}

function mockMantisCliRuntime(runMantisSlackDesktopSmokeCommand = vi.fn()) {
  vi.doMock("./cli.runtime.js", () => ({
    runMantisBeforeAfterCommand: vi.fn(),
    runMantisDesktopBrowserSmokeCommand: vi.fn(),
    runMantisDiscordSmokeCommand: vi.fn(),
    runMantisSlackDesktopSmokeCommand,
    runMantisTelegramDesktopBuilderCommand: vi.fn(),
    runMantisVisualDriverCommand: vi.fn(),
    runMantisVisualTaskCommand: vi.fn(),
  }));
  return runMantisSlackDesktopSmokeCommand;
}

describe("mantis Slack desktop smoke runtime", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-slack-desktop-smoke-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
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
            await fs.writeFile(path.join(outputDir as string, "qa-suite-report.md"), "# Slack\n");
          } else {
            await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.png"), "png");
            await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.mp4"), "mp4");
            await fs.writeFile(
              path.join(outputDir as string, "remote-metadata.json"),
              `${JSON.stringify({ qaExitCode: 0 })}\n`,
            );
            await fs.writeFile(path.join(outputDir as string, "chrome.log"), "chrome\n");
            await fs.writeFile(path.join(outputDir as string, "ffmpeg.log"), "ffmpeg\n");
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
      freshPr: "openclaw/openclaw#85141",
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
    expect(runArgs).toContain("--no-hydrate");
    expect(runArgs).toContain("--fresh-pr");
    expect(runArgs).toContain("openclaw/openclaw#85141");
    expect(runArgs).not.toContain("--no-sync");
    const remoteScript = runArgs?.at(-1);
    expect(remoteScript).toContain("hydrate_mode='source'");
    expect(remoteScript).toContain("${BROWSER:-}");
    expect(remoteScript).toContain("${CHROME_BIN:-}");
    expect(remoteScript).toContain("PNPM_STORE_DIR");
    expect(remoteScript).toContain("build-essential python3");
    expect(remoteScript).toContain("node_supports_type_stripping");
    expect(remoteScript).toContain("scripts/crabbox-untrusted-bootstrap.sh");
    expect(remoteScript).toContain("https://nodejs.org/dist/v$node_version");
    expect(remoteScript).toContain('grep "  $node_archive$" SHASUMS256.txt | sha256sum -c -');
    expect(remoteScript).toContain('export PATH="$node_root/bin:$PATH"');
    expect(remoteScript).toContain("packageManager ??");
    expect(remoteScript).toContain("[0-9a-f]{128}");
    expect(remoteScript).toContain('console.log(match[1] + " " + match[2])');
    expect(remoteScript).toContain('active_pnpm_version="$(pnpm --version 2>/dev/null || true)"');
    expect(remoteScript).toContain("https://registry.npmjs.org/pnpm/-/pnpm-$pnpm_version.tgz");
    expect(remoteScript).toContain('sha512sum "$pnpm_archive"');
    expect(remoteScript).toContain('chmod +x "$pnpm_cli"');
    expect(remoteScript).toContain('ln -sfn "$pnpm_cli" "$pnpm_bin_dir/pnpm"');
    expect(remoteScript).toContain('export PATH="$pnpm_bin_dir:$PATH"');
    expect(remoteScript).toContain("Expected pnpm $pnpm_version, got $active_pnpm_version.");
    expect(remoteScript).toContain("pnpm install --frozen-lockfile --prefer-offline");
    expect(remoteScript).toContain("pnpm build");
    expect(remoteScript).toContain("ffmpeg");
    expect(remoteScript).toContain('sudo apt-get update -y >>"$out/apt.log" 2>&1 || true');
    expect(remoteScript).toContain("slack-desktop-smoke.mp4");
    expect(remoteScript).not.toContain("-video_size");
    expect(remoteScript).toContain("openclaw qa slack");
    expect(remoteScript).toContain("--scenario 'slack-canary'");
    expect(remoteScript).toContain(
      'slack_qa_output_dir=".artifacts/qa-e2e/mantis/$(basename "$out")/slack-qa"',
    );
    expect(remoteScript).toContain('--output-dir "$slack_qa_output_dir"');
    expect(remoteScript).toContain("copy_slack_qa_artifacts");
    expect(remoteScript).not.toContain('--output-dir "$out/slack-qa"');
    expect(remoteScript).toContain("remote_command_timeout_seconds=");
    expect(remoteScript).toContain("remote-command-timeout.txt");
    expect(remoteScript).toContain(
      'timeout --kill-after=15s "${remote_command_timeout_seconds}s" bash -c run_mantis_remote_body >"$out/slack-desktop-command.log" 2>&1 &',
    );
    expect(remoteScript).toContain("MANTIS_REMOTE_HEARTBEAT");
    expect(remoteScript).toContain("qa_status=$?");
    expect(remoteScript).toContain("MANTIS_REMOTE_FAILURE_DIAGNOSTICS_BEGIN");
    expect(remoteScript).toContain("$out/slack-qa/qa-suite-report.md");
    expect(remoteScript).toContain("$out/slack-qa/qa-suite-summary.json");
    expect(remoteScript).toContain("$out/slack-qa/qa-evidence.json");
    expect(remoteScript).toContain('tail -n 200 "$diagnostic_file"');
    expect(remoteScript).toContain("Slack desktop screenshot is missing or empty");
    expect(remoteScript).not.toContain('test -s "$out/slack-desktop-smoke.png"');
    expect(remoteScript).toContain("OPENCLAW_MANTIS_SLACK_BROWSER_PROFILE_DIR");
    expect(remoteScript)
      .toContain(`const response = await fetch("https://slack.com/api/auth.test", {
  method: "POST",
  headers: { authorization: \`Bearer \${token}\` },
  signal: AbortSignal.timeout(15_000),
});`);
    const rsyncArgs = commands
      .filter((entry) => entry.command === "rsync")
      .flatMap((entry) => entry.args);
    expect(rsyncArgs).not.toContain("--delete");
    expect(rsyncArgs).toContain(
      "crabbox@203.0.113.10:/tmp/openclaw-mantis-slack-desktop-2026-05-04T13-00-00-000Z/",
    );
    expect(rsyncArgs).toContain(
      "crabbox@203.0.113.10:/tmp/openclaw-mantis-slack-desktop-2026-05-04T13-00-00-000Z/slack-qa/",
    );
    await expect(fs.readFile(result.screenshotPath ?? "", "utf8")).resolves.toBe("png");
    await expect(fs.readFile(result.videoPath ?? "", "utf8")).resolves.toBe("mp4");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      crabbox: { id: string; vncCommand: string };
      hydrateMode: string;
      status: string;
      timings: { phases: { name: string; status: string }[]; totalMs: number };
    };
    expect(summary.crabbox.id).toBe("cbx_abc123");
    expect(summary.crabbox.vncCommand).toBe(
      "/tmp/crabbox vnc --provider hetzner --id cbx_abc123 --open",
    );
    expect(summary.hydrateMode).toBe("source");
    expect(summary.status).toBe("pass");
    expect(summary.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(summary.timings.phases.map((phase) => phase.name)).toContain("crabbox.warmup");
    expect(summary.timings.phases.map((phase) => phase.name)).toContain("crabbox.inspect");
    expect(summary.timings.phases.map((phase) => phase.name)).toContain("credentials.prepare");
    expect(summary.timings.phases.map((phase) => phase.name)).toContain("crabbox.remote_run");
    expect(summary.timings.phases.map((phase) => phase.name)).toContain("artifacts.copy");
  });

  it("runs approval checkpoint mode with default approval scenarios and records screenshots", async () => {
    const commands: { args: readonly string[]; command: string }[] = [];
    const expectedScenarios = ["slack-approval-exec-native", "slack-approval-plugin-native"];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
      if (command === "/tmp/crabbox" && args[0] === "warmup") {
        return { stdout: "ready lease cbx_123abc\n", stderr: "" };
      }
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        return {
          stdout: `${JSON.stringify({
            host: "203.0.113.10",
            id: "cbx_123abc",
            provider: "hetzner",
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
          await fs.writeFile(path.join(outputDir as string, "qa-suite-report.md"), "# Slack\n");
        } else {
          await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.png"), "png");
          await fs.writeFile(
            path.join(outputDir as string, "remote-metadata.json"),
            `${JSON.stringify({ qaExitCode: 0 })}\n`,
          );
          await fs.writeFile(path.join(outputDir as string, "slack-desktop-command.log"), "qa\n");
          await writeApprovalCheckpointArtifacts(outputDir as string, expectedScenarios);
        }
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisSlackDesktopSmoke({
      approvalCheckpoints: true,
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      now: () => new Date("2026-05-04T13:15:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-checkpoints",
      repoRoot,
    });

    expect(result.status).toBe("pass");
    expect(result.approvalCheckpointScreenshotPaths).toHaveLength(4);
    const remoteScript = commands
      .find((entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "run")
      ?.args.at(-1);
    expect(remoteScript).toContain("approval_checkpoints=1");
    expect(remoteScript).toContain('export OPENCLAW_QA_SLACK_CHANNEL_ID="$slack_channel_id"');
    expect(remoteScript).toContain("--scenario 'slack-approval-exec-native'");
    expect(remoteScript).toContain("--scenario 'slack-approval-plugin-native'");
    expect(remoteScript).toContain("OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_DIR");
    expect(remoteScript).toContain("OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_TIMEOUT_MS");
    expect(remoteScript).toContain('cat >"$out/approval-checkpoint-watcher.mjs"');
    expect(remoteScript).not.toContain('node >"$out/approval-checkpoint-watcher.mjs"');
    expect(remoteScript).toContain("approval-checkpoint-watcher.mjs");
    expect(remoteScript).toContain("OPENCLAW_MANTIS_APPROVAL_BROWSER_BIN");
    expect(remoteScript).toContain("Rendered from the Slack API message observed by QA");
    expect(remoteScript).toContain("class='wrap'");
    expect(remoteScript).toContain("--headless=new");
    expect(remoteScript).not.toContain('spawn("scrot", [screenshotPath]');
    expect(remoteScript).toContain("Slack QA exited before all expected approval checkpoints");
    expect(remoteScript).toContain('if [ "$qa_exit" -eq 0 ]; then\n        wait "$watcher_pid"');
    expect(remoteScript).toContain(
      'cp "$out/approval-checkpoints/slack-approval-plugin-native-pending.png" "$out/slack-desktop-smoke.png"',
    );
    expect(remoteScript).toContain(
      'cp "$out/approval-checkpoints/slack-approval-exec-native-pending.png" "$out/slack-desktop-smoke.png"',
    );
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      artifacts: {
        approvalCheckpoints?: {
          directoryPath: string;
          screenshots: { scenarioId: string; screenshotPath: string; state: string }[];
        };
      };
    };
    expect(summary.artifacts.approvalCheckpoints?.screenshots).toHaveLength(4);
    expect(
      summary.artifacts.approvalCheckpoints?.screenshots.map((screenshot) =>
        path.relative(result.outputDir, screenshot.screenshotPath),
      ),
    ).toEqual([
      "approval-checkpoints/slack-approval-exec-native-pending.png",
      "approval-checkpoints/slack-approval-exec-native-resolved.png",
      "approval-checkpoints/slack-approval-plugin-native-pending.png",
      "approval-checkpoints/slack-approval-plugin-native-resolved.png",
    ]);
    await expect(fs.readFile(result.reportPath, "utf8")).resolves.toContain(
      "Approval checkpoint slack-approval-plugin-native resolved",
    );
  });

  it("rejects non-approval scenarios in approval checkpoint mode", async () => {
    await expect(
      runMantisSlackDesktopSmoke({
        approvalCheckpoints: true,
        crabboxBin: "/tmp/crabbox",
        repoRoot,
        scenarioIds: ["slack-canary"],
      }),
    ).rejects.toThrow("--approval-checkpoints only supports approval checkpoint scenarios");
  });

  it.each([
    {
      expectedScenarioIds: ["slack-codex-approval-exec-native"],
      label: "command",
      remoteTimeoutSeconds: 1_250,
      requestedScenarioIds: ["slack-codex-approval-exec-native"],
    },
    {
      expectedScenarioIds: ["slack-codex-approval-plugin-native"],
      label: "file",
      remoteTimeoutSeconds: 1_250,
      requestedScenarioIds: ["slack-codex-approval-plugin-native"],
    },
    {
      expectedScenarioIds: [
        "slack-codex-approval-exec-native",
        "slack-codex-approval-plugin-native",
      ],
      label: "command and file",
      remoteTimeoutSeconds: 1_900,
      requestedScenarioIds: [
        "slack-codex-approval-plugin-native",
        "slack-codex-approval-exec-native",
        "slack-codex-approval-plugin-native",
      ],
    },
  ])(
    "accepts the opt-in Codex $label checkpoint scenarios",
    async ({ expectedScenarioIds, remoteTimeoutSeconds, requestedScenarioIds }) => {
      const commands: { args: readonly string[]; command: string }[] = [];
      const runner = vi.fn(async (command: string, args: readonly string[]) => {
        commands.push({ command, args });
        if (command === "/tmp/crabbox" && args[0] === "warmup") {
          return { stdout: "ready lease cbx_123abc\n", stderr: "" };
        }
        if (command === "/tmp/crabbox" && args[0] === "inspect") {
          return {
            stdout: `${JSON.stringify({
              host: "203.0.113.10",
              id: "cbx_123abc",
              provider: "hetzner",
              sshKey: "/tmp/key",
              sshPort: "2222",
              sshUser: "crabbox",
              state: "active",
            })}\n`,
            stderr: "",
          };
        }
        if (command === "/tmp/crabbox" && args[0] === "run") {
          throw new Error("stop after remote script capture");
        }
        return { stdout: "", stderr: "" };
      });

      const result = await runMantisSlackDesktopSmoke({
        approvalCheckpoints: true,
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        outputDir: `.artifacts/qa-e2e/mantis/${requestedScenarioIds.join("-")}`,
        repoRoot,
        scenarioIds: requestedScenarioIds,
      });

      expect(result.status).toBe("fail");
      const remoteScript = commands
        .find((entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "run")
        ?.args.at(-1);
      for (const scenarioId of expectedScenarioIds) {
        expect(remoteScript?.split(`--scenario '${scenarioId}'`)).toHaveLength(3);
      }
      expect(remoteScript).toContain(
        expectedScenarioIds.map((scenarioId) => `--scenario '${scenarioId}'`).join(" "),
      );
      expect(remoteScript).toContain("OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_TIMEOUT_MS:-470000");
      expect(remoteScript).toContain(
        `OPENCLAW_MANTIS_REMOTE_COMMAND_TIMEOUT_SECONDS:-${remoteTimeoutSeconds}`,
      );
    },
  );

  it("fails approval checkpoint mode when ack metadata does not match the expected state", async () => {
    const expectedScenarios = ["slack-approval-exec-native", "slack-approval-plugin-native"];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "/tmp/crabbox" && args[0] === "warmup") {
        return { stdout: "ready lease cbx_123abc\n", stderr: "" };
      }
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        return {
          stdout: `${JSON.stringify({
            host: "203.0.113.10",
            id: "cbx_123abc",
            provider: "hetzner",
            sshKey: "/tmp/key",
            sshPort: "2222",
            sshUser: "crabbox",
            state: "active",
          })}\n`,
          stderr: "",
        };
      }
      if (command === "rsync") {
        const outputDir = args.at(-1) as string;
        await fs.mkdir(outputDir, { recursive: true });
        if (!outputDir.endsWith("slack-qa/")) {
          await fs.writeFile(path.join(outputDir, "slack-desktop-smoke.png"), "png");
          await fs.writeFile(
            path.join(outputDir, "remote-metadata.json"),
            `${JSON.stringify({ qaExitCode: 0 })}\n`,
          );
          await fs.writeFile(path.join(outputDir, "slack-desktop-command.log"), "qa\n");
          await writeApprovalCheckpointArtifacts(outputDir, expectedScenarios);
          await fs.writeFile(
            path.join(
              outputDir,
              "approval-checkpoints",
              "slack-approval-plugin-native.resolved.ack.json",
            ),
            `${JSON.stringify({
              version: 1,
              capturedAt: "2026-05-04T13:00:30.000Z",
              scenarioId: "slack-approval-plugin-native",
              screenshotPath: `${outputDir}/approval-checkpoints/slack-approval-plugin-native-resolved.png`,
              state: "pending",
            })}\n`,
          );
        }
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisSlackDesktopSmoke({
      approvalCheckpoints: true,
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-bad-checkpoints",
      repoRoot,
    });

    expect(result.status).toBe("fail");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      error?: string;
    };
    expect(summary.error).toContain("unexpected state");
  });

  it("rejects approval checkpoints with gateway setup", async () => {
    await expect(
      runMantisSlackDesktopSmoke({
        approvalCheckpoints: true,
        crabboxBin: "/tmp/crabbox",
        gatewaySetup: true,
        repoRoot,
      }),
    ).rejects.toThrow("--approval-checkpoints cannot be used with --gateway-setup");
  });

  it("supports prehydrated remote workspaces without installing or building inside the VM", async () => {
    const commands: { args: readonly string[]; command: string }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        return {
          stdout: `${JSON.stringify({
            host: "203.0.113.10",
            id: "cbx_warm",
            provider: "hetzner",
            sshKey: "/tmp/key",
            sshPort: "2222",
            sshUser: "crabbox",
          })}\n`,
          stderr: "",
        };
      }
      if (command === "rsync") {
        const outputDir = args.at(-1);
        await fs.mkdir(outputDir as string, { recursive: true });
        if (!String(outputDir).endsWith("slack-qa/")) {
          await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.png"), "png");
          await fs.writeFile(
            path.join(outputDir as string, "remote-metadata.json"),
            `${JSON.stringify({ hydrateMode: "prehydrated", qaExitCode: 0 })}\n`,
          );
        }
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisSlackDesktopSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      hydrateMode: "prehydrated",
      leaseId: "cbx_warm",
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-prehydrated",
      repoRoot,
    });

    expect(result.status).toBe("pass");
    const remoteScript = commands
      .find((entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "run")
      ?.args.at(-1);
    expect(remoteScript).toContain("hydrate_mode='prehydrated'");
    expect(remoteScript).toContain("hydrate-mode=prehydrated requires node_modules");
    expect(remoteScript).toContain("hydrate-mode=prehydrated requires a built dist/ directory");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      hydrateMode: string;
      timings: { phases: { name: string; status: string }[] };
    };
    expect(summary.hydrateMode).toBe("prehydrated");
    expect(summary.timings.phases.map((phase) => phase.name)).not.toContain("crabbox.warmup");
  });

  it("leases Convex Slack credentials for gateway setup and maps them into the VM env", async () => {
    const commands: { args: readonly string[]; command: string; env?: NodeJS.ProcessEnv }[] = [];
    const events: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = describeFetchInput(input);
      if (url.endsWith("/acquire")) {
        events.push("acquire");
        return new Response(
          JSON.stringify({
            credentialId: "cred-slack",
            heartbeatIntervalMs: 600_000,
            leaseToken: "lease-slack",
            leaseTtlMs: 900_000,
            payload: {
              channelId: "CLEASED",
              sutAppToken: "xapp-leased",
              sutBotToken: "xoxb-leased",
            },
            status: "ok",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/release") || url.endsWith("/heartbeat")) {
        events.push(url.endsWith("/release") ? "release" : "heartbeat");
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url} ${describeFetchBody(init?.body)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = vi.fn(
      async (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        commands.push({ command, args, env: options.env });
        events.push(`${command}:${args[0]}`);
        if (command === "/tmp/crabbox" && args[0] === "warmup") {
          return { stdout: "ready lease cbx_c0ffee\n", stderr: "" };
        }
        if (command === "/tmp/crabbox" && args[0] === "inspect") {
          return {
            stdout: `${JSON.stringify({
              host: "203.0.113.10",
              id: "cbx_c0ffee",
              provider: "hetzner",
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
          if (!String(outputDir).endsWith("slack-qa/")) {
            await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.png"), "png");
            await fs.writeFile(
              path.join(outputDir as string, "remote-metadata.json"),
              `${JSON.stringify({
                gatewayAlive: true,
                gatewayPid: "1234",
                openedUrl: "https://app.slack.com/client/TLEASED/CLEASED",
                qaExitCode: 0,
              })}\n`,
            );
            await fs.writeFile(path.join(outputDir as string, "slack-desktop-command.log"), "qa\n");
          }
        }
        return { stdout: "", stderr: "" };
      },
    );

    const result = await runMantisSlackDesktopSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      credentialRole: "ci",
      credentialSource: "convex",
      env: {
        CI: "1",
        OPENAI_API_KEY: "openai-runtime-key",
        OPENCLAW_QA_CONVEX_SECRET_CI: "convex-secret",
        OPENCLAW_QA_CONVEX_SITE_URL: "https://example.convex.site",
        PATH: process.env.PATH,
      },
      gatewaySetup: true,
      keepLease: false,
      now: () => new Date("2026-05-04T14:00:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-convex",
      repoRoot,
    });

    expect(result.status).toBe("pass");
    expect(events).toContain("/tmp/crabbox:warmup");
    expect(events).toContain("/tmp/crabbox:inspect");
    expect(events).toContain("acquire");
    expect(events).toContain("/tmp/crabbox:run");
    expect(events).toContain("release");
    expect(events.indexOf("acquire")).toBeGreaterThan(events.indexOf("/tmp/crabbox:inspect"));
    expect(events.indexOf("acquire")).toBeLessThan(events.indexOf("/tmp/crabbox:run"));
    const runCommand = commands.find(
      (entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "run",
    );
    expect(runCommand?.env?.OPENCLAW_MANTIS_SLACK_APP_TOKEN).toBe("xapp-leased");
    expect(runCommand?.env?.OPENCLAW_MANTIS_SLACK_BOT_TOKEN).toBe("xoxb-leased");
    expect(runCommand?.env?.OPENCLAW_MANTIS_SLACK_CHANNEL_ID).toBe("CLEASED");
    expect(runCommand?.env?.OPENCLAW_QA_SLACK_CHANNEL_ID).toBe("CLEASED");
    expect(runCommand?.env?.OPENCLAW_QA_SLACK_SUT_APP_TOKEN).toBe("xapp-leased");
    expect(runCommand?.env?.OPENCLAW_QA_SLACK_SUT_BOT_TOKEN).toBe("xoxb-leased");
    const remoteScript = runCommand?.args.at(-1);
    expect(remoteScript).toContain("setup_gateway=1");
    expect(remoteScript).toContain("openclaw gateway run");
    expect(remoteScript).toContain('</dev/null >"$out/openclaw-gateway.log"');
    expect(remoteScript).toContain('kill -0 "$gateway_pid"');
    expect(remoteScript).toContain('disown "$gateway_pid"');
    expect(fetchMock.mock.calls.map(([url]) => describeFetchInput(url))).toEqual([
      "https://example.convex.site/qa-credentials/v1/acquire",
      "https://example.convex.site/qa-credentials/v1/release",
    ]);
    expect(
      commands.some((entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "stop"),
    ).toBe(true);
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      slackUrl: string;
    };
    expect(summary.slackUrl).toBe("https://app.slack.com/client/TLEASED/CLEASED");
  });

  it("stops a created no-keep lease when the remote Slack QA run fails", async () => {
    const commands: { args: readonly string[]; command: string }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
      if (command === "/tmp/crabbox" && args[0] === "warmup") {
        return { stdout: "ready lease cbx_fade123\n", stderr: "" };
      }
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        return {
          stdout: `${JSON.stringify({
            host: "203.0.113.10",
            id: "cbx_fade123",
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
        if (!String(outputDir).endsWith("slack-qa/")) {
          await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.png"), "png");
          await fs.writeFile(path.join(outputDir as string, "remote-metadata.json"), "{}\n");
        }
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisSlackDesktopSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      keepLease: false,
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-created-fail",
      repoRoot,
    });

    expect(result.status).toBe("fail");
    expect(
      commands.some(
        (entry) =>
          entry.command === "/tmp/crabbox" &&
          JSON.stringify(entry.args) ===
            JSON.stringify(["stop", "--provider", "hetzner", "cbx_fade123"]),
      ),
    ).toBe(true);
  });

  it("passes gateway setup when Crabbox returns non-zero after remote metadata proves success", async () => {
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "/tmp/crabbox" && args[0] === "warmup") {
        return { stdout: "ready lease cbx_cafe123\n", stderr: "" };
      }
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        return {
          stdout: `${JSON.stringify({
            host: "203.0.113.10",
            id: "cbx_cafe123",
            provider: "hetzner",
            sshKey: "/tmp/key",
            sshPort: "2222",
            sshUser: "crabbox",
            state: "active",
          })}\n`,
          stderr: "",
        };
      }
      if (command === "/tmp/crabbox" && args[0] === "run") {
        throw new Error("remote command exited 1");
      }
      if (command === "rsync") {
        const outputDir = args.at(-1);
        await fs.mkdir(outputDir as string, { recursive: true });
        if (!String(outputDir).endsWith("slack-qa/")) {
          await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.png"), "png");
          await fs.writeFile(
            path.join(outputDir as string, "remote-metadata.json"),
            `${JSON.stringify({
              gatewayAlive: true,
              gatewayPid: "4321",
              openedUrl: "https://app.slack.com/client/TOK/COK",
              qaExitCode: 0,
            })}\n`,
          );
        }
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisSlackDesktopSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      env: {
        OPENAI_API_KEY: "openai-runtime-key",
        OPENCLAW_MANTIS_SLACK_APP_TOKEN: "xapp-direct",
        OPENCLAW_MANTIS_SLACK_BOT_TOKEN: "xoxb-direct",
        PATH: process.env.PATH,
      },
      gatewaySetup: true,
      now: () => new Date("2026-05-04T14:30:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-gateway-metadata",
      repoRoot,
    });

    expect(result.status).toBe("pass");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      status: string;
      timings: { phases: { name: string; status: string }[] };
      warning?: string;
    };
    expect(summary.status).toBe("pass");
    expect(summary.warning).toBeUndefined();
    expect(phaseStatus(summary.timings.phases, "crabbox.remote_run")).toBe("accepted");
  });

  it("passes Slack QA when Crabbox returns non-zero after remote metadata proves QA success", async () => {
    const expectedScenarios = ["slack-approval-exec-native", "slack-approval-plugin-native"];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === "/tmp/crabbox" && args[0] === "warmup") {
        return { stdout: "ready lease cbx_ba5eba11\n", stderr: "" };
      }
      if (command === "/tmp/crabbox" && args[0] === "inspect") {
        return {
          stdout: `${JSON.stringify({
            host: "203.0.113.10",
            id: "cbx_ba5eba11",
            provider: "hetzner",
            sshKey: "/tmp/key",
            sshPort: "2222",
            sshUser: "crabbox",
            state: "active",
          })}\n`,
          stderr: "",
        };
      }
      if (command === "/tmp/crabbox" && args[0] === "run") {
        throw new Error("remote command exited 1");
      }
      if (command === "rsync") {
        const outputDir = args.at(-1);
        await fs.mkdir(outputDir as string, { recursive: true });
        if (String(outputDir).endsWith("slack-qa/")) {
          await fs.writeFile(path.join(outputDir as string, "qa-suite-report.md"), "# Slack\n");
        } else {
          await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.png"), "png");
          await fs.writeFile(
            path.join(outputDir as string, "remote-metadata.json"),
            `${JSON.stringify({ qaExitCode: 0 })}\n`,
          );
          await fs.writeFile(path.join(outputDir as string, "slack-desktop-command.log"), "qa\n");
          await writeApprovalCheckpointArtifacts(outputDir as string, expectedScenarios);
        }
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisSlackDesktopSmoke({
      approvalCheckpoints: true,
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      now: () => new Date("2026-05-04T14:45:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-qa-metadata",
      repoRoot,
    });

    expect(result.status).toBe("pass");
    expect(result.approvalCheckpointScreenshotPaths).toHaveLength(4);
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      status: string;
      timings: { phases: { name: string; status: string }[] };
    };
    expect(summary.status).toBe("pass");
    expect(phaseStatus(summary.timings.phases, "crabbox.remote_run")).toBe("accepted");
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
        await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.mp4"), "mp4");
        await fs.writeFile(path.join(outputDir as string, "remote-metadata.json"), "{}\n");
        await fs.writeFile(path.join(outputDir as string, "chrome.log"), "chrome\n");
        await fs.writeFile(path.join(outputDir as string, "ffmpeg.log"), "ffmpeg\n");
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
    expect(result.videoPath).toBe(path.join(result.outputDir, "slack-desktop-smoke.mp4"));
    await expect(
      fs.readFile(path.join(result.outputDir, "slack-desktop-smoke.png"), "utf8"),
    ).resolves.toBe("png");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      artifacts: { screenshotPath?: string; videoPath?: string };
      error?: string;
      hydrateMode: string;
      status: string;
      timings: { phases: { name: string; status: string }[]; totalMs: number };
    };
    expect(summary.status).toBe("fail");
    expect(summary.hydrateMode).toBe("source");
    expect(summary.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(phaseStatus(summary.timings.phases, "crabbox.remote_run")).toBe("fail");
    expect(summary.error).toContain("remote Slack QA failed");
    expect(summary.artifacts.screenshotPath).toContain("slack-desktop-smoke.png");
    expect(summary.artifacts.videoPath).toContain("slack-desktop-smoke.mp4");
  });

  it("reports Slack QA failure from copied remote metadata when Crabbox run exits zero", async () => {
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
      if (command === "rsync") {
        const outputDir = args.at(-1);
        await fs.mkdir(outputDir as string, { recursive: true });
        if (String(outputDir).endsWith("slack-qa/")) {
          return { stdout: "", stderr: "" };
        }
        await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.png"), "png");
        await fs.writeFile(
          path.join(outputDir as string, "remote-metadata.json"),
          `${JSON.stringify({ qaExitCode: 7 })}\n`,
        );
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisSlackDesktopSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      leaseId: "cbx_existing",
      outputDir: ".artifacts/qa-e2e/mantis/slack-desktop-metadata-fail",
      repoRoot,
    });

    expect(result.status).toBe("fail");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      error?: string;
      status: string;
      timings: { phases: { name: string; status: string }[] };
    };
    expect(summary.status).toBe("fail");
    expect(summary.error).toContain("Slack QA exited with code 7");
    expect(phaseStatus(summary.timings.phases, "crabbox.remote_run")).toBe("pass");
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
          await fs.writeFile(path.join(outputDir as string, "qa-suite-report.md"), "# Slack\n");
        } else {
          await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.png"), "png");
          await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.mp4"), "mp4");
          await fs.writeFile(
            path.join(outputDir as string, "remote-metadata.json"),
            `${JSON.stringify({ qaExitCode: 0 })}\n`,
          );
          await fs.writeFile(path.join(outputDir as string, "chrome.log"), "chrome\n");
          await fs.writeFile(path.join(outputDir as string, "ffmpeg.log"), "ffmpeg\n");
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
    expect(
      commands.some(
        (entry) =>
          entry.command === "/tmp/crabbox" &&
          entry.args.includes("--id") &&
          entry.args.includes("tbx_abc-123_more"),
      ),
    ).toBe(true);
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      crabbox: { id: string; provider: string };
    };
    expect(summary.crabbox.id).toBe("tbx_abc-123_more");
    expect(summary.crabbox.provider).toBe("blacksmith-testbox");
  });

  it("routes the approval checkpoints CLI flag into the Slack desktop runtime", async () => {
    vi.resetModules();
    const runMantisSlackDesktopSmokeCommand = mockMantisCliRuntime(vi.fn(async () => undefined));
    const { registerMantisCli } = await import("./cli.js");
    const qa = new Command("qa");
    registerMantisCli(qa);

    await qa.parseAsync([
      "node",
      "openclaw",
      "mantis",
      "slack-desktop-smoke",
      "--approval-checkpoints",
      "--market",
      "on-demand",
      "--scenario",
      "slack-approval-plugin-native",
    ]);

    expect(runMantisSlackDesktopSmokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalCheckpoints: true,
        gatewaySetup: undefined,
        market: "on-demand",
        scenarioIds: ["slack-approval-plugin-native"],
      }),
    );
    vi.doUnmock("./cli.runtime.js");
  });

  it("rejects mutually exclusive approval checkpoint and gateway setup CLI flags", async () => {
    vi.resetModules();
    const runMantisSlackDesktopSmokeCommand = mockMantisCliRuntime(vi.fn(async () => undefined));
    const { registerMantisCli } = await import("./cli.js");
    const qa = new Command("qa");
    registerMantisCli(qa);

    await expect(
      qa.parseAsync([
        "node",
        "openclaw",
        "mantis",
        "slack-desktop-smoke",
        "--approval-checkpoints",
        "--gateway-setup",
      ]),
    ).rejects.toThrow("--approval-checkpoints cannot be used with --gateway-setup");

    expect(runMantisSlackDesktopSmokeCommand).not.toHaveBeenCalled();
    vi.doUnmock("./cli.runtime.js");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
