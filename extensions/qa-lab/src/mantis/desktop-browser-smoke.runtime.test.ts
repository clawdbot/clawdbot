import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMantisDesktopBrowserSmoke } from "./desktop-browser-smoke.runtime.js";

describe("mantis desktop browser smoke runtime", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-desktop-browser-smoke-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it("leases a desktop box, runs a visible browser, copies artifacts, and stops on pass", async () => {
    await fs.mkdir(path.join(repoRoot, "qa-artifacts"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, "qa-artifacts", "timeline.html"), "<h1>Mantis</h1>");
    const commands: { args: readonly string[]; command: string; env?: NodeJS.ProcessEnv }[] = [];
    const runtimeEnv = {
      PATH: process.env.PATH,
      CRABBOX_COORDINATOR_TOKEN: "runtime-token",
      OPENCLAW_MANTIS_CRABBOX_PROVIDER: "hetzner",
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
              slug: "brisk-mantis",
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
          await fs.writeFile(path.join(outputDir as string, "desktop-browser-smoke.png"), "png");
          await fs.writeFile(path.join(outputDir as string, "desktop-browser-smoke.mp4"), "mp4");
          await fs.writeFile(path.join(outputDir as string, "remote-metadata.json"), "{}\n");
          await fs.writeFile(path.join(outputDir as string, "chrome.log"), "chrome\n");
          await fs.writeFile(path.join(outputDir as string, "ffmpeg.log"), "ffmpeg\n");
          return { stdout: "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    );

    const result = await runMantisDesktopBrowserSmoke({
      browserUrl: "https://openclaw.ai/docs",
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      env: runtimeEnv,
      htmlFile: "qa-artifacts/timeline.html",
      now: () => new Date("2026-05-04T12:00:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-test",
      repoRoot,
    });

    expect(result.status).toBe("pass");
    expect(commands.map((entry) => [entry.command, entry.args[0]])).toEqual([
      ["/tmp/crabbox", "warmup"],
      ["/tmp/crabbox", "inspect"],
      ["/tmp/crabbox", "run"],
      ["rsync", "-az"],
      ["/tmp/crabbox", "stop"],
    ]);
    expect(commands.every((entry) => entry.env === runtimeEnv)).toBe(true);
    const rsyncArgs = commands.find((entry) => entry.command === "rsync")?.args ?? [];
    expect(rsyncArgs).not.toContain("--delete");
    expect(rsyncArgs).toEqual(expect.arrayContaining(["--exclude", "chrome-profile/**"]));
    expect(rsyncArgs).toEqual(
      expect.arrayContaining([
        "crabbox@203.0.113.10:/tmp/openclaw-mantis-desktop-2026-05-04T12-00-00-000Z/",
      ]),
    );
    const remoteScript = commands
      .find((entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "run")
      ?.args.at(-1);
    expect(remoteScript).toContain("${BROWSER:-}");
    expect(remoteScript).toContain("${CHROME_BIN:-}");
    expect(remoteScript).toContain("chromium-browser");
    expect(remoteScript).toContain("base64 -d");
    expect(remoteScript).toContain("ffmpeg");
    expect(remoteScript).toContain('sudo apt-get update -y >>"$out/apt.log" 2>&1 || true');
    expect(remoteScript).toContain("desktop-browser-smoke.mp4");
    expect(remoteScript).not.toContain("-video_size");
    expect(remoteScript).toContain('url="file://$out/input.html"');
    expect(remoteScript).toContain('"browserBinary": "$browser_bin"');
    await expect(fs.readFile(result.screenshotPath ?? "", "utf8")).resolves.toBe("png");
    await expect(fs.readFile(result.videoPath ?? "", "utf8")).resolves.toBe("mp4");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      browserUrl: string;
      crabbox: { id: string; vncCommand: string };
      htmlFile?: string;
      status: string;
    };
    expect(summary.browserUrl).toMatch(/^file:\/\//u);
    expect(summary).toMatchObject({
      htmlFile: path.join(repoRoot, "qa-artifacts", "timeline.html"),
      crabbox: {
        id: "cbx_abc123",
        vncCommand: "/tmp/crabbox vnc --provider hetzner --id cbx_abc123 --open",
      },
      status: "pass",
    });
  });

  it("rejects html files outside the repository", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      runMantisDesktopBrowserSmoke({
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        htmlFile: "../outside.html",
        outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-outside",
        repoRoot,
      }),
    ).rejects.toThrow("Mantis desktop HTML file must be inside the repository");
    expect(runner).not.toHaveBeenCalled();
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
        await fs.writeFile(path.join(outputDir as string, "desktop-browser-smoke.png"), "png");
        await fs.writeFile(path.join(outputDir as string, "remote-metadata.json"), "{}\n");
        await fs.writeFile(path.join(outputDir as string, "chrome.log"), "chrome\n");
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisDesktopBrowserSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      now: () => new Date("2026-05-04T12:30:00.000Z"),
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-testbox",
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

  it("keeps an existing lease and writes failure reports when the remote run fails", async () => {
    const commands: { args: readonly string[]; command: string }[] = [];
    const runner = vi.fn(async (command: string, args: readonly string[]) => {
      commands.push({ command, args });
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
        throw new Error("remote chrome failed");
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisDesktopBrowserSmoke({
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      leaseId: "cbx_existing",
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-fail",
      repoRoot,
    });

    expect(result.status).toBe("fail");
    expect(commands.map((entry) => [entry.command, entry.args[0]])).toEqual([
      ["/tmp/crabbox", "inspect"],
      ["/tmp/crabbox", "run"],
    ]);
    await expect(fs.readFile(path.join(result.outputDir, "error.txt"), "utf8")).resolves.toContain(
      "remote chrome failed",
    );
  });
});
