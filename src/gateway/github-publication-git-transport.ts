import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitNullConfigPath } from "../infra/git-exec.js";
import { runCommandBuffered } from "../process/exec.js";
import { githubPublicationUnsafeConfigArgs } from "./github-publication-base.js";

type GitCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxOutputBytes?: number;
};
type GitCommandResult = { code: number | null; stdout: Buffer };

export async function runPublicationCommand(argv: string[], options: GitCommandOptions = {}) {
  return await runCommandBuffered(argv, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: {
      ...(options.env ?? process.env),
      GIT_NO_REPLACE_OBJECTS: "1",
      // Pin every command against repository hooks; explicit hook-disabling -c flags stay stronger.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: os.devNull,
    },
    ...(options.input !== undefined ? { input: options.input } : {}),
    timeoutMs: 60_000,
    maxOutputBytes: options.maxOutputBytes ?? 256 * 1024,
  });
}

export async function requirePublicationCommand(
  argv: string[],
  options: GitCommandOptions = {},
): Promise<string> {
  const result = await runPublicationCommand(argv, options);
  if (result.code !== 0) {
    throw new Error(`${argv[0]} command failed`);
  }
  return result.stdout.toString("utf8").trim();
}

// Guard ordinary steps on both sides of the await. Effects whose observations
// must survive revocation use the raw transport and record before rechecking.
export function createGitHubPublicationCommandRunner(assertCurrent?: () => void) {
  const step = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent?.();
    const result = await operation();
    assertCurrent?.();
    return result;
  };
  return {
    step,
    run: (...args: Parameters<typeof runPublicationCommand>) =>
      step(() => runPublicationCommand(...args)),
    require: (...args: Parameters<typeof requirePublicationCommand>) =>
      step(() => requirePublicationCommand(...args)),
  };
}

// A recursive tree listing scales with repository size (openclaw itself is
// ~3.3MB), far past the default per-command cap above. Without this explicit
// bound the attribute scan dies as an output-limit "verification" failure on
// any real repository.
const TREE_LISTING_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export async function assertSafeGitPublicationWorkspace(
  cwd: string,
  run: (argv: string[], options?: GitCommandOptions) => Promise<GitCommandResult>,
): Promise<void> {
  const isolatedConfig = {
    GIT_CONFIG_GLOBAL: gitNullConfigPath(),
    GIT_CONFIG_SYSTEM: gitNullConfigPath(),
  };
  const [localUnsafe, worktreeConfig] = await Promise.all([
    run(githubPublicationUnsafeConfigArgs("--local"), { cwd, env: isolatedConfig }),
    run(
      ["git", "config", "--local", "--includes", "--bool", "--get", "extensions.worktreeConfig"],
      { cwd, env: isolatedConfig },
    ),
  ]);
  const worktreeConfigValue = worktreeConfig.stdout.toString("utf8").trim();
  const worktreeConfigKnown =
    (worktreeConfig.code === 0 &&
      (worktreeConfigValue === "true" || worktreeConfigValue === "false")) ||
    (worktreeConfig.code === 1 && worktreeConfig.stdout.length === 0);
  if (localUnsafe.code !== 1 || localUnsafe.stdout.length > 0 || !worktreeConfigKnown) {
    throw new Error("GitHub publication workspace has unsupported Git transport configuration.");
  }
  const worktreeUnsafe =
    worktreeConfigValue === "true"
      ? await run(githubPublicationUnsafeConfigArgs("--worktree"), {
          cwd,
          env: isolatedConfig,
        })
      : undefined;
  if (worktreeUnsafe && (worktreeUnsafe.code !== 1 || worktreeUnsafe.stdout.length > 0)) {
    throw new Error("GitHub publication workspace has unsupported Git transport configuration.");
  }
  const [replacements, graftPath] = await Promise.all([
    run(["git", "for-each-ref", "--count=1", "--format=%(refname)", "refs/replace"], { cwd }),
    run(["git", "rev-parse", "--git-path", "info/grafts"], { cwd }),
  ]);
  if (replacements.code !== 0 || replacements.stdout.length > 0 || graftPath.code !== 0) {
    throw new Error("GitHub publication workspace has unsupported Git replacement metadata.");
  }
  const grafts = await readOptionalAttributeFile(
    path.resolve(cwd, graftPath.stdout.toString("utf8").trim()),
  );
  if (grafts && grafts.length > 0) {
    throw new Error("GitHub publication workspace has unsupported Git replacement metadata.");
  }
}

function assertNoGitFilterAttributes(contents: Buffer): void {
  for (const line of contents.toString("latin1").split(/\r?\n/u)) {
    const fields = line.trimStart().split(/[\t ]+/u);
    if (!fields[0] || fields[0].startsWith("#")) {
      continue;
    }
    if (fields.slice(1).some((field) => /^(?:-|!)?filter(?:=|$)/u.test(field))) {
      throw new Error("GitHub publication workspace uses an unsupported Git clean filter.");
    }
  }
}

async function readOptionalAttributeFile(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function readGitHubPublicationTree(
  cwd: string,
  workspaceTree: string,
  run: (argv: string[], options?: GitCommandOptions) => Promise<GitCommandResult>,
): Promise<Buffer> {
  const listing = await run(["git", "ls-tree", "-r", "-z", "--full-tree", workspaceTree], {
    cwd,
    maxOutputBytes: TREE_LISTING_MAX_OUTPUT_BYTES,
  });
  if (listing.code !== 0) {
    throw new Error("GitHub publication workspace tree could not be verified.");
  }
  return listing.stdout;
}

async function assertGitHubPublicationTreeHasNoFilters(
  cwd: string,
  workspaceTree: string,
  run: (argv: string[], options?: GitCommandOptions) => Promise<GitCommandResult>,
): Promise<void> {
  const listing = await readGitHubPublicationTree(cwd, workspaceTree, run);
  const attributeObjects = new Set<string>();
  for (const record of listing.toString("latin1").split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const file = record.slice(tab + 1).toLowerCase();
    if (file !== ".gitattributes" && !file.endsWith("/.gitattributes")) {
      continue;
    }
    const objectId = record.slice(0, tab).split(" ")[2];
    if (objectId) {
      attributeObjects.add(objectId);
    }
  }
  if (attributeObjects.size > 1024) {
    throw new Error("GitHub publication workspace has too many Git attribute files.");
  }
  for (const objectId of attributeObjects) {
    const blob = await run(["git", "cat-file", "blob", objectId], { cwd });
    if (blob.code !== 0) {
      throw new Error("GitHub publication workspace attributes could not be verified.");
    }
    assertNoGitFilterAttributes(blob.stdout);
  }

  const infoPath = await run(["git", "rev-parse", "--git-path", "info/attributes"], {
    cwd,
  });
  if (infoPath.code !== 0) {
    throw new Error("GitHub publication workspace attributes could not be verified.");
  }
  const attributeFiles = await Promise.all(
    ["GIT_ATTR_GLOBAL", "GIT_ATTR_SYSTEM"].map(
      async (name) => await run(["git", "var", name], { cwd }),
    ),
  );
  if (attributeFiles.some((result) => result.code !== 0)) {
    throw new Error("GitHub publication workspace attributes could not be verified.");
  }
  const paths = [
    path.resolve(cwd, infoPath.stdout.toString("utf8").trim()),
    ...attributeFiles.flatMap((result) =>
      result.stdout.length > 0 ? [result.stdout.toString("utf8").trim()] : [],
    ),
  ];
  for (const file of paths) {
    const contents = await readOptionalAttributeFile(file);
    if (contents) {
      assertNoGitFilterAttributes(contents);
    }
  }
}

export async function captureGitHubPublicationWorkspaceSnapshot(params: {
  cwd: string;
  assertCurrent?: () => void;
}): Promise<{ sourceHeadCommit: string; sourceIndexTree: string; workspaceTree: string }> {
  const { step, require: command } = createGitHubPublicationCommandRunner(params.assertCurrent);
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    command(["git", "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", ...args], {
      cwd: params.cwd,
      env,
    });
  await step(() => assertSafeGitPublicationWorkspace(params.cwd, runPublicationCommand));
  const sourceHeadCommit = await command(["git", "rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: params.cwd,
  });
  const index = path.resolve(params.cwd, await git(["rev-parse", "--git-path", "index"]));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-snapshot-"));
  try {
    const env = {
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_CONFIG_SYSTEM: gitNullConfigPath(),
      GIT_INDEX_FILE: path.join(tempDir, "index"),
    };
    // Preserve staged path inventory, and keep write-tree cache updates off the real index.
    await step(() => fs.copyFile(index, env.GIT_INDEX_FILE));
    const sourceIndexTree = await git(["write-tree"], env);
    await git(["-c", `core.attributesFile=${os.devNull}`, "add", "-A"], env);
    // Normalize after removals, retaining intent-to-add paths and ignoring copied stat caches.
    await git(["-c", `core.attributesFile=${os.devNull}`, "add", "--renormalize", "-u"], env);
    const workspaceTree = await git(["write-tree"], env);
    await step(() =>
      assertGitHubPublicationTreeHasNoFilters(params.cwd, workspaceTree, runPublicationCommand),
    );
    return { sourceHeadCommit, sourceIndexTree, workspaceTree };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const GITHUB_CREDENTIAL_ARGS = [
  "git",
  "-c",
  "credential.helper=",
  "-c",
  "credential.helper=!gh auth git-credential",
] as const;

export function appendGitHubPublicationMessage(base: string, lines: readonly string[]): string {
  const present = new Set(base.split(/\r?\n/u).map((line) => line.trim()));
  const missing = lines.filter((line) => !present.has(line));
  return missing.length > 0 ? `${base.trimEnd()}\n\n${missing.join("\n")}` : base.trimEnd();
}

export async function assertGitHubPublicationBranchRef(
  branch: string,
  run: (argv: string[]) => Promise<number>,
): Promise<void> {
  const code = await run(["git", "symbolic-ref", "--quiet", `refs/heads/${branch}`]);
  if (code === 0) {
    throw new Error("GitHub publication workspace branch ref became symbolic.");
  }
  if (code !== 1) {
    throw new Error("GitHub publication workspace branch ref could not be verified.");
  }
}

export function githubPublicationPushArgs(
  remote: string,
  headCommit: string,
  branch: string,
): string[] {
  return [
    ...GITHUB_CREDENTIAL_ARGS,
    "-c",
    `core.hooksPath=${os.devNull}`,
    "push",
    "--porcelain",
    "--no-follow-tags",
    "--recurse-submodules=no",
    "--",
    remote,
    `${headCommit}:refs/heads/${branch}`,
  ];
}

export function githubPublicationRemoteHeadArgs(remote: string, branch: string): string[] {
  return [...GITHUB_CREDENTIAL_ARGS, "ls-remote", "--refs", remote, `refs/heads/${branch}`];
}

export function githubPublicationUpdateRefArgs(
  branch: string,
  commit: string,
  previousHead: string,
): string[] {
  return [
    "git",
    "-c",
    `core.hooksPath=${os.devNull}`,
    "-c",
    "core.fsmonitor=false",
    "update-ref",
    `refs/heads/${branch}`,
    commit,
    previousHead,
  ];
}
