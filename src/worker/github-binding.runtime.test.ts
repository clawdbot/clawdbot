import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as exec from "../process/exec.js";
import { prepareWorkerGitHubEnvironment } from "./github-binding.runtime.js";

const { warn, inspectPathPermissions } = vi.hoisted(() => ({
  warn: vi.fn(),
  inspectPathPermissions: vi.fn(),
}));
vi.mock("../infra/permissions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/permissions.js")>();
  inspectPathPermissions.mockImplementation(actual.inspectPathPermissions);
  return { ...actual, inspectPathPermissions };
});
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => ({ ...actual.createSubsystemLogger(name), warn }),
  };
});

describe("prepareWorkerGitHubEnvironment", () => {
  const remoteUrl = "https://github.com/openclaw/worker-fixture.git";
  const binding = {
    token: "worker-checkout-synthetic-token",
    login: "worker-fixture",
    branch: "openclaw/session-fixture",
    remoteUrl,
    gitAuthor: { name: "Worker Fixture", email: "worker@openclaw.invalid" },
  };
  const filename = " reconciled file.txt";
  const pushedContent = "earlier worker content\n";
  let root: string;
  let cwd: string;
  let origin: string;
  let initialHead: string;

  async function git(directory: string, ...args: string[]) {
    const result = await exec.runExec("git", ["-C", directory, ...args], {
      timeoutMs: 10_000,
      logOutput: false,
    });
    return result.stdout;
  }

  async function commit(directory: string, message: string) {
    await git(directory, "add", ".");
    await git(
      directory,
      "-c",
      "user.name=Worker Fixture",
      "-c",
      "user.email=worker@openclaw.invalid",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "--allow-empty",
      "-m",
      message,
    );
    return (await git(directory, "rev-parse", "HEAD")).trim();
  }

  async function publishEarlierTurn() {
    const seed = path.join(root, "earlier-worker");
    await git(root, "clone", "--quiet", "--branch", "main", origin, seed);
    await fs.writeFile(path.join(seed, filename), pushedContent);
    const remoteHead = await commit(seed, "Earlier turn");
    await git(seed, "push", "--quiet", "origin", `HEAD:refs/heads/${binding.branch}`);
    return remoteHead;
  }

  const prepare = () =>
    prepareWorkerGitHubEnvironment({
      binding,
      stateDir: path.join(root, "state"),
      runId: "turn",
      cwd,
    });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "worker-checkout-")));
    cwd = path.join(root, "worker");
    origin = pathToFileURL(path.join(root, "origin.git")).href;
    vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(root, "gitconfig"));
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_COUNT", "0");
    await fs.mkdir(cwd);
    await git(root, "init", "--quiet", "--bare", "origin.git");
    // The binding rewrites origin to the verified GitHub URL; route it to the local bare repo.
    await git(root, "config", "--global", `url.${origin}.insteadOf`, remoteUrl);
    await git(cwd, "init", "--quiet", `--initial-branch=${binding.branch}`);
    initialHead = await commit(cwd, "Initial commit");
    await git(cwd, "remote", "add", "origin", origin);
    await git(cwd, "push", "--quiet", "origin", "HEAD:refs/heads/main");
    warn.mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    { scenario: "reconciled identical content", content: pushedContent, porcelain: "" },
    { scenario: "reconciled local edits", content: "local edit\n", porcelain: ` M ${filename}\0` },
    { scenario: "a missing pushed file", content: undefined, porcelain: "" },
  ])(
    "fast-forwards $scenario without losing working-tree bytes",
    async ({ content, porcelain }) => {
      const remoteHead = await publishEarlierTurn();
      if (content !== undefined) {
        await fs.writeFile(path.join(cwd, filename), content);
      }

      await prepare();

      expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
      expect((await git(cwd, "rev-parse", `refs/heads/${binding.branch}`)).trim()).toBe(remoteHead);
      expect((await git(cwd, "rev-parse", `refs/remotes/origin/${binding.branch}`)).trim()).toBe(
        remoteHead,
      );
      expect(await git(cwd, "status", "--porcelain", "-z")).toBe(porcelain);
      expect(await fs.readFile(path.join(cwd, filename), "utf8")).toBe(content ?? pushedContent);
      expect(
        (await git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")).trim(),
      ).toBe(`origin/${binding.branch}`);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("leaves diverged local history and files untouched with one warning", async () => {
    const remoteHead = await publishEarlierTurn();
    await fs.writeFile(path.join(cwd, "local.txt"), "local commit\n");
    const localHead = await commit(cwd, "Local turn");
    await fs.writeFile(path.join(cwd, filename), "local untracked content\n");
    const before = await git(cwd, "status", "--porcelain");

    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(localHead);
    expect(await git(cwd, "status", "--porcelain")).toBe(before);
    expect(await fs.readFile(path.join(cwd, filename), "utf8")).toBe("local untracked content\n");
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(binding.branch));
    expect(warn.mock.lastCall?.[0]).toContain(localHead.slice(0, 7));
    expect(warn.mock.lastCall?.[0]).toContain(remoteHead.slice(0, 7));
  });

  it("keeps the session's own tracked-file deletion while materializing new pushed files", async () => {
    // A file tracked since the initial commit that the previous turn deleted locally.
    const keepDeleted = "keep-deleted.txt";
    await fs.writeFile(path.join(cwd, keepDeleted), "to be deleted\n");
    initialHead = await commit(cwd, "Track a file that will be deleted");
    await git(cwd, "push", "--quiet", "--force", "origin", "HEAD:refs/heads/main");
    const remoteHead = await publishEarlierTurn();
    await fs.rm(path.join(cwd, keepDeleted));

    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    await expect(fs.access(path.join(cwd, keepDeleted))).rejects.toThrow();
    expect(await git(cwd, "status", "--porcelain", "-z")).toBe(` D ${keepDeleted}\0`);
    expect(await fs.readFile(path.join(cwd, filename), "utf8")).toBe(pushedContent);
    expect(warn).not.toHaveBeenCalled();
  });

  it("never starts the credentialed fetch for a fenced turn", async () => {
    const remoteHead = await publishEarlierTurn();
    const controller = new AbortController();
    controller.abort(new Error("worker fenced: owner-epoch-mismatch"));

    await prepareWorkerGitHubEnvironment({
      binding,
      stateDir: path.join(root, "state"),
      runId: "turn",
      cwd,
      signal: controller.signal,
    });

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    await expect(git(cwd, "rev-parse", "--verify", "FETCH_HEAD")).rejects.toThrow();
  });

  it("rejects the fetch when the turn is fenced while it is being spawned", async () => {
    const remoteHead = await publishEarlierTurn();
    const controller = new AbortController();
    const runCommand = exec.runCommandWithTimeout;
    let fetchAttempts = 0;
    vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      if (argv.includes("fetch")) {
        fetchAttempts += 1;
        // The claim closes after the pre-check and before the process starts.
        controller.abort(new Error("worker fenced: credential-replaced"));
      }
      return await runCommand(argv, options);
    });

    await prepareWorkerGitHubEnvironment({
      binding,
      stateDir: path.join(root, "state"),
      runId: "turn",
      cwd,
      signal: controller.signal,
    });

    expect(fetchAttempts).toBe(1);
    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    await expect(git(cwd, "rev-parse", "--verify", "FETCH_HEAD")).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("GitHub checkout binding failed"));
  });

  it("disables the binding before any token use when a Windows profile is not owner-only", async () => {
    const remoteHead = await publishEarlierTurn();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    inspectPathPermissions.mockResolvedValueOnce({
      ok: true,
      source: "windows-acl",
      ownerTrusted: false,
      groupReadable: true,
      worldReadable: false,
      groupWritable: false,
      worldWritable: false,
    } as never);
    try {
      await expect(prepare()).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    await expect(git(cwd, "rev-parse", "--verify", "FETCH_HEAD")).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("profile is not owner-only"));
  });

  it("never fetches or fast-forwards without a verified GitHub origin", async () => {
    const remoteHead = await publishEarlierTurn();
    const { remoteUrl: _omitted, ...withoutRemote } = binding;

    await prepareWorkerGitHubEnvironment({
      binding: withoutRemote,
      stateDir: path.join(root, "state"),
      runId: "turn",
      cwd,
    });

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(remoteHead).not.toBe(initialHead);
    await expect(git(cwd, "rev-parse", "--verify", "FETCH_HEAD")).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("silently leaves the checkout alone when the session branch does not exist on origin", async () => {
    await fs.writeFile(path.join(cwd, filename), "first turn\n");
    const before = await git(cwd, "status", "--porcelain");

    await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(await git(cwd, "status", "--porcelain")).toBe(before);
    expect(await fs.readFile(path.join(cwd, filename), "utf8")).toBe("first turn\n");
    expect(warn).not.toHaveBeenCalled();
  });

  it("fetches with the private turn token and managed identity environment", async () => {
    const remoteHead = await publishEarlierTurn();
    vi.stubEnv("GH_TOKEN", "inherited-synthetic-token");
    vi.stubEnv("GITHUB_TOKEN", "inherited-synthetic-token");
    const runner = vi.spyOn(exec, "runCommandWithTimeout");

    const prepared = await prepare();

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(remoteHead);
    expect(prepared?.localIdentityEnv).toMatchObject({
      GH_CONFIG_DIR: expect.stringContaining(path.join(root, "state", "github-profiles")),
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "!gh auth git-credential",
      GIT_AUTHOR_NAME: binding.gitAuthor.name,
      GIT_AUTHOR_EMAIL: binding.gitAuthor.email,
    });
    const fetchCall = runner.mock.calls.find(([args]) => args[3] === "fetch");
    expect(fetchCall?.[0]).toEqual([
      "git",
      "-C",
      cwd,
      "fetch",
      "--quiet",
      "origin",
      binding.branch,
    ]);
    const options = fetchCall?.[1];
    if (typeof options !== "object") {
      throw new Error("Expected options for Git fetch");
    }
    expect(options.timeoutMs).toBe(60_000);
    // Project only fixture-owned keys so a failed assertion cannot dump the host environment.
    const expectedEnv = {
      ...prepared?.localIdentityEnv,
      GH_TOKEN: binding.token,
      GITHUB_TOKEN: "",
    };
    const actualEnv = Object.fromEntries(
      Object.keys(expectedEnv).map((key) => [key, options.baseEnv?.[key]]),
    );
    expect(actualEnv).toEqual(expectedEnv);
    expect(JSON.stringify(prepared)).not.toContain(binding.token);
    expect(process.env.GH_TOKEN).toBe("inherited-synthetic-token");
    expect(process.env.GITHUB_TOKEN).toBe("inherited-synthetic-token");
  });

  it("warns and continues without changing local files when origin cannot be fetched", async () => {
    await fs.writeFile(path.join(cwd, filename), "unpublished work\n");
    await fs.rm(path.join(root, "origin.git"), { recursive: true });
    const before = await git(cwd, "status", "--porcelain");

    expect(await prepare()).toMatchObject({ managedLocalIdentity: true });

    expect((await git(cwd, "rev-parse", "HEAD")).trim()).toBe(initialHead);
    expect(await git(cwd, "status", "--porcelain")).toBe(before);
    expect(await fs.readFile(path.join(cwd, filename), "utf8")).toBe("unpublished work\n");
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("git fetch failed"));
    expect(warn.mock.lastCall?.[0]).not.toContain(binding.token);
    expect(warn.mock.lastCall?.[0]).not.toContain(origin);
  });
});
