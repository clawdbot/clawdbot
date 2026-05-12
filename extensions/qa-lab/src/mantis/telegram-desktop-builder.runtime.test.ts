import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMantisTelegramDesktopBuilder } from "./telegram-desktop-builder.runtime.js";

function describeFetchInput(input: RequestInfo | URL) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

describe("mantis Telegram desktop builder runtime", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-telegram-desktop-builder-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it("leases a desktop box, installs Telegram Desktop, configures OpenClaw, and keeps the gateway lease", async () => {
    const commands: { args: readonly string[]; command: string; env?: NodeJS.ProcessEnv }[] = [];
    const runner = vi.fn(
      async (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        commands.push({ command, args, env: options.env });
        if (command === "/tmp/crabbox" && args[0] === "warmup") {
          return { stdout: "ready lease cbx_a123\n", stderr: "" };
        }
        if (command === "/tmp/crabbox" && args[0] === "inspect") {
          return {
            stdout: `${JSON.stringify({
              host: "203.0.113.20",
              id: "cbx_a123",
              provider: "hetzner",
              slug: "telegram-builder",
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
          await fs.writeFile(path.join(outputDir as string, "telegram-desktop-builder.png"), "png");
          await fs.writeFile(path.join(outputDir as string, "telegram-desktop-builder.mp4"), "mp4");
          await fs.writeFile(
            path.join(outputDir as string, "remote-metadata.json"),
            `${JSON.stringify({ gatewayAlive: true, hydrateMode: "source", qaExitCode: 0 })}\n`,
          );
          await fs.writeFile(
            path.join(outputDir as string, "telegram-desktop-builder-command.log"),
            "qa\n",
          );
          await fs.writeFile(path.join(outputDir as string, "telegram-desktop.log"), "tdesktop\n");
          await fs.writeFile(path.join(outputDir as string, "ffmpeg.log"), "ffmpeg\n");
        }
        return { stdout: "", stderr: "" };
      },
    );

    const result = await runMantisTelegramDesktopBuilder({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      credentialSource: "env",
      env: {
        OPENAI_API_KEY: "openai-runtime-key",
        OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver-token",
        OPENCLAW_QA_TELEGRAM_GROUP_ID: "-1001234567890",
        OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "sut-token",
        PATH: process.env.PATH,
        TELEGRAM_PROFILE_TGZ_B64: "profile-archive",
      },
      now: () => new Date("2026-05-05T12:00:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/telegram-desktop-test",
      repoRoot,
      telegramProfileArchiveEnv: "TELEGRAM_PROFILE_TGZ_B64",
      telegramProfileDir: "/home/crabbox/.local/share/TelegramDesktop",
    });

    expect(result.status).toBe("pass");
    expect(commands.map((entry) => [entry.command, entry.args[0]])).toEqual([
      ["/tmp/crabbox", "warmup"],
      ["/tmp/crabbox", "inspect"],
      ["/tmp/crabbox", "run"],
      ["rsync", "-az"],
    ]);
    const runCommand = commands.find(
      (entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "run",
    );
    expect(runCommand?.env?.OPENCLAW_LIVE_OPENAI_KEY).toBe("openai-runtime-key");
    expect(runCommand?.env?.OPENCLAW_MANTIS_TELEGRAM_DESKTOP_PROFILE_TGZ_B64).toBe(
      "profile-archive",
    );
    expect(runCommand?.env?.OPENCLAW_MANTIS_TELEGRAM_DRIVER_BOT_TOKEN).toBe("driver-token");
    expect(runCommand?.env?.OPENCLAW_MANTIS_TELEGRAM_GROUP_ID).toBe("-1001234567890");
    expect(runCommand?.env?.OPENCLAW_MANTIS_TELEGRAM_SUT_BOT_TOKEN).toBe("sut-token");
    const remoteScript = runCommand?.args.at(-1);
    expect(remoteScript).toContain("https://telegram.org/dl/desktop/linux");
    expect(remoteScript).toContain('-workdir "$telegram_profile_dir"');
    expect(remoteScript).toContain("OPENCLAW_MANTIS_TELEGRAM_DESKTOP_PROFILE_TGZ_B64");
    expect(remoteScript).toContain(
      'botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" }',
    );
    expect(remoteScript).not.toContain("groupAllowFrom");
    expect(remoteScript).not.toContain("allowFrom:");
    expect(remoteScript).toContain("openclaw gateway run");
    expect(remoteScript).toContain("telegram-ready-message.json");
    expect(remoteScript).toContain("telegram-desktop-builder.mp4");
    expect(
      commands.some((entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "stop"),
    ).toBe(false);
    await expect(fs.readFile(result.screenshotPath ?? "", "utf8")).resolves.toBe("png");
    await expect(fs.readFile(result.videoPath ?? "", "utf8")).resolves.toBe("mp4");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      crabbox: { id: string; vncCommand: string };
      gatewaySetup: boolean;
      hydrateMode: string;
      status: string;
      telegramDesktop: { profileArchiveEnv?: string; profileDir: string };
    };
    expect(summary.crabbox.id).toBe("cbx_a123");
    expect(summary.crabbox.vncCommand).toBe(
      "/tmp/crabbox vnc --provider hetzner --id cbx_a123 --open",
    );
    expect(summary.gatewaySetup).toBe(true);
    expect(summary.hydrateMode).toBe("source");
    expect(summary.status).toBe("pass");
    expect(summary.telegramDesktop.profileArchiveEnv).toBe("TELEGRAM_PROFILE_TGZ_B64");
    expect(summary.telegramDesktop.profileDir).toBe("/home/crabbox/.local/share/TelegramDesktop");
  });

  it("leases Convex Telegram credentials and maps them into the VM env", async () => {
    const commands: { args: readonly string[]; command: string; env?: NodeJS.ProcessEnv }[] = [];
    const events: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = describeFetchInput(input);
      if (url.endsWith("/acquire")) {
        events.push("acquire");
        return new Response(
          JSON.stringify({
            credentialId: "cred-telegram",
            heartbeatIntervalMs: 600_000,
            leaseToken: "lease-telegram",
            leaseTtlMs: 900_000,
            payload: {
              driverToken: "driver-leased",
              groupId: "-100222333444",
              sutToken: "sut-leased",
            },
            status: "ok",
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/release")) {
        events.push("release");
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      if (url.endsWith("/heartbeat")) {
        events.push("heartbeat");
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runner = vi.fn(
      async (command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        commands.push({ command, args, env: options.env });
        if (command === "/tmp/crabbox" && args[0] === "warmup") {
          return { stdout: "ready lease cbx_c0ffee\n", stderr: "" };
        }
        if (command === "/tmp/crabbox" && args[0] === "inspect") {
          return {
            stdout: `${JSON.stringify({
              host: "203.0.113.20",
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
          await fs.writeFile(path.join(outputDir as string, "telegram-desktop-builder.png"), "png");
          await fs.writeFile(
            path.join(outputDir as string, "remote-metadata.json"),
            `${JSON.stringify({ gatewayAlive: true, qaExitCode: 0 })}\n`,
          );
        }
        return { stdout: "", stderr: "" };
      },
    );

    const result = await runMantisTelegramDesktopBuilder({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      credentialRole: "ci",
      credentialSource: "convex",
      env: {
        CI: "1",
        OPENCLAW_QA_CONVEX_SECRET_CI: "convex-secret",
        OPENCLAW_QA_CONVEX_SITE_URL: "https://example.convex.site",
        PATH: process.env.PATH,
      },
      keepLease: false,
      now: () => new Date("2026-05-05T12:30:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/telegram-desktop-convex",
      repoRoot,
    });

    expect(result.status).toBe("pass");
    expect(events).toEqual(["acquire", "release"]);
    const runCommand = commands.find(
      (entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "run",
    );
    expect(runCommand?.env?.OPENCLAW_MANTIS_TELEGRAM_DRIVER_BOT_TOKEN).toBe("driver-leased");
    expect(runCommand?.env?.OPENCLAW_MANTIS_TELEGRAM_GROUP_ID).toBe("-100222333444");
    expect(runCommand?.env?.OPENCLAW_MANTIS_TELEGRAM_SUT_BOT_TOKEN).toBe("sut-leased");
    expect(runCommand?.env?.OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN).toBe("driver-leased");
    expect(runCommand?.env?.OPENCLAW_QA_TELEGRAM_GROUP_ID).toBe("-100222333444");
    expect(runCommand?.env?.OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN).toBe("sut-leased");
    expect(
      commands.some((entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "stop"),
    ).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => describeFetchInput(url))).toEqual([
      "https://example.convex.site/qa-credentials/v1/acquire",
      "https://example.convex.site/qa-credentials/v1/release",
    ]);
  });
});
