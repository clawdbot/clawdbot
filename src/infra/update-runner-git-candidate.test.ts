import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { runCommandWithTimeout } from "../process/exec.js";
import { hasErrnoCode } from "./errno.js";
import { prepareGitRuntimePromotion } from "./update-runner-git-runtime.js";
import { updateGitCheckout } from "./update-runner-git.js";
import type { CommandRunner, UpdateRunnerOptions } from "./update-runner-types.js";

async function git(root: string, ...args: string[]) {
  const result = await runCommandWithTimeout(["git", "-C", root, ...args], { timeoutMs: 5000 });
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

const runtimeImports = [
  "../node_modules/identity.cjs",
  "workspace-runtime",
  "relative-workspace-runtime",
  "external-runtime",
  "absolute-external-runtime",
  "../packages/runtime/node_modules/external-runtime",
  "virtual-runtime",
];

type VirtualStoreLayout =
  | "node_modules/.pnpm"
  | ".pnpm"
  | "cache/deps"
  | "../store"
  | "external"
  | "symlink";

async function writeRuntime(directory: string, sha: string, store: string, layout: string) {
  const root = await fs.realpath(directory);
  const dist = path.join(root, "dist");
  const external = path.join(store, sha);
  await fs.mkdir(external, { recursive: true });
  await fs.writeFile(path.join(external, "index.js"), `module.exports = ${JSON.stringify(sha)};`);
  await fs.mkdir(path.join(dist, "control-ui"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "runtime", "node_modules"), { recursive: true });
  const virtualStore =
    layout === "external"
      ? path.join(store, "virtual-store")
      : path.resolve(root, layout === "symlink" ? ".pnpm" : layout);
  if (layout === "symlink") {
    const linkedStore = path.join(store, "linked-store", sha);
    await fs.mkdir(linkedStore, { recursive: true });
    await fs.rm(virtualStore, { force: true });
    await fs.symlink(linkedStore, virtualStore, "junction");
  }
  const virtualPackage = path.join(virtualStore, sha, "node_modules", "virtual-runtime");
  await fs.mkdir(virtualPackage, { recursive: true });
  await fs.writeFile(
    path.join(virtualPackage, "index.js"),
    `module.exports = ${JSON.stringify(sha)};`,
  );
  await fs.rm(path.join(root, "node_modules", "workspace-runtime"), { force: true });
  await fs.symlink(
    path.join(root, "packages", "runtime"),
    path.join(root, "node_modules", "workspace-runtime"),
    "junction",
  );
  for (const [relative, target, absolute] of [
    ["node_modules/relative-workspace-runtime", path.join(root, "packages", "runtime"), false],
    ["node_modules/external-runtime", external, false],
    ["node_modules/absolute-external-runtime", external, true],
    ["packages/runtime/node_modules/external-runtime", external, false],
    ["node_modules/virtual-runtime", virtualPackage, false],
  ] as const) {
    const file = path.join(root, relative);
    await fs.rm(file, { force: true });
    await fs.symlink(
      absolute || process.platform === "win32" ? target : path.relative(path.dirname(file), target),
      file,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  await Promise.all([
    fs.writeFile(
      path.join(root, "node_modules", ".modules.yaml"),
      JSON.stringify({
        virtualStoreDir:
          process.platform === "win32"
            ? virtualStore
            : path.relative(path.join(root, "node_modules"), virtualStore),
      }),
    ),
    fs.writeFile(
      path.join(root, "packages", "runtime", "node_modules", "nested.cjs"),
      `module.exports = ${JSON.stringify(sha)};`,
    ),
    fs.writeFile(
      path.join(root, "node_modules", "identity.cjs"),
      `module.exports = ${JSON.stringify(sha)};`,
    ),
    fs.writeFile(
      path.join(dist, "entry.js"),
      runtimeImports
        .map((specifier) => `console.log(require(${JSON.stringify(specifier)}));`)
        .join("\n"),
    ),
    fs.writeFile(path.join(dist, "build-info.json"), JSON.stringify({ commit: sha, buildId: sha })),
    fs.writeFile(path.join(dist, ".buildstamp"), JSON.stringify({ head: sha })),
    fs.writeFile(path.join(dist, ".runtime-postbuildstamp"), JSON.stringify({ head: sha })),
    fs.writeFile(path.join(dist, "control-ui", "index.html"), "ready"),
  ]);
}

async function expectRuntime(root: string, sha: string) {
  const child = await runCommandWithTimeout(
    [process.execPath, path.join(root, "dist", "entry.js")],
    {
      timeoutMs: 5000,
    },
  );
  expect(child.code, child.stderr).toBe(0);
  expect(child.stdout.trim().split("\n")).toEqual(runtimeImports.map(() => sha));
}

describe("Git candidate activation", () => {
  let directory: string;
  let root: string;
  let remote: string;
  let beforeSha: string;
  let events: string[];
  let stopped: boolean;
  let runCommand: CommandRunner;
  let virtualStoreLayout: VirtualStoreLayout;

  beforeEach(async () => {
    directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-candidate-")),
    );
    root = path.join(directory, "checkout");
    remote = path.join(directory, "remote");
    await fs.mkdir(remote);
    await git(remote, "init", "--initial-branch=main");
    await git(remote, "config", "user.name", "OpenClaw Test");
    await git(remote, "config", "user.email", "openclaw@example.com");
    await fs.writeFile(
      path.join(remote, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.1", packageManager: "pnpm@12.0.0" }),
    );
    await fs.writeFile(path.join(remote, "openclaw.mjs"), "export {};\n");
    await fs.mkdir(path.join(remote, "packages", "runtime"), { recursive: true });
    await fs.writeFile(
      path.join(remote, "packages", "runtime", "index.js"),
      "module.exports = require('./node_modules/nested.cjs');",
    );
    await fs.writeFile(
      path.join(remote, ".gitignore"),
      "node_modules/\ndist/\n.artifacts\n.pnpm\ncache/\n*.tmp\n",
    );
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "base");
    beforeSha = await git(remote, "rev-parse", "HEAD");
    await git(directory, "clone", "--quiet", remote, root);
    await git(root, "config", "user.name", "OpenClaw Test");
    await git(root, "config", "user.email", "openclaw@example.com");
    virtualStoreLayout = "node_modules/.pnpm";
    await writeRuntime(root, beforeSha, path.join(directory, "shared-store"), virtualStoreLayout);
    events = [];
    stopped = false;
    runCommand = async (argv, options) => {
      if (argv[0] === "git") {
        return runCommandWithTimeout(argv, options);
      }
      if (argv[0] === "pnpm") {
        if (argv[1] === "build") {
          expect(stopped).toBe(false);
          expect(options.cwd).not.toBe(root);
          await writeRuntime(
            options.cwd!,
            await git(options.cwd!, "rev-parse", "HEAD"),
            path.join(directory, "shared-store"),
            virtualStoreLayout,
          );
          events.push("build");
        }
        return { code: 0, stdout: argv[1] === "--version" ? "12.0.0" : "", stderr: "" };
      }
      if (argv.includes("doctor")) {
        expect(stopped).toBe(true);
        events.push("migrate");
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${argv.join(" ")}`);
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function advanceRemote() {
    await fs.writeFile(path.join(remote, "candidate.txt"), "candidate\n");
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "candidate");
    return git(remote, "rev-parse", "HEAD");
  }

  function update(opts: UpdateRunnerOptions = {}) {
    return updateGitCheckout({
      gitRoot: root,
      runCommand,
      defaultCommandEnv: undefined,
      timeoutMs: 5000,
      startedAt: Date.now(),
      opts: {
        channel: "dev",
        validateCandidate: async (candidateRoot) => {
          expect(stopped).toBe(false);
          expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
          expect(candidateRoot).not.toBe(root);
          const candidateSha = await git(candidateRoot, "rev-parse", "HEAD");
          await expectRuntime(candidateRoot, candidateSha);
          events.push("validate");
        },
        beforeGitMutation: async () => {
          stopped = true;
          events.push("stop");
        },
        ...opts,
      },
    });
  }

  it.each(["dev", "stable", "beta"] as const)(
    "does not stop or build an already-current %s checkout",
    async (channel) => {
      await git(remote, "tag", "v2026.9.1");
      const result = await update({ channel });
      expect(result).toMatchObject({ status: "skipped", reason: "already-current" });
      expect(stopped).toBe(false);
      expect(events).toEqual([]);
      expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
    },
  );

  it("stages an already-current checkout when converting a package install to Git", async () => {
    const result = await update({
      prepareGitExposure: async (candidateRoot, sha) => {
        expect(stopped).toBe(false);
        expect(await git(candidateRoot, "rev-parse", "HEAD")).toBe(sha);
        events.push("prepare exposure");
      },
    });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(events).toEqual(["build", "prepare exposure", "validate", "stop"]);
  });

  it.each([false, true])(
    "preserves source changes made during validation without stopping the service (database inspection: %s)",
    async (inspection) => {
      await advanceRemote();
      const result = await update({
        ...(inspection ? { inspectGitTarget: async () => undefined } : {}),
        validateCandidate: async () => {
          await fs.writeFile(path.join(root, "operator-change.txt"), "keep this change");
        },
      });
      expect(result).toMatchObject({ status: "skipped", reason: "dirty" });
      expect(stopped).toBe(false);
      expect(await fs.readFile(path.join(root, "operator-change.txt"), "utf8")).toBe(
        "keep this change",
      );
      expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
    },
  );

  it.each([
    { source: "workspace", version: "10.23.0", dirtyWorkspace: false },
    { source: "workspace symlink", version: "10.23.0", dirtyWorkspace: false },
    { source: "ambient", version: "11.24.0", dirtyWorkspace: false },
    { source: "workspace", version: "10.23.0", dirtyWorkspace: true },
  ])(
    "isolates candidate installs from the $source virtual store (build changes workspace: $dirtyWorkspace)",
    async ({ source, version, dirtyWorkspace }) => {
      const operatorStore = path.join(root, "node_modules", "operator-store");
      const workspace = `# preserve operator formatting\npackages:\n  - packages/*\n${
        source !== "ambient" ? `virtualStoreDir: ${JSON.stringify(operatorStore)}\n` : ""
      }`;
      const workspaceFile = path.join(remote, "pnpm-workspace.yaml");
      const workspaceTarget =
        source === "workspace symlink"
          ? path.join(directory, "operator-workspace.yaml")
          : workspaceFile;
      await fs.writeFile(workspaceTarget, workspace);
      if (workspaceTarget !== workspaceFile) {
        await fs.symlink(workspaceTarget, workspaceFile);
      }
      await fs.writeFile(
        path.join(remote, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: "2026.9.1",
          packageManager: `pnpm@${version}`,
        }),
      );
      await git(remote, "add", ".");
      await git(remote, "commit", "-m", "operator store");
      await git(root, "fetch", "origin");
      await git(root, "merge", "--ff-only", "origin/main");
      beforeSha = await git(root, "rev-parse", "HEAD");
      await writeRuntime(root, beforeSha, path.join(directory, "shared-store"), operatorStore);
      const target = await advanceRemote();
      for (const key of [
        "npm_config_virtual_store_dir",
        "NPM_CONFIG_VIRTUAL_STORE_DIR",
        "PNPM_CONFIG_VIRTUAL_STORE_DIR",
        "pnpm_config_virtual_store_dir",
      ]) {
        vi.stubEnv(key, operatorStore);
      }
      vi.stubEnv("OPENCLAW_UPDATE_PREFLIGHT_LINT", "1");
      const candidateCommands = ["install", "build", "ui:build", "openclaw", "lint"];
      const command = runCommand;
      runCommand = async (argv, options) => {
        if (argv[0] !== "pnpm") {
          return command(argv, options);
        }
        if (argv[1] === "--version") {
          return { code: 0, stdout: version, stderr: "" };
        }
        if (!candidateCommands.includes(argv[1]!)) {
          return command(argv, options);
        }
        const cwd = options.cwd!;
        expect(await fs.readFile(workspaceTarget, "utf8")).toBe(workspace);
        const config = YAML.parse(await fs.readFile(path.join(cwd, "pnpm-workspace.yaml"), "utf8"));
        const env = { ...process.env, ...options.env };
        // pnpm10 gives workspace YAML priority; pnpm11 normalizes environment keys
        // in insertion order. A nested install never inherits the outer CLI flags.
        const ambient =
          Object.entries(env).findLast(
            ([key]) => key.toLowerCase() === "pnpm_config_virtual_store_dir",
          )?.[1] ??
          env.npm_config_virtual_store_dir ??
          env.NPM_CONFIG_VIRTUAL_STORE_DIR;
        const selected =
          source !== "ambient"
            ? (config.virtualStoreDir ?? ambient)
            : (ambient ?? config.virtualStoreDir);
        const store = path.resolve(cwd, selected ?? "node_modules/.pnpm");
        // Model pruning the previous package generation, as the real pnpm proof does.
        await fs.rm(path.join(store, beforeSha), { recursive: true, force: true });
        await writeRuntime(
          cwd,
          await git(cwd, "rev-parse", "HEAD"),
          path.join(directory, "shared-store"),
          store,
        );
        if (argv[1] === "build") {
          await fs.rm(path.join(cwd, "dist", "control-ui", "index.html"));
          if (dirtyWorkspace) {
            await fs.appendFile(
              path.join(cwd, "pnpm-workspace.yaml"),
              "# build changed this file\n",
            );
          }
        }
        expect(stopped).toBe(false);
        await expectRuntime(root, beforeSha);
        events.push(argv[1]!);
        return { code: 0, stdout: "", stderr: "" };
      };
      const result = await update({
        devTarget: { mode: "detached", ref: target },
        validateCandidate: undefined,
        prepareGitExposure: async (cwd, sha, env) => {
          expect(sha).toBe(target);
          expect(env).toBeDefined();
          await runCommand(["pnpm", "install"], { cwd, env });
          events.push("exposure");
        },
        beforeGitMutation: async () => {
          await expectRuntime(root, beforeSha);
          expect(await fs.readFile(path.join(root, "pnpm-workspace.yaml"), "utf8")).toBe(workspace);
          stopped = true;
          events.push("stop");
        },
      });
      expect(await fs.readFile(path.join(root, "pnpm-workspace.yaml"), "utf8")).toBe(workspace);
      expect(await fs.readFile(workspaceTarget, "utf8")).toBe(workspace);
      if (source === "workspace symlink") {
        expect(await fs.readlink(path.join(root, "pnpm-workspace.yaml"))).toBe(workspaceTarget);
      }
      const candidateEvents = [...candidateCommands, "install", "exposure"];
      if (dirtyWorkspace) {
        expect(result).toMatchObject({ status: "error", reason: "preflight-no-good-commit" });
        expect(result.steps).toContainEqual(
          expect.objectContaining({
            name: expect.stringContaining("clean check"),
            exitCode: 1,
            stdoutTail: expect.stringContaining("pnpm-workspace.yaml"),
          }),
        );
        expect(events).toEqual(candidateEvents);
        expect(stopped).toBe(false);
        expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
        await expectRuntime(root, beforeSha);
        return;
      }
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(events).toEqual([...candidateEvents, "stop"]);
      expect(await git(root, "rev-parse", "HEAD")).toBe(target);
      await expectRuntime(root, target);
      const manifest = YAML.parse(
        await fs.readFile(path.join(root, "node_modules", ".modules.yaml"), "utf8"),
      );
      expect(path.resolve(root, "node_modules", manifest.virtualStoreDir)).toBe(
        path.join(root, "node_modules", ".pnpm"),
      );
    },
  );

  it.each([
    { layout: "node_modules/.pnpm", localCommit: false, inspection: false },
    { layout: "node_modules/.pnpm", localCommit: true, inspection: false },
    { layout: ".pnpm", localCommit: false, inspection: false },
    { layout: "cache/deps", localCommit: false, inspection: false },
    { layout: "../store", localCommit: false, inspection: false },
    { layout: "external", localCommit: false, inspection: false },
    { layout: "symlink", localCommit: false, inspection: false },
    { layout: "node_modules/.pnpm", localCommit: false, inspection: true },
    { layout: "node_modules/.pnpm", localCommit: true, inspection: true },
  ] as const)(
    "activates the validated $layout runtime (preserving local commits: $localCommit, database inspection: $inspection)",
    async ({ layout, localCommit, inspection }) => {
      virtualStoreLayout = layout;
      await writeRuntime(root, beforeSha, path.join(directory, "shared-store"), layout);
      const target = await advanceRemote();
      if (localCommit) {
        const artifacts = path.join(directory, "external-artifacts");
        await fs.mkdir(artifacts);
        await fs.symlink(artifacts, path.join(root, ".artifacts"), "junction");
        await fs.writeFile(path.join(root, "local.txt"), "operator change\n");
        await git(root, "add", "local.txt");
        await git(root, "commit", "-m", "local change");
        beforeSha = await git(root, "rev-parse", "HEAD");
        await writeRuntime(root, beforeSha, path.join(directory, "shared-store"), layout);
      }
      const unrelated = path.join(root, "operator-project", "node_modules", "keep.cjs");
      await fs.mkdir(path.dirname(unrelated), { recursive: true });
      await fs.writeFile(unrelated, "operator-owned");
      const result = await update(inspection ? { inspectGitTarget: async () => undefined } : {});
      expect(await fs.readFile(unrelated, "utf8")).toBe("operator-owned");
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(events).toEqual(["build", "validate", "stop", "migrate"]);
      const current = await git(root, "rev-parse", "HEAD");
      expect(result.before?.buildId).toBe(beforeSha);
      expect(result.after).toMatchObject({ sha: current, buildId: current });
      expect(await git(root, "merge-base", current, target)).toBe(target);
      expect.soft(await git(root, "rev-parse", "@{upstream}")).toBe(target);
      if (localCommit) {
        expect(await fs.readFile(path.join(root, "local.txt"), "utf8")).toBe("operator change\n");
        const committer = await git(root, "log", "-1", "--format=%cn <%ce>");
        expect.soft(committer === "OpenClaw Test <openclaw@example.com>").toBe(true);
      }
      await expectRuntime(root, current);
      const manifest: { virtualStoreDir: string } = JSON.parse(
        await fs.readFile(path.join(root, "node_modules", ".modules.yaml"), "utf8"),
      );
      const expectedStore =
        layout === "external"
          ? path.join(directory, "shared-store", "virtual-store")
          : layout === "symlink"
            ? path.join(directory, "shared-store", "linked-store", current)
            : path.resolve(root, layout);
      expect(await fs.realpath(path.resolve(root, "node_modules", manifest.virtualStoreDir))).toBe(
        expectedStore,
      );
      expect(await fs.realpath(path.join(root, "node_modules", "virtual-runtime"))).toBe(
        path.join(expectedStore, current, "node_modules", "virtual-runtime"),
      );
      const retainedArtifacts = await fs
        .readdir(path.join(root, ".artifacts"))
        .catch((error: unknown) => {
          if (!hasErrnoCode(error, "ENOENT")) {
            throw error;
          }
          return [];
        });
      expect(retainedArtifacts).toEqual([]);
    },
  );

  it.each([false, true])(
    "preserves a local upstream without inventing a remote ref (database inspection: %s)",
    async (inspection) => {
      const target = await advanceRemote();
      await git(root, "fetch", "origin");
      await git(root, "branch", "operator-target", target);
      await git(root, "config", "branch.main.remote", ".");
      await git(root, "config", "branch.main.merge", "refs/heads/operator-target");
      const result = await update(inspection ? { inspectGitTarget: async () => undefined } : {});
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(await git(root, "rev-parse", "HEAD")).toBe(target);
      expect(await git(root, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe(
        "refs/heads/operator-target",
      );
      await expectRuntime(root, target);
    },
  );

  it.each([false, true])(
    "preserves required signatures when a candidate rebase fails (database inspection: %s)",
    async (inspection) => {
      await advanceRemote();
      await fs.writeFile(path.join(root, "local.txt"), "operator change\n");
      await git(root, "add", "local.txt");
      await git(root, "commit", "-m", "local change");
      beforeSha = await git(root, "rev-parse", "HEAD");
      await writeRuntime(root, beforeSha, path.join(directory, "shared-store"), virtualStoreLayout);
      // A deliberately non-signing executable rejects Git's signing request without a key.
      await git(root, "config", "gpg.program", process.execPath);
      await git(root, "config", "commit.gpgSign", "true");
      const result = await update(inspection ? { inspectGitTarget: async () => undefined } : {});
      // The existing fallback can retain the old candidate without creating a commit.
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(
        result.steps.some((step) => /preflight rebase \(/u.test(step.name) && step.exitCode !== 0),
      ).toBe(true);
      expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
      await expectRuntime(root, beforeSha);
    },
  );

  it.each([
    ".",
    "..",
    "../checkout",
    ".artifacts/checkout",
    "live:node_modules",
    "live:dist",
    "live:packages/runtime/node_modules",
    "link:node_modules",
  ])("refuses virtual store %s before promotion can replace a checkout", async (store) => {
    const cleanupRoot = path.join(directory, "candidate-scope");
    const candidateRoot = path.join(cleanupRoot, "worktree");
    const modules = path.join(candidateRoot, "node_modules");
    await fs.mkdir(modules, { recursive: true });
    const replacedRoot = /^(?:live|link):(.+)$/u.exec(store)?.[1];
    const payload = replacedRoot
      ? path.join(root, replacedRoot, "operator-store")
      : path.resolve(candidateRoot, store);
    const storePath = store.startsWith("link:") ? path.join(directory, "external-store") : payload;
    await fs.mkdir(payload, { recursive: true });
    if (storePath !== payload) {
      await fs.symlink(payload, storePath, "junction");
    }
    if (replacedRoot) {
      const candidateRuntime = path.join(candidateRoot, replacedRoot);
      await fs.mkdir(candidateRuntime, { recursive: true });
      await fs.writeFile(path.join(candidateRuntime, "candidate.cjs"), "module.exports = 1;\n");
    }
    if (store === ".artifacts/checkout") {
      await fs.symlink(directory, path.join(root, ".artifacts"), "junction");
    }
    await git(candidateRoot, "init", "--initial-branch=main");
    await fs.writeFile(path.join(candidateRoot, ".gitignore"), "node_modules/\ndist/\n");
    await fs.writeFile(
      path.join(modules, ".modules.yaml"),
      JSON.stringify({
        virtualStoreDir: path.relative(modules, storePath),
      }),
    );
    await expect(
      prepareGitRuntimePromotion(root, candidateRoot, runCommand, 5000, cleanupRoot),
    ).rejects.toThrow(/virtual store/i);
    expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
    await expectRuntime(root, beforeSha);
  });

  it("leaves the old runtime serving when candidate validation fails", async () => {
    await advanceRemote();
    const failure = new Error("candidate canary failed");
    await expect(
      update({
        validateCandidate: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(stopped).toBe(false);
    expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
    expect(await fs.readFile(path.join(root, "node_modules", "identity.cjs"), "utf8")).toContain(
      beforeSha,
    );
    expect(await fs.readdir(path.join(root, ".artifacts"))).toEqual([]);
  });

  it.each(["working", "staged", "committed"] as const)(
    "refuses activation when validation repairs %s source outside the selected commit",
    async (repairState) => {
      await fs.writeFile(
        path.join(remote, "openclaw.mjs"),
        "throw new Error('broken launcher');\n",
      );
      const target = await advanceRemote();
      let validated = false;
      const result = await update({
        devTarget: { mode: "detached", ref: target },
        validateCandidate: async (candidateRoot) => {
          const launcher = path.join(candidateRoot, "openclaw.mjs");
          await fs.writeFile(launcher, "export {};\n");
          if (repairState !== "working") {
            await git(candidateRoot, "add", "openclaw.mjs");
          }
          if (repairState === "committed") {
            await git(candidateRoot, "commit", "-m", "repair launcher");
          }
          const probe = await runCommandWithTimeout([process.execPath, launcher], {
            timeoutMs: 5000,
          });
          expect(probe.code).toBe(0);
          validated = true;
        },
      });
      expect(validated).toBe(true);
      expect(result).toMatchObject({ status: "error", reason: "preflight-no-good-commit" });
      expect(stopped).toBe(false);
      expect(await git(root, "rev-parse", "HEAD")).toBe(beforeSha);
      expect(await fs.readFile(path.join(root, "openclaw.mjs"), "utf8")).toBe("export {};\n");
      expect(await fs.readdir(path.join(root, ".artifacts"))).toEqual([]);
    },
  );

  it.each([
    { layout: "node_modules/.pnpm", restoreSource: true, restoreRuntime: true },
    { layout: "node_modules/.pnpm", restoreSource: false, restoreRuntime: true },
    { layout: "../store", restoreSource: true, restoreRuntime: true },
    { layout: "node_modules/.pnpm", restoreSource: true, restoreRuntime: false },
  ] as const)(
    "verifies $layout runtime recovery after activation failure (source restored: $restoreSource, runtime restored: $restoreRuntime)",
    async ({ layout, restoreSource, restoreRuntime }) => {
      virtualStoreLayout = layout;
      await writeRuntime(root, beforeSha, path.join(directory, "shared-store"), layout);
      const candidateSha = await advanceRemote();
      const command = runCommand;
      let resetFaultInjected = false;
      runCommand = async (argv, options) => {
        if (
          !restoreSource &&
          argv[0] === "git" &&
          argv[2] === root &&
          argv[3] === "reset" &&
          argv[4] === "--hard" &&
          argv[5] === beforeSha
        ) {
          resetFaultInjected = true;
          return { code: 1, stdout: "", stderr: "source restoration failed" };
        }
        return command(argv, options);
      };
      const rename = fs.rename.bind(fs);
      const injected = new Error("activation blocked");
      let faultInjected = false;
      let distBackup: string | undefined;
      let restoreFaultInjected = false;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (source === path.join(root, "dist")) {
          distBackup = String(destination);
        }
        if (!restoreRuntime && source === distBackup && destination === path.join(root, "dist")) {
          restoreFaultInjected = true;
          await fs.mkdir(destination, { recursive: true });
          await fs.writeFile(path.join(destination, "restore-race"), "occupied");
        }
        if (
          String(source).endsWith(`${path.sep}candidate`) &&
          destination === path.join(root, "node_modules")
        ) {
          faultInjected = true;
          throw injected;
        }
        return rename(source, destination);
      });
      const result = await update();
      expect(faultInjected).toBe(true);
      expect(resetFaultInjected).toBe(!restoreSource);
      expect(restoreFaultInjected).toBe(!restoreRuntime);
      expect(result).toMatchObject({
        status: "error",
        recovery: !restoreSource
          ? { serviceRestartSafe: false, reason: "source-rollback-failed" }
          : restoreRuntime
            ? { serviceRestartSafe: true, buildId: beforeSha }
            : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      });
      expect(events).toEqual(["build", "validate", "stop"]);
      const expectedSha = restoreSource ? beforeSha : candidateSha;
      expect(await git(root, "rev-parse", "HEAD")).toBe(expectedSha);
      expect(result.steps).toContainEqual(
        expect.objectContaining({
          name: "git rollback verify HEAD",
          exitCode: restoreSource ? 0 : 1,
          stdoutTail: expectedSha,
          ...(restoreSource ? {} : { stderrTail: `expected ${beforeSha}, found ${candidateSha}` }),
        }),
      );
      if (!restoreRuntime) {
        if (!distBackup) {
          throw new Error("The original dist backup was not observed.");
        }
        expect(
          JSON.parse(await fs.readFile(path.join(distBackup, "build-info.json"), "utf8")),
        ).toMatchObject({
          commit: beforeSha,
        });
        expect(result.steps).toContainEqual(
          expect.objectContaining({
            name: "git runtime rollback",
            exitCode: 1,
            stderrTail: expect.stringContaining(distBackup),
          }),
        );
        return;
      }
      await expectRuntime(root, beforeSha);
    },
  );

  it.each([false, true])(
    "retries partial runtime restoration without losing originals (cleanup first: %s)",
    async (cleanupFirst) => {
      const candidateSha = await advanceRemote();
      await git(root, "fetch", "origin");
      const cleanupRoot = path.join(directory, "restore-candidate");
      const candidateRoot = path.join(cleanupRoot, "worktree");
      await fs.mkdir(cleanupRoot);
      await git(root, "worktree", "add", "--detach", candidateRoot, candidateSha);
      await writeRuntime(
        candidateRoot,
        candidateSha,
        path.join(directory, "shared-store"),
        virtualStoreLayout,
      );
      await expectRuntime(candidateRoot, candidateSha);
      const promotion = await prepareGitRuntimePromotion(
        root,
        candidateRoot,
        runCommand,
        5000,
        cleanupRoot,
      );
      await git(root, "worktree", "remove", "--force", candidateRoot);
      await fs.rm(cleanupRoot, { recursive: true, force: true });
      const rename = fs.rename.bind(fs);
      let distBackup: string | undefined;
      let rejectRestore = true;
      vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (source === path.join(root, "dist")) {
          distBackup = String(destination);
        }
        if (rejectRestore && source === distBackup && destination === path.join(root, "dist")) {
          await fs.mkdir(destination, { recursive: true });
          await fs.writeFile(path.join(destination, "restore-race"), "occupied");
        }
        return rename(source, destination);
      });
      await promotion.activate();
      await expectRuntime(root, candidateSha);
      await expect(promotion.restore()).rejects.toThrow();
      if (cleanupFirst) {
        await promotion.cleanup();
      }
      if (!distBackup) {
        throw new Error("The original dist backup was not observed.");
      }
      expect(
        JSON.parse(await fs.readFile(path.join(distBackup, "build-info.json"), "utf8")),
      ).toMatchObject({
        commit: beforeSha,
      });
      expect(await fs.readFile(path.join(root, "node_modules", "identity.cjs"), "utf8")).toContain(
        beforeSha,
      );
      rejectRestore = false;
      await promotion.restore();
      await expectRuntime(root, beforeSha);
      await promotion.cleanup();
      await expect(fs.stat(path.dirname(distBackup))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
