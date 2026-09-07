import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveStableNodePath } from "./stable-node-path.js";
import { buildUpdateCommandRunner } from "./update-runner-command.js";
import { updateGitCheckout } from "./update-runner-git.js";
import type { CommandRunner, UpdateRunnerOptions } from "./update-runner-types.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

function fixture(relativeRemote = false) {
  const root = temporary.make("openclaw-git-admission-test-");
  const source = path.join(root, "remote with spaces");
  const install = path.join(root, "installed");
  const globalConfig = path.join(root, "empty-config");
  fs.writeFileSync(globalConfig, "");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_SSH: undefined,
    GIT_SSH_COMMAND: undefined,
    GIT_SSH_VARIANT: undefined,
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  fs.mkdirSync(source);
  git(source, "init", "-b", "main");
  git(source, "config", "user.name", "Update fixture");
  git(source, "config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(source, ".gitignore"), "node_modules/\ndist/\n.artifacts/\n");
  fs.writeFileSync(path.join(source, "openclaw.mjs"), "export {};\n");
  const commit = (version: string, agentSchema: number) => {
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version,
        packageManager: "pnpm@12.1.0",
        openclaw: { schemaVersions: { state: 5, agent: agentSchema } },
      }),
    );
    git(source, "add", ".");
    git(source, "commit", "-m", "isolated fixture");
    git(source, "tag", `v${version}`);
    return git(source, "rev-parse", "HEAD");
  };
  commit("2026.7.1", 13);
  git(root, "clone", source, install);
  git(install, "remote", "rename", "origin", "upstream.with.dots");
  if (relativeRemote) {
    git(install, "remote", "set-url", "upstream.with.dots", path.relative(install, source));
  }
  const target = commit("2026.7.2", 14);
  const calls: string[][] = [];
  const runCommand: CommandRunner = async (argv, options) => {
    if (argv.includes("doctor") && argv[0] === (await resolveStableNodePath(process.execPath))) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (argv[0] === "pnpm") {
      if (argv.includes("build")) {
        const dist = path.join(options.cwd!, "dist");
        fs.mkdirSync(path.join(dist, "control-ui"), { recursive: true });
        fs.writeFileSync(path.join(dist, "entry.js"), "export {};\n");
        fs.writeFileSync(path.join(dist, "control-ui", "index.html"), "ready\n");
      }
      return { code: 0, stdout: argv.includes("--version") ? "12.1.0\n" : "", stderr: "" };
    }
    expect(argv[0]).toBe("git");
    calls.push(argv);
    const result = spawnSync("git", argv.slice(1), {
      cwd: options.cwd,
      env: { ...env, ...options.env },
      encoding: "utf8",
      timeout: 15_000,
    });
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const run = (options: UpdateRunnerOptions, command: CommandRunner = runCommand) =>
    updateGitCheckout({
      gitRoot: install,
      runCommand: command,
      defaultCommandEnv: env,
      timeoutMs: 15_000,
      startedAt: Date.now(),
      opts: { channel: "stable", inspectGitTarget: async () => undefined, ...options },
    });
  return { root, source, install, globalConfig, git, commit, target, calls, runCommand, run };
}

function snapshotTree(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .toSorted()
    .flatMap((name) => {
      const fullPath = path.join(root, name);
      const stat = fs.lstatSync(fullPath);
      return stat.isFile()
        ? [
            `${name} ${stat.size} ${stat.mtimeMs} ${createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex")}`,
          ]
        : stat.isSymbolicLink()
          ? [`${name} -> ${fs.readlinkSync(fullPath)}`]
          : [];
    });
}

describe("Git database admission", () => {
  it("preserves dev upstream setup from a cold tracking inventory", async () => {
    const state = fixture();
    state.git(state.install, "checkout", "-b", "maintenance");
    state.git(state.install, "branch", "-D", "main");
    state.git(state.install, "update-ref", "-d", "refs/remotes/upstream.with.dots/main");
    let restoredUpstream = false;
    const command: CommandRunner = async (argv, options) => {
      const result = await state.runCommand(argv, options);
      if (argv[2] === state.install && argv[3] === "branch" && argv[4] === "--set-upstream-to") {
        expect(result.code, result.stderr).toBe(0);
        expect(state.git(state.install, "rev-parse", "HEAD")).toBe(state.target);
        expect(state.git(state.install, "rev-parse", "main@{upstream}")).toBe(state.target);
        restoredUpstream = true;
      }
      return result;
    };
    const result = await state.run(
      { channel: "dev", beforeGitMutation: async () => undefined },
      command,
    );
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(restoredUpstream).toBe(true);
  });

  it.each(
    (["stable", "dev"] as const).flatMap((channel) =>
      [false, true].map((admitted) => ({ channel, admitted })),
    ),
  )(
    "rechecks admission after transport ($channel, admitted=$admitted)",
    async ({ channel, admitted }) => {
      const state = fixture();
      let checkoutObserved = false;
      let admissionFinished = false;
      let admissionFresh = false;
      const remoteFetches: boolean[] = [];
      const command: CommandRunner = async (argv, options) => {
        if (argv[2] === state.install && argv[3] === "fetch") {
          remoteFetches.push(admissionFinished);
          admissionFresh = false;
        }
        if (argv[2] === state.install && (argv[3] === "checkout" || argv[3] === "rebase")) {
          expect(remoteFetches).toEqual([admitted]);
          if (admitted) {
            expect(admissionFresh).toBe(true);
          }
          expect(state.git(state.install, "show", `${state.target}:package.json`)).toContain(
            '"agent":14',
          );
          checkoutObserved = true;
        }
        return state.runCommand(argv, options);
      };
      const result = await state.run(
        {
          channel,
          ...(admitted
            ? {
                beforeGitMutation: async () => {
                  admissionFinished = true;
                  admissionFresh = true;
                },
                inspectGitTarget: async () => {
                  if (admissionFinished) {
                    admissionFresh = true;
                  }
                },
              }
            : {}),
        },
        command,
      );
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(checkoutObserved).toBe(true);
    },
  );

  it.each(
    (["global", "command"] as const).flatMap((configuration) =>
      [false, true].map((configured) => ({ configuration, configured })),
    ),
  )(
    "uses captured transport configuration ($configuration, configured=$configured)",
    async ({ configuration, configured }) => {
      const state = fixture();
      const unresolved = pathToFileURL(path.join(state.root, "absent-remote")).href;
      const key = `url.${pathToFileURL(state.source).href}.insteadOf`;
      state.git(state.install, "remote", "set-url", "upstream.with.dots", unresolved);
      if (configuration === "global" && configured) {
        state.git(state.install, "config", "--file", state.globalConfig, key, unresolved);
      }
      const captured = await withEnvAsync(
        {
          GIT_CONFIG_GLOBAL: state.globalConfig,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_PARAMETERS: undefined,
          GIT_CONFIG_COUNT: configuration === "command" && configured ? "1" : "0",
          GIT_CONFIG_KEY_0: configuration === "command" && configured ? key : undefined,
          GIT_CONFIG_VALUE_0: configuration === "command" && configured ? unresolved : undefined,
        },
        () => buildUpdateCommandRunner(),
      );
      const before = snapshotTree(state.install);
      const refused = new Error("refuse after effective-environment transport");
      const admission = vi.fn(async (target) => {
        expect(target).toEqual({ schemaVersions: { state: 5, agent: 14 } });
        throw refused;
      });
      const result = updateGitCheckout({
        gitRoot: state.install,
        ...captured,
        timeoutMs: 15_000,
        startedAt: Date.now(),
        opts: { channel: "stable", inspectGitTarget: admission },
      });
      if (configured) {
        await expect(result).rejects.toBe(refused);
        expect(admission).toHaveBeenCalledOnce();
      } else {
        await expect(result).resolves.toMatchObject({ status: "error", reason: "fetch-failed" });
        expect(admission).not.toHaveBeenCalled();
      }
      expect(snapshotTree(state.install)).toEqual(before);
    },
  );

  it.each([false, true])(
    "checks development admission before target scripts, refuseFirst=%s",
    async (refuseFirst) => {
      const state = fixture();
      state.commit("2026.7.3", 15);
      const before = snapshotTree(state.install);
      const refused = new Error("fallback database refusal");
      const builds: string[] = [];
      const inspected: number[] = [];
      const runCommand: CommandRunner = async (argv, options) => {
        if (argv[0] === "git") {
          return state.runCommand(argv, options);
        }
        if (argv.includes("build")) {
          const manifest = JSON.parse(
            fs.readFileSync(path.join(options.cwd!, "package.json"), "utf8"),
          );
          builds.push(manifest.version);
          if (!refuseFirst && manifest.version === "2026.7.3") {
            return { code: 1, stdout: "", stderr: "synthetic candidate build failure" };
          }
        }
        return state.runCommand(argv, options);
      };
      await expect(
        state.run(
          {
            channel: "dev",
            inspectGitTarget: async (target) => {
              inspected.push(target.schemaVersions!.agent);
              if (refuseFirst) {
                expect(target).toEqual({ schemaVersions: { state: 5, agent: 15 } });
                throw refused;
              }
            },
            beforeGitMutation: async (target) => {
              expect(target).toEqual({
                schemaVersions: { state: 5, agent: 14 },
              });
              throw refused;
            },
          },
          runCommand,
        ),
      ).rejects.toBe(refused);
      expect(builds).toEqual(refuseFirst ? [] : ["2026.7.3", "2026.7.2"]);
      expect([...new Set(inspected)]).toEqual(refuseFirst ? [15] : [15, 14]);
      expect(snapshotTree(state.install)).toEqual(before);
    },
  );

  it("fetches through a repository-local SSH command with an explicit dialect", async () => {
    const state = fixture();
    const wrapper = path.join(state.root, "ssh-wrapper.mjs");
    const transportLog = path.join(state.root, "ssh-calls.jsonl");
    fs.writeFileSync(
      wrapper,
      `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(transportLog)}, JSON.stringify(args) + "\\n");
if (args[0] !== "-P" || args[1] !== "22445" || args[2] !== "fixture.invalid") process.exit(91);
if (!args[3]?.startsWith("git-upload-pack ")) process.exit(92);
const result = spawnSync("git", ["upload-pack", ${JSON.stringify(state.source)}], { stdio: "inherit" });
process.exit(result.status ?? 93);
`,
    );
    const quote = (value: string) => `"${value.replaceAll("\\", "/")}"`;
    state.git(
      state.install,
      "config",
      "core.sshCommand",
      `${quote(process.execPath)} ${quote(wrapper)}`,
    );
    state.git(state.install, "config", "ssh.variant", "plink");
    const remote = new URL("ssh://fixture.invalid:22445");
    remote.pathname = state.source;
    state.git(state.install, "remote", "set-url", "upstream.with.dots", remote.href);
    // The installed repository can reach the fixture with this command/dialect pair.
    expect(
      state.git(state.install, "ls-remote", "upstream.with.dots", "refs/heads/main"),
    ).toContain(state.target);
    const before = snapshotTree(state.install);
    const refused = new Error("stop after real SSH transport and target admission");
    await expect(
      state.run({
        inspectGitTarget: async () => {
          throw refused;
        },
      }),
    ).rejects.toBe(refused);
    const calls = fs
      .readFileSync(transportLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((args) => args[0] === "-P" && args[1] === "22445")).toBe(true);
    expect(snapshotTree(state.install)).toEqual(before);
  });

  it("keeps the admitted target pinned when its remote advances", async () => {
    const state = fixture();
    let checkoutObserved = false;
    const admission = vi.fn(async (target) => {
      expect(target).toEqual({ schemaVersions: { state: 5, agent: 14 } });
      state.commit("2026.7.3", 15);
    });
    const command: CommandRunner = async (argv, options) => {
      if (argv[0] === "git" && argv[2] === state.install && argv[3] === "checkout") {
        expect(argv.at(-1)).toBe(state.target);
        expect(state.git(state.install, "show", `${state.target}:package.json`)).toContain(
          '"agent":14',
        );
        checkoutObserved = true;
      }
      return state.runCommand(argv, options);
    };
    const result = await state.run({ beforeGitMutation: admission }, command);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(checkoutObserved).toBe(true);
    expect(state.git(state.install, "rev-parse", "HEAD")).toBe(state.target);
    expect(admission).toHaveBeenCalledOnce();
  });

  it.each([false, true])("publishes only an admitted checkout (refuse=%s)", async (refuse) => {
    const state = fixture();
    const published = path.join(state.root, "published");
    const complete = new Error("refuse publication");
    const publish = vi.fn(async () => {
      expect(state.git(state.install, "show", `${state.target}:package.json`)).toContain(
        '"agent":14',
      );
      fs.renameSync(state.install, published);
      return published;
    });
    const result = state.run({
      beforeGitMutation: async (target) => {
        expect(fs.existsSync(published)).toBe(false);
        expect(target).toEqual({ schemaVersions: { state: 5, agent: 14 } });
        if (refuse) {
          throw complete;
        }
      },
      publishGitCheckout: publish,
    });
    if (refuse) {
      await expect(result).rejects.toBe(complete);
    } else {
      await expect(result).resolves.toMatchObject({
        status: "ok",
        root: published,
        after: { sha: state.target },
      });
    }
    expect(publish).toHaveBeenCalledTimes(refuse ? 0 : 1);
    expect(fs.existsSync(published)).toBe(!refuse);
  });
  it.each([false, true])(
    "refuses before installed Git writes (relative remote=%s)",
    async (relative) => {
      const state = fixture(relative);
      // Unchanged content with a stale index stat cache must remain read-only too.
      fs.utimesSync(path.join(state.install, "package.json"), new Date(1000), new Date(1000));
      const before = snapshotTree(state.install);
      const refusal = new Error("incompatible database");
      const inspect = vi.fn(async (target) => {
        expect(target).toEqual({ schemaVersions: { state: 5, agent: 14 } });
        throw refusal;
      });
      await expect(state.run({ inspectGitTarget: inspect })).rejects.toBe(refusal);
      expect(inspect).toHaveBeenCalledOnce();
      expect(snapshotTree(state.install)).toEqual(before);
      const mirror = state.calls.find((argv) => argv.includes("clone"))?.at(-1);
      expect(mirror).toBeDefined();
      expect(fs.existsSync(mirror!)).toBe(false);
    },
  );
});
