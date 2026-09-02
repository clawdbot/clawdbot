import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectOpenPrInventory,
  isApprovedNoReplyEmail,
  parseArgs,
  scanSecurityText,
  validateInventory,
} from "../../scripts/publication-preflight.mjs";

const SCRIPT = path.resolve("scripts/publication-preflight.mjs");
const HOOK = path.resolve("git-hooks/pre-push");
const PREPARE_HOOKS = path.resolve("scripts/prepare-git-hooks.mjs");
const GITHUB_REMOTE = "https://github.com/openclaw/openclaw.git";
const tempDirs: string[] = [];
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function run(cwd: string, command: string, args: string[] = [], input?: string): string {
  return execFileSync(command, args, {
    cwd,
    env: gitEnv,
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim();
}

function runFailure(cwd: string, command: string, args: string[] = [], input?: string): string {
  try {
    run(cwd, command, args, input);
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    return String(failure.stderr ?? failure.message);
  }
  throw new Error("expected command to fail");
}

function makeRepository(options: { remoteUrl?: string } = {}): {
  dir: string;
  manifest: string;
  branch: string;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-publication-preflight-"));
  tempDirs.push(dir);
  run(dir, "git", ["init", "-q", "--initial-branch=main"]);
  run(dir, "git", ["config", "user.name", "OpenClaw Test"]);
  run(dir, "git", ["config", "user.email", "123+openclaw-test@users.noreply.github.com"]);
  run(dir, "git", ["remote", "add", "origin", options.remoteUrl ?? GITHUB_REMOTE]);
  writeFileSync(path.join(dir, "README.md"), "baseline\n", "utf8");
  run(dir, "git", ["add", "--", "README.md"]);
  run(dir, "git", ["commit", "-q", "-m", "baseline"]);
  run(dir, "git", ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const branch = "feat/publication-security-preflight-test";
  run(dir, "git", ["switch", "-q", "-c", branch]);
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "git-hooks"), { recursive: true });
  writeFileSync(
    path.join(dir, "scripts", "publication-preflight.mjs"),
    readFileSync(SCRIPT, "utf8"),
    "utf8",
  );
  writeFileSync(
    path.join(dir, "scripts", "prepare-git-hooks.mjs"),
    readFileSync(PREPARE_HOOKS, "utf8"),
    "utf8",
  );
  writeFileSync(path.join(dir, "git-hooks", "pre-push"), readFileSync(HOOK, "utf8"), "utf8");
  chmodSync(path.join(dir, "git-hooks", "pre-push"), 0o755);
  writeFileSync(path.join(dir, "safe.txt"), "safe publication content\n", "utf8");
  run(dir, "git", ["add", "--", "safe.txt"]);
  return {
    dir,
    branch,
    manifest: path.join(dir, ".git", "publication-security-manifest.json"),
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("publication preflight pure gates", () => {
  it("parses an explicit staged allowlist and PR strategy", () => {
    expect(
      parseArgs([
        "prepare",
        "--path",
        "scripts/publication-preflight.mjs",
        "--path",
        "test/scripts/publication-preflight.test.ts",
        "--strategy",
        "supersede_existing",
        "--supersedes-pr",
        "123",
      ]),
    ).toMatchObject({
      command: "prepare",
      paths: ["scripts/publication-preflight.mjs", "test/scripts/publication-preflight.test.ts"],
      strategy: "supersede_existing",
      supersedesPr: 123,
    });
  });

  it("requires the GitHub no-reply identity", () => {
    expect(isApprovedNoReplyEmail("123+openclaw@users.noreply.github.com")).toBe(true);
    expect(isApprovedNoReplyEmail("person@example.com")).toBe(false);
  });

  it("reports credentials, private paths, internal URLs, personal emails, and private names", () => {
    const credentialFixture = ["token", "not-a-placeholder-secret-value"].join(' = "') + '"';
    const personalEmail = ["person", "@private.test"].join("");
    const internalUrl = ["http://", "localhost:40141/status"].join("");
    const privatePath = ["/", "home/person/", ".", "openclaw/private.json"].join("");
    const findings = scanSecurityText(
      [
        credentialFixture,
        `contact: ${personalEmail}`,
        internalUrl,
        privatePath,
        "Franck private note",
      ].join("\n"),
      { privateNames: ["Franck"] },
    );
    expect(new Set(findings.map((finding) => finding.kind))).toEqual(
      new Set([
        "credential-assignment",
        "personal-email",
        "internal-url",
        "private-path",
        "private-name",
      ]),
    );
  });

  it("blocks a new independent PR when the inventory overlaps changed paths", () => {
    expect(() =>
      validateInventory(
        {
          repository: "openclaw/openclaw",
          strategy: "new_independent",
          head: "feat/publication-security-preflight",
          openPrInventory: [
            {
              number: 42,
              repository: "openclaw/openclaw",
              author: "contributor",
              branch: "other-branch",
              title: "Existing work",
              paths: ["safe.txt"],
            },
          ],
        },
        ["safe.txt"],
      ),
    ).toThrow(/overlap/u);
  });

  it("binds update_existing to the current branch and rejects undeclared overlaps", () => {
    const manifest = {
      repository: "openclaw/openclaw",
      strategy: "update_existing",
      existingPr: 42,
      head: "feat/publication-security-preflight",
      openPrInventory: [
        {
          number: 42,
          repository: "openclaw/openclaw",
          author: "contributor",
          branch: "feat/publication-security-preflight",
          title: "Current publication",
          paths: ["safe.txt"],
        },
        {
          number: 43,
          repository: "openclaw/openclaw",
          author: "other-contributor",
          branch: "other-branch",
          title: "Other overlapping work",
          paths: ["safe.txt"],
        },
      ],
    };

    expect(() =>
      validateInventory({ ...manifest, openPrInventory: [manifest.openPrInventory[0]] }, [
        "safe.txt",
      ]),
    ).not.toThrow();
    expect(() => validateInventory(manifest, ["safe.txt"])).toThrow(/undeclared overlapping PRs/u);
    expect(() =>
      validateInventory(
        {
          ...manifest,
          openPrInventory: [{ ...manifest.openPrInventory[0], branch: "other-branch" }],
        },
        ["safe.txt"],
      ),
    ).toThrow(/current feature branch/u);
  });

  it("rejects undeclared overlaps when superseding an existing PR", () => {
    expect(() =>
      validateInventory(
        {
          repository: "openclaw/openclaw",
          strategy: "supersede_existing",
          supersedesPr: 42,
          head: "feat/publication-security-preflight",
          openPrInventory: [
            {
              number: 42,
              repository: "openclaw/openclaw",
              author: "contributor",
              branch: "old-branch",
              title: "Superseded work",
              paths: ["safe.txt"],
            },
            {
              number: 43,
              repository: "openclaw/openclaw",
              author: "other-contributor",
              branch: "other-branch",
              title: "Other overlapping work",
              paths: ["safe.txt"],
            },
          ],
        },
        ["safe.txt"],
      ),
    ).toThrow(/undeclared overlapping PRs/u);
  });

  it("collects every open PR and changed file across paginated GitHub responses", () => {
    const exec = vi
      .fn()
      .mockReturnValueOnce(
        JSON.stringify([
          [
            {
              number: 41,
              user: { login: "first-author" },
              head: { ref: "first-branch" },
              title: "First PR",
              html_url: "https://github.com/openclaw/openclaw/pull/41",
            },
          ],
          [
            {
              number: 142,
              user: { login: "second-author" },
              head: { ref: "second-branch" },
              title: "Second PR",
              html_url: "https://github.com/openclaw/openclaw/pull/142",
            },
          ],
        ]),
      )
      .mockReturnValueOnce(
        JSON.stringify([[{ filename: "first.txt" }], [{ filename: "next.txt" }]]),
      )
      .mockReturnValueOnce(JSON.stringify([[]]));

    expect(collectOpenPrInventory("openclaw/openclaw", { execFileSync: exec })).toEqual([
      {
        number: 41,
        repository: "openclaw/openclaw",
        author: "first-author",
        branch: "first-branch",
        title: "First PR",
        url: "https://github.com/openclaw/openclaw/pull/41",
        paths: ["first.txt", "next.txt"],
      },
      {
        number: 142,
        repository: "openclaw/openclaw",
        author: "second-author",
        branch: "second-branch",
        title: "Second PR",
        url: "https://github.com/openclaw/openclaw/pull/142",
        paths: [],
      },
    ]);
    for (const call of exec.mock.calls) {
      expect(call[0]).toBe("gh");
      expect(call[1]).toEqual(expect.arrayContaining(["api", "--paginate", "--slurp"]));
    }
  });

  it("fails closed when GitHub pagination is malformed or file data is incomplete", () => {
    expect(() =>
      collectOpenPrInventory("openclaw/openclaw", {
        execFileSync: vi.fn().mockReturnValue(JSON.stringify([{ number: 41 }])),
      }),
    ).toThrow(/failed closed/u);

    const exec = vi
      .fn()
      .mockReturnValueOnce(JSON.stringify([[{ number: 41, head: { ref: "branch" } }]]))
      .mockReturnValueOnce(JSON.stringify([[{}]]));
    expect(() => collectOpenPrInventory("openclaw/openclaw", { execFileSync: exec })).toThrow(
      /reading PR #41/u,
    );
  });
});

describe("publication preflight real hook behavior", () => {
  it("keeps automatic maintained-hook setup transparent until explicit opt-in", () => {
    const bareRemote = mkdtempSync(
      path.join(os.tmpdir(), "openclaw-publication-preflight-unopted-remote-"),
    );
    tempDirs.push(bareRemote);
    run(bareRemote, "git", ["init", "-q", "--bare"]);

    const { dir } = makeRepository({ remoteUrl: `file://${bareRemote}` });
    run(dir, "node", [path.join(dir, "scripts", "prepare-git-hooks.mjs")]);

    expect(run(dir, "git", ["config", "--get", "core.hooksPath"])).toBe("git-hooks");
    const optInPath = path.resolve(
      dir,
      run(dir, "git", ["rev-parse", "--git-path", "publication-preflight.enabled"]),
    );
    expect(existsSync(optInPath)).toBe(false);
    run(dir, "git", ["push", "origin", "HEAD"]);
  });

  it("invokes the configured hook for an allowed push and rejects an unallowlisted commit", () => {
    const bareRemote = mkdtempSync(
      path.join(os.tmpdir(), "openclaw-publication-preflight-remote-"),
    );
    tempDirs.push(bareRemote);
    run(bareRemote, "git", ["init", "-q", "--bare"]);

    const { dir, manifest } = makeRepository({ remoteUrl: `file://${bareRemote}` });
    run(dir, "node", [path.join(dir, "scripts", "prepare-git-hooks.mjs"), "--install"]);
    expect(run(dir, "git", ["config", "--get", "core.hooksPath"])).toBe("git-hooks");
    const optInPath = path.resolve(
      dir,
      run(dir, "git", ["rev-parse", "--git-path", "publication-preflight.enabled"]),
    );
    expect(existsSync(optInPath)).toBe(true);

    run(dir, "node", [
      SCRIPT,
      "prepare",
      "--manifest",
      manifest,
      "--path",
      "safe.txt",
      "--inventory-json",
      "[]",
    ]);
    run(dir, "git", ["commit", "-q", "-m", "publication preflight fixture"]);
    run(dir, "node", [SCRIPT, "check", "--manifest", manifest]);
    run(dir, "node", [SCRIPT, "approve", "--manifest", manifest]);

    run(dir, "git", ["push", "origin", "HEAD"]);

    writeFileSync(path.join(dir, "unallowlisted.txt"), "this path was not reviewed\n", "utf8");
    run(dir, "git", ["add", "--", "unallowlisted.txt"]);
    run(dir, "git", ["commit", "-q", "-m", "unallowlisted publication fixture"]);
    expect(run(dir, "git", ["diff", "--name-only", "origin/main..HEAD"])).toBe(
      "safe.txt\nunallowlisted.txt",
    );
    expect(run(dir, "git", ["config", "--get", "core.hooksPath"])).toBe("git-hooks");
    const failure = runFailure(dir, "git", ["push", "origin", "HEAD"]);
    expect(failure).toContain("commit range does not match the explicit manifest allowlist");
  });

  it("rejects an unallowlisted tracked-file deletion through the real hook", () => {
    const bareRemote = mkdtempSync(
      path.join(os.tmpdir(), "openclaw-publication-preflight-deletion-remote-"),
    );
    tempDirs.push(bareRemote);
    run(bareRemote, "git", ["init", "-q", "--bare"]);

    const { dir, manifest } = makeRepository({ remoteUrl: `file://${bareRemote}` });
    run(dir, "node", [path.join(dir, "scripts", "prepare-git-hooks.mjs"), "--install"]);
    run(dir, "node", [
      SCRIPT,
      "prepare",
      "--manifest",
      manifest,
      "--path",
      "safe.txt",
      "--inventory-json",
      "[]",
    ]);
    run(dir, "git", ["commit", "-q", "-m", "publication preflight fixture"]);
    run(dir, "node", [SCRIPT, "check", "--manifest", manifest]);
    run(dir, "node", [SCRIPT, "approve", "--manifest", manifest]);
    run(dir, "git", ["push", "origin", "HEAD"]);

    run(dir, "git", ["rm", "-q", "--", "README.md"]);
    run(dir, "git", ["commit", "-q", "-m", "unallowlisted deletion fixture"]);
    expect(run(dir, "git", ["diff", "--name-status", "origin/main..HEAD"])).toContain(
      "D\tREADME.md",
    );
    const failure = runFailure(dir, "git", ["push", "origin", "HEAD"]);
    expect(failure).toContain("commit range does not match the explicit manifest allowlist");
    expect(failure).toContain("README.md");
  });
});

describe("publication preflight repository integration", () => {
  it("prepares, checks, approves, and accepts the exact pre-push update", () => {
    const { dir, manifest, branch } = makeRepository();
    const bareRemote = path.join(dir, ".git", "integration-remote.git");
    run(dir, "git", ["init", "-q", "--bare", bareRemote]);
    const remoteUrl = `file://${bareRemote}`;
    run(dir, "git", ["remote", "set-url", "origin", remoteUrl]);
    run(dir, "node", [path.join(dir, "scripts", "prepare-git-hooks.mjs"), "--install"]);
    run(dir, "node", [
      SCRIPT,
      "prepare",
      "--manifest",
      manifest,
      "--path",
      "safe.txt",
      "--inventory-json",
      "[]",
    ]);
    const prepared = JSON.parse(readFileSync(manifest, "utf8"));
    expect(prepared.approval.granted).toBe(false);

    run(dir, "git", ["commit", "-q", "-m", "publication preflight fixture"]);
    run(dir, "node", [SCRIPT, "check", "--manifest", manifest]);
    run(dir, "node", [SCRIPT, "approve", "--manifest", manifest]);
    run(dir, "git", ["push", "origin", "HEAD"]);
    const head = run(dir, "git", ["rev-parse", "HEAD"]);
    const input = `HEAD ${head} refs/heads/${branch} 0000000000000000000000000000000000000000\n`;

    const extraRefFailure = runFailure(
      dir,
      "node",
      [
        SCRIPT,
        "hook",
        "--manifest",
        manifest,
        "--remote-name",
        "origin",
        "--remote-url",
        remoteUrl,
      ],
      `${input}refs/heads/unreviewed ${head} refs/heads/unreviewed 0000000000000000000000000000000000000000\n`,
    );
    expect(extraRefFailure).toContain(
      "pre-push must contain exactly one update for the current feature branch",
    );
  });

  it("fails closed before approval", () => {
    const { dir, manifest } = makeRepository();
    run(dir, "node", [
      SCRIPT,
      "prepare",
      "--manifest",
      manifest,
      "--path",
      "safe.txt",
      "--inventory-json",
      "[]",
    ]);
    run(dir, "git", ["commit", "-q", "-m", "publication preflight fixture"]);
    const head = run(dir, "git", ["rev-parse", "HEAD"]);
    const message = runFailure(
      dir,
      "node",
      [
        SCRIPT,
        "hook",
        "--manifest",
        manifest,
        "--remote-name",
        "origin",
        "--remote-url",
        "https://github.com/openclaw/openclaw.git",
      ],
      `refs/heads/feat/publication-security-preflight-test ${head} refs/heads/feat/publication-security-preflight-test 0000000000000000000000000000000000000000\n`,
    );
    expect(message).toContain("external publication approval is required");
  });
});
