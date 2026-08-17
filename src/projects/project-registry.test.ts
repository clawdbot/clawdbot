import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { cloneProjectCheckout, ProjectCloneError } from "./project-clone-runtime.js";
import { materializeProjectClone } from "./project-clone.js";
import { parseProjectGitUrl } from "./project-git-url.js";
import {
  listProjectRegistry,
  ProjectCheckoutError,
  registerClonedProjectRegistry,
  registerProjectRegistry,
  removeProjectRegistry,
} from "./project-registry.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function initializeRepository(root: string, name: string): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "OpenClaw Tests"]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "tests@openclaw.invalid"]);
  await fs.writeFile(path.join(repo, "README.md"), `${name}\n`);
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
  return await fs.realpath(repo);
}

describe("project registry", () => {
  it.each([
    ["https://github.com/OpenClaw/OpenClaw", "https://github.com/openclaw/openclaw.git"],
    ["https://github.com/OpenClaw/OpenClaw.git", "https://github.com/openclaw/openclaw.git"],
    ["git@github.com:OpenClaw/OpenClaw.git", "https://github.com/openclaw/openclaw.git"],
    ["ssh://git@github.com/OpenClaw/OpenClaw.git", "https://github.com/openclaw/openclaw.git"],
    ["ssh://git@github.com:22/OpenClaw/OpenClaw", "https://github.com/openclaw/openclaw.git"],
  ])("canonicalizes accepted GitHub clone URL %s", (input, expected) => {
    expect(parseProjectGitUrl(input)?.url).toBe(expected);
  });

  it.each([
    "http://github.com/openclaw/openclaw.git",
    "file:///tmp/openclaw.git",
    "ssh://git@github.com:2222/openclaw/openclaw.git",
    "/tmp/openclaw",
    "../openclaw",
    "--upload-pack=touch-pwned",
    "https://token@github.com/openclaw/openclaw.git",
    "https://github.com/openclaw/openclaw.git?config=evil",
    "https://github.com/openclaw/openclaw/extra",
    "git@github.com:../../tmp/openclaw.git",
    "https://github.com/openclaw/openclaw.git --config=evil",
  ])("rejects unsafe project clone URL %s", (input) => {
    expect(parseProjectGitUrl(input)).toBeNull();
  });

  it("lazily ensures the additive table exactly once per database", async () => {
    const root = tempDirs.make("openclaw-project-schema-");
    const options = { path: path.join(root, "state.sqlite") };
    openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(options.path);
    legacy.exec("DROP TABLE projects;");
    legacy.close();

    const state = openOpenClawStateDatabase(options);
    expect(
      state.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'projects'")
        .get(),
    ).toBeUndefined();

    expect(listProjectRegistry({} as OpenClawConfig, options)).toEqual([
      expect.objectContaining({ id: "workspace:main", source: "workspace" }),
    ]);
    expect(listProjectRegistry({} as OpenClawConfig, options)).toHaveLength(1);

    const rows = state.db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'projects'")
      .all();
    expect(rows).toEqual([{ name: "projects" }]);
  });

  it("registers, orders, resolves real paths, suffixes collisions, and removes rows", async () => {
    const root = tempDirs.make("openclaw-project-roundtrip-");
    const repo = await initializeRepository(root, "openclaw");
    const alias = path.join(root, "repo-link");
    await fs.symlink(repo, alias, "dir");
    const options = { path: path.join(root, "state.sqlite") };

    const first = await registerProjectRegistry({ path: alias, name: "OpenClaw" }, options);
    const second = await registerProjectRegistry({ path: repo, name: "OpenClaw" }, options);
    expect(first).toMatchObject({
      id: "openclaw",
      displayName: "OpenClaw",
      repoRoot: repo,
      source: "registered",
    });
    expect(second.id).toBe("openclaw-2");

    const cfg = {
      agents: {
        list: [
          { id: "main", default: true, workspace: "/workspace/zeta" },
          { id: "work", workspace: "/workspace/alpha" },
        ],
      },
    } as OpenClawConfig;
    expect(listProjectRegistry(cfg, options).map((project) => project.displayName)).toEqual([
      "alpha",
      "OpenClaw",
      "OpenClaw",
      "zeta",
    ]);
    expect(removeProjectRegistry(first.id, options)).toBe(true);
    expect(removeProjectRegistry(first.id, options)).toBe(false);
    expect(listProjectRegistry(cfg, options).map((project) => project.id)).not.toContain(first.id);
  });

  it("rejects paths outside a git checkout", async () => {
    const root = tempDirs.make("openclaw-project-non-git-");
    await expect(
      registerProjectRegistry({ path: root }, { path: path.join(root, "state.sqlite") }),
    ).rejects.toBeInstanceOf(ProjectCheckoutError);
  });

  it("clones a local bare fixture through the internal full-history clone boundary", async () => {
    const root = tempDirs.make("openclaw-project-clone-");
    const source = await initializeRepository(root, "source");
    await fs.writeFile(path.join(source, "second.txt"), "second\n");
    await execFileAsync("git", ["-C", source, "add", "second.txt"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "second"]);
    const bare = path.join(root, "fixture.git");
    await execFileAsync("git", ["clone", "--bare", "--", source, bare]);
    const target = path.join(root, "managed", "fixture");

    await cloneProjectCheckout({ url: bare, target });

    expect(await fs.readFile(path.join(target, "second.txt"), "utf8")).toBe("second\n");
    const history = await execFileAsync("git", ["-C", target, "rev-list", "--count", "HEAD"]);
    expect(history.stdout.trim()).toBe("2");
    const project = await registerClonedProjectRegistry(
      {
        path: target,
        name: "Fixture",
        originUrl: "https://github.com/acme/fixture.git",
      },
      { path: path.join(root, "state.sqlite") },
    );
    expect(project).toMatchObject({
      source: "cloned",
      originUrl: "https://github.com/acme/fixture.git",
    });
  });

  it("returns an existing registration for the same canonical remote without cloning", async () => {
    const root = tempDirs.make("openclaw-project-idempotent-");
    const repo = await initializeRepository(root, "existing");
    await execFileAsync("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "git@github.com:Acme/Existing.git",
    ]);
    const options = { path: path.join(root, "state.sqlite"), env: process.env };
    const registered = await registerProjectRegistry({ path: repo, name: "Existing" }, options);

    const added = await materializeProjectClone(
      { cfg: {} as OpenClawConfig, gitUrl: "https://github.com/acme/existing.git" },
      options,
    );

    expect(added).toEqual(registered);
    expect(listProjectRegistry({} as OpenClawConfig, options)).toHaveLength(2);
  });

  it("classifies authentication failures without returning credential material", async () => {
    const token = "github_pat_secret-fixture-value";
    const server = http.createServer((_request, response) => {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Git"' });
      response.end("authentication required");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test HTTP server did not bind a TCP port");
    }
    try {
      const error = await cloneProjectCheckout(
        {
          url: `http://127.0.0.1:${address.port}/private.git`,
          target: path.join(tempDirs.make("openclaw-project-auth-"), "private"),
        },
        { token },
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProjectCloneError);
      expect(error).toMatchObject({ failure: "auth_required" });
      expect((error as Error).message).not.toContain(token);
      expect((error as Error).message).toContain("gateway.controlUi.github.token");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((closeError) => {
          if (closeError) {
            reject(closeError);
          } else {
            resolve();
          }
        });
      });
    }
  });
});
