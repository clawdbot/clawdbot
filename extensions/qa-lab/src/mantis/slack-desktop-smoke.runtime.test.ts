import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
            await fs.writeFile(path.join(outputDir as string, "slack-qa-report.md"), "# Slack\n");
          } else {
            await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.png"), "png");
            await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.mp4"), "mp4");
            await fs.writeFile(path.join(outputDir as string, "remote-metadata.json"), "{}\n");
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
    expect(remoteScript).toContain("hydrate_mode='source'");
    expect(remoteScript).toContain("${BROWSER:-}");
    expect(remoteScript).toContain("${CHROME_BIN:-}");
    expect(remoteScript).toContain("PNPM_STORE_DIR");
    expect(remoteScript).toContain("build-essential python3");
    expect(remoteScript).toContain("pnpm install --frozen-lockfile --prefer-offline");
    expect(remoteScript).toContain("pnpm build");
    expect(remoteScript).toContain("ffmpeg");
    expect(remoteScript).toContain('sudo apt-get update -y >>"$out/apt.log" 2>&1 || true');
    expect(remoteScript).toContain("slack-desktop-smoke.mp4");
    expect(remoteScript).not.toContain("-video_size");
    expect(remoteScript).toContain("openclaw qa slack");
    expect(remoteScript).toContain("--scenario 'slack-canary'");
    expect(remoteScript).toContain("OPENCLAW_MANTIS_SLACK_BROWSER_PROFILE_DIR");
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
          await fs.writeFile(path.join(outputDir as string, "slack-desktop-smoke.mp4"), "mp4");
          await fs.writeFile(path.join(outputDir as string, "remote-metadata.json"), "{}\n");
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
});
