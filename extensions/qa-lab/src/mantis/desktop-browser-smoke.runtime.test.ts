// Qa Lab tests cover desktop browser smoke plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runMantisDesktopBrowserSmoke,
  type MantisDesktopBrowserSmokeOptions,
} from "./desktop-browser-smoke.runtime.js";

describe("mantis desktop browser smoke runtime", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-desktop-browser-smoke-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
    expect(commands.map((entry) => entry.env)).toEqual(commands.map(() => runtimeEnv));
    const rsyncArgs = commands.find((entry) => entry.command === "rsync")?.args ?? [];
    expect(rsyncArgs).not.toContain("--delete");
    const excludeIndex = rsyncArgs.indexOf("--exclude");
    expect(excludeIndex).toBeGreaterThanOrEqual(0);
    expect(rsyncArgs[excludeIndex + 1]).toBe("chrome-profile/**");
    expect(rsyncArgs).toContain(
      "crabbox@203.0.113.10:/tmp/openclaw-mantis-desktop-2026-05-04T12-00-00-000Z/",
    );
    const remoteScript = commands
      .find((entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "run")
      ?.args.at(-1);
    expect(remoteScript).toContain("${BROWSER:-}");
    expect(remoteScript).toContain("${CHROME_BIN:-}");
    expect(remoteScript).toContain("chromium-browser");
    expect(remoteScript).toContain("${OPENCLAW_MANTIS_BROWSER_PROFILE_TGZ_B64:-}");
    expect(remoteScript).toContain('"browserProfileRestored": $profile_restored');
    expect(remoteScript).toContain('"temporaryBrowserProfile": $temporary_profile');
    expect(remoteScript).toContain("-t 10");
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
    expect(summary.htmlFile).toBe(path.join(repoRoot, "qa-artifacts", "timeline.html"));
    expect(summary.status).toBe("pass");
    expect(summary.crabbox.id).toBe("cbx_abc123");
    expect(summary.crabbox.vncCommand).toBe(
      "/tmp/crabbox vnc --provider hetzner --id cbx_abc123 --open",
    );
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

  it("restores a named browser profile archive env and honors the video duration", async () => {
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
            sshUser: "crabbox",
          })}\n`,
          stderr: "",
        };
      }
      if (command === "rsync") {
        const outputDir = args.at(-1);
        await fs.mkdir(outputDir as string, { recursive: true });
        await fs.writeFile(path.join(outputDir as string, "desktop-browser-smoke.png"), "png");
        await fs.writeFile(path.join(outputDir as string, "desktop-browser-smoke.mp4"), "mp4");
      }
      return { stdout: "", stderr: "" };
    });

    const result = await runMantisDesktopBrowserSmoke({
      browserProfileArchiveEnv: "MANTIS_DISCORD_VIEWER_CHROME_PROFILE_TGZ_B64",
      browserProfileDir: "$HOME/.config/openclaw-mantis/discord-viewer-chrome-profile",
      commandRunner: runner,
      crabboxBin: "/tmp/crabbox",
      leaseId: "cbx_existing",
      outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-profile",
      repoRoot,
      videoDurationSeconds: 24,
    });

    expect(result.status).toBe("pass");

    const remoteScript = commands
      .find((entry) => entry.command === "/tmp/crabbox" && entry.args[0] === "run")
      ?.args.at(-1);
    expect(remoteScript).toContain("${MANTIS_DISCORD_VIEWER_CHROME_PROFILE_TGZ_B64:-}");
    expect(remoteScript).toContain(
      "profile='$HOME/.config/openclaw-mantis/discord-viewer-chrome-profile'",
    );
    expect(remoteScript).toContain("temporary_profile=false");
    expect(remoteScript).toContain('tar -xzf "$profile_archive" -C "$profile"');
    expect(remoteScript).toContain("-t 24");
  });

  it("rejects unsafe browser profile archive env names", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      runMantisDesktopBrowserSmoke({
        browserProfileArchiveEnv: "BAD-NAME",
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-profile",
        repoRoot,
      }),
    ).rejects.toThrow("Mantis browser profile archive env must be an environment variable name");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects relative browser profile dirs", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(
      runMantisDesktopBrowserSmoke({
        browserProfileDir: "relative-profile",
        commandRunner: runner,
        crabboxBin: "/tmp/crabbox",
        outputDir: ".artifacts/qa-e2e/mantis/desktop-browser-profile",
        repoRoot,
      }),
    ).rejects.toThrow("Mantis browser profile dir must be an absolute path");
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
    const commandWithLeaseId = commands.find(
      (entry) => entry.command === "/tmp/crabbox" && entry.args.includes("tbx_abc-123_more"),
    );
    expect(commandWithLeaseId?.args).toContain("--id");
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as {
      crabbox: { id: string; provider: string };
    };
    expect(summary.crabbox.id).toBe("tbx_abc-123_more");
    expect(summary.crabbox.provider).toBe("blacksmith-testbox");
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

  describe("capture artifact ownership", () => {
    const names = ["desktop-browser-smoke.png", "desktop-browser-smoke.mp4"] as const;
    const metadataNames = [
      "mantis-desktop-browser-smoke-summary.json",
      "mantis-desktop-browser-smoke-report.md",
      "error.txt",
    ] as const;
    let outputDir: string;
    let target: string;

    beforeEach(async () => {
      outputDir = path.join(repoRoot, "captures");
      target = path.join(repoRoot, "unrelated-target");
      await fs.mkdir(outputDir);
      await fs.writeFile(target, "preserve target");
      await fs.writeFile(path.join(outputDir, "unrelated.txt"), "preserve evidence");
    });

    async function capture(
      copy: () => Promise<void> = async () => {},
      options: Partial<MantisDesktopBrowserSmokeOptions> = {},
    ) {
      return runMantisDesktopBrowserSmoke({
        crabboxBin: "/controlled-crabbox",
        env: {},
        leaseId: "cbx_existing",
        outputDir: "captures",
        repoRoot,
        commandRunner: async (command, args) => {
          if (command === "rsync") {
            await copy();
          }
          return {
            stdout:
              args[0] === "inspect"
                ? JSON.stringify({ host: "127.0.0.1", sshKey: "unused", sshUser: "fixture" })
                : "",
            stderr: "",
          };
        },
        ...options,
      });
    }

    async function writeCaptures(png = "current png", mp4?: string) {
      await fs.writeFile(path.join(outputDir, names[0]), png);
      if (mp4 !== undefined) {
        await fs.writeFile(path.join(outputDir, names[1]), mp4);
      }
    }

    async function expectMissing(name: string) {
      await expect(fs.lstat(path.join(outputDir, name))).rejects.toMatchObject({ code: "ENOENT" });
    }

    it("reuses an output directory without attributing previous captures to the next run", async () => {
      expect((await capture(() => writeCaptures("first png", "first video"))).status).toBe("pass");
      const second = await capture(() => writeCaptures("second png"));
      expect(second.status).toBe("pass");
      expect(second.videoPath).toBeUndefined();
      await expectMissing(names[1]);
      await expect(fs.readFile(second.screenshotPath!, "utf8")).resolves.toBe("second png");
      const third = await capture();
      expect(third.status).toBe("fail");
      expect(third.screenshotPath).toBeUndefined();
      await expectMissing(names[0]);
      await expect(fs.readFile(third.reportPath, "utf8")).resolves.toContain("Screenshot: missing");
      await expect(fs.readFile(path.join(outputDir, "unrelated.txt"), "utf8")).resolves.toBe(
        "preserve evidence",
      );
    });

    it.each([
      { screenshot: "empty", video: "empty", expected: "fail" },
      { screenshot: "symlink", video: "symlink", expected: "fail" },
      { screenshot: "valid", video: "empty", expected: "pass" },
      { screenshot: "valid", video: "symlink", expected: "pass" },
      { screenshot: "empty", video: "valid", expected: "fail" },
      { screenshot: "symlink", video: "valid", expected: "fail" },
    ])(
      "handles $screenshot screenshot and $video video without leaking invalid artifacts",
      async ({ screenshot, video, expected }) => {
        const kinds = [screenshot, video];
        const result = await capture(async () => {
          for (const [index, name] of names.entries()) {
            const file = path.join(outputDir, name);
            if (kinds[index] === "symlink") {
              await fs.symlink(target, file);
            } else {
              await fs.writeFile(file, kinds[index] === "valid" ? `valid ${name}` : "");
            }
          }
        });
        expect(result.status).toBe(expected);
        for (const [index, name] of names.entries()) {
          if (kinds[index] === "valid") {
            await expect(fs.readFile(path.join(outputDir, name), "utf8")).resolves.toBe(
              `valid ${name}`,
            );
          } else {
            await expectMissing(name);
          }
        }
        expect(result.videoPath).toBeUndefined();
        await expect(fs.readFile(target, "utf8")).resolves.toBe("preserve target");
      },
    );

    it.each(names)(
      "preserves a directory occupying %s while cleaning the other stale capture",
      async (directoryName) => {
        await writeCaptures("stale png", "stale video");
        await fs.unlink(path.join(outputDir, directoryName));
        await fs.mkdir(path.join(outputDir, directoryName));
        await fs.writeFile(path.join(outputDir, directoryName, "keep"), "directory contents");
        const commandRunner = vi.fn(async () => ({ stdout: "", stderr: "" }));
        const result = await capture(undefined, { commandRunner });
        expect(result.status).toBe("fail");
        expect(commandRunner).not.toHaveBeenCalled();
        await expectMissing(names.find((name) => name !== directoryName)!);
        await expect(
          fs.readFile(path.join(outputDir, directoryName, "keep"), "utf8"),
        ).resolves.toBe("directory contents");
        await expect(fs.readFile(result.summaryPath, "utf8")).resolves.toContain(directoryName);
      },
    );

    it.each([
      { htmlFile: "missing.html" },
      { browserProfileArchiveEnv: "BAD-NAME" },
      { browserProfileDir: "relative-profile" },
    ])("invalidates stale artifacts before rejecting preflight options %j", async (options) => {
      expect((await capture(() => writeCaptures("stale png", "stale video"))).status).toBe("pass");
      await expect(capture(undefined, options)).rejects.toThrow();
      for (const name of [...names, ...metadataNames]) await expectMissing(name);
      await expect(fs.readFile(path.join(outputDir, "unrelated.txt"), "utf8")).resolves.toBe(
        "preserve evidence",
      );
    });

    it("retires a previous error when a later capture succeeds", async () => {
      expect((await capture()).status).toBe("fail");
      await expect(fs.readFile(path.join(outputDir, "error.txt"), "utf8")).resolves.toContain(
        "screenshot",
      );
      expect((await capture(() => writeCaptures())).status).toBe("pass");
      await expectMissing("error.txt");
    });

    it.each(metadataNames)("preserves a directory occupying metadata %s", async (name) => {
      await writeCaptures("stale png", "stale video");
      await fs.mkdir(path.join(outputDir, name));
      await fs.writeFile(path.join(outputDir, name, "keep"), "directory contents");
      const commandRunner = vi.fn(async () => ({ stdout: "", stderr: "" }));
      await expect(capture(undefined, { commandRunner })).rejects.toThrow();
      expect(commandRunner).not.toHaveBeenCalled();
      for (const visual of names) await expectMissing(visual);
      await expect(fs.readFile(path.join(outputDir, name, "keep"), "utf8")).resolves.toBe(
        "directory contents",
      );
    });

    it("retires metadata symlinks without following their targets", async () => {
      for (const name of metadataNames) await fs.symlink(target, path.join(outputDir, name));
      expect((await capture(() => writeCaptures())).status).toBe("pass");
      await expectMissing("error.txt");
      await expect(fs.readFile(target, "utf8")).resolves.toBe("preserve target");
      for (const name of metadataNames.slice(0, 2)) {
        expect((await fs.lstat(path.join(outputDir, name))).isSymbolicLink()).toBe(false);
      }
    });

    it("removes partially copied captures and records the original transfer failure", async () => {
      const result = await capture(async () => {
        await writeCaptures("partial png", "partial video");
        throw new Error("transfer interrupted");
      });
      expect(result.status).toBe("fail");
      for (const name of names) await expectMissing(name);
      await expect(fs.readFile(result.summaryPath, "utf8")).resolves.toContain(
        "transfer interrupted",
      );
    });

    it("reports cleanup failure alongside the transfer failure and still cleans the other capture", async () => {
      const remove = fs.rm.bind(fs);
      const result = await capture(async () => {
        await writeCaptures("partial png", "partial video");
        vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
          if (file === path.join(outputDir, names[0])) {
            throw Object.assign(new Error("capture removal denied"), { code: "EACCES" });
          }
          return remove(file, options);
        });
        throw new Error("transfer interrupted");
      });
      expect(result.status).toBe("fail");
      await expectMissing(names[1]);
      const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8"));
      expect(summary.error).toContain("transfer interrupted");
      expect(summary.error).toContain("capture removal denied");
    });

    it.each([false, true])(
      "preserves inspection errors when removal fails: %s",
      async (removalFails) => {
        const inspect = fs.lstat.bind(fs);
        const remove = fs.rm.bind(fs);
        const result = await capture(async () => {
          await writeCaptures("unreadable png", "");
          if (removalFails) {
            vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
              if (file === path.join(outputDir, names[0])) {
                throw Object.assign(new Error("capture removal denied"), { code: "EACCES" });
              }
              return remove(file, options);
            });
          }
          vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
            if (args[0] === path.join(outputDir, names[0])) {
              throw Object.assign(new Error("capture inspection failed"), { code: "EIO" });
            }
            return inspect(...args);
          });
        });
        vi.restoreAllMocks();
        expect(result.status).toBe("fail");
        await expectMissing(names[1]);
        const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8"));
        expect(summary.error).toContain("capture inspection failed");
        if (removalFails) {
          expect(summary.error).toContain("capture removal denied");
          await expect(fs.readFile(path.join(outputDir, names[0]), "utf8")).resolves.toBe(
            "unreadable png",
          );
        } else {
          await expectMissing(names[0]);
        }
      },
    );
  });
});
