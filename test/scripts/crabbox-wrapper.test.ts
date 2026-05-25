import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const repoRoot = process.cwd();

function makeFakeCrabbox(helpText: string): string {
  const binDir = mkdtempSync(path.join(tmpdir(), "openclaw-fake-crabbox-"));
  tempDirs.push(binDir);
  writeFakeCrabbox(binDir, helpText);
  return binDir;
}

function writeFakeCrabbox(binDir: string, helpText: string): string {
  mkdirSync(binDir, { recursive: true });
  const crabboxPath = path.join(binDir, "crabbox");
  const script = [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version") {',
    '  console.log("crabbox 0.15.0");',
    "  process.exit(0);",
    "}",
    'if (args[0] === "run" && args[1] === "--help") {',
    `  process.stdout.write(${JSON.stringify(helpText)});`,
    "  process.exit(0);",
    "}",
    "console.log(JSON.stringify({ args, cwd: process.cwd() }));",
  ].join("\n");
  writeFileSync(crabboxPath, `${script}\n`, "utf8");
  writeFileSync(
    `${crabboxPath}.cmd`,
    `@echo off\r\n"${process.execPath}" "%~dp0crabbox" %*\r\n`,
    "utf8",
  );
  chmodSync(crabboxPath, 0o755);
  return crabboxPath;
}

function makeFakeGit(responses: Record<string, { status?: number; stdout?: string; stderr?: string }>): string {
  const binDir = mkdtempSync(path.join(tmpdir(), "openclaw-fake-git-"));
  tempDirs.push(binDir);
  const gitPath = path.join(binDir, "git");
  const script = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const responses = new Map(Object.entries(JSON.parse(process.env.OPENCLAW_FAKE_GIT_RESPONSES || '{}')));",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'worktree' && args[1] === 'add') { fs.mkdirSync(args[3], { recursive: true }); process.exit(0); }",
    "if (args[0] === '-C' && args[2] === 'sparse-checkout' && args[3] === 'disable') { process.exit(0); }",
    "if (args[0] === '-C' && args[2] === 'reset' && args[3] === '--mixed') { process.exit(0); }",
    "if (args[0] === 'worktree' && args[1] === 'remove') { process.exit(0); }",
    "const key = args.join('\\u0000');",
    "const response = responses.get(key);",
    "if (!response) { process.exit(1); }",
    "if (response.stdout) process.stdout.write(response.stdout);",
    "if (response.stderr) process.stderr.write(response.stderr);",
    "process.exit(response.status ?? 0);",
  ].join("\n");
  writeFileSync(gitPath, `${script}\n`, "utf8");
  writeFileSync(`${gitPath}.cmd`, `@echo off\r\n"${process.execPath}" "%~dp0git" %*\r\n`, "utf8");
  chmodSync(gitPath, 0o755);
  return binDir;
}

function runWrapper(
  helpText: string,
  args: string[],
  options: {
    extraPathEntries?: string[];
    gitResponses?: Record<string, { status?: number; stdout?: string; stderr?: string }>;
  } = {},
) {
  const binDir = makeFakeCrabbox(helpText);
  const gitBinDir = options.gitResponses ? makeFakeGit(options.gitResponses) : "";
  return spawnSync(process.execPath, ["scripts/crabbox-wrapper.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [...(options.extraPathEntries ?? []), binDir, gitBinDir, process.env.PATH ?? ""]
        .filter(Boolean)
        .join(path.delimiter),
      ...(options.gitResponses
        ? { OPENCLAW_FAKE_GIT_RESPONSES: JSON.stringify(options.gitResponses) }
        : {}),
    },
  });
}

function parseFakeCrabboxOutput(result: ReturnType<typeof runWrapper>): { args: string[]; cwd: string } {
  return JSON.parse(result.stdout.trim()) as { args: string[]; cwd: string };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/crabbox-wrapper", () => {
  it("accepts advertised canonical providers from Crabbox help", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "local-container", "--", "echo ok"],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"local-container"');
  });

  it("defaults AWS macOS runs to on-demand capacity", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "echo ok"],
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target",
      "macos",
      "--market",
      "on-demand",
      "--",
      "echo ok",
    ]);
  });

  it("defaults AWS macOS warmups to on-demand capacity", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["warmup", "--provider", "aws", "--target", "macos"],
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "warmup",
      "--provider",
      "aws",
      "--target",
      "macos",
      "--market",
      "on-demand",
    ]);
  });

  it("does not override explicit AWS macOS market or lease selections", () => {
    const helpText = "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n";
    const explicitMarket = runWrapper(helpText, [
      "run",
      "--provider",
      "aws",
      "--target=macos",
      "--market",
      "spot",
      "--",
      "echo ok",
    ]);
    const existingLease = runWrapper(helpText, [
      "run",
      "--provider",
      "aws",
      "--target",
      "macos",
      "--id",
      "cbx_existing",
      "--",
      "echo ok",
    ]);

    expect(explicitMarket.status).toBe(0);
    expect(parseFakeCrabboxOutput(explicitMarket).args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target=macos",
      "--market",
      "spot",
      "--",
      "echo ok",
    ]);
    expect(existingLease.status).toBe(0);
    expect(parseFakeCrabboxOutput(existingLease).args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target",
      "macos",
      "--id",
      "cbx_existing",
      "--",
      "echo ok",
    ]);
  });

  it("finds a Crabbox checkout next to the Git common dir in linked worktrees", () => {
    const fakeWorkspaceParent = mkdtempSync(path.join(tmpdir(), "openclaw-linked-worktree-"));
    tempDirs.push(fakeWorkspaceParent);
    const gitCommonDir = path.join(fakeWorkspaceParent, "openclaw", ".git");
    const crabboxBinDir = path.join(fakeWorkspaceParent, "crabbox", "bin");
    mkdirSync(gitCommonDir, { recursive: true });
    writeFakeCrabbox(crabboxBinDir, "provider: aws\n");
    const gitResponses = {
      ["rev-parse\u0000--git-common-dir"]: { stdout: `${gitCommonDir}\n` },
    };
    const gitBinDir = makeFakeGit(gitResponses);

    const result = spawnSync(
      process.execPath,
      ["scripts/crabbox-wrapper.mjs", "run", "--provider", "aws", "--", "echo ok"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_FAKE_GIT_RESPONSES: JSON.stringify(gitResponses),
          PATH: [gitBinDir, path.dirname(process.execPath)].join(path.delimiter),
        },
      },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toContain("aws");
  });

  it("accepts advertised providers from wrapped Crabbox help", () => {
    const result = runWrapper(
      [
        "provider: hetzner, aws, local-container, blacksmith-testbox,",
        "  docker, or cloudflare (default: aws)",
        "",
      ].join("\n"),
      ["run", "--provider", "docker", "--", "echo ok"],
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"docker"');
    expect(result.stderr).toContain(
      "providers=hetzner,aws,local-container,blacksmith-testbox,docker,cloudflare",
    );
  });

  if (process.platform === "win32") {
    it("preserves shell metacharacters through Windows Crabbox command shims", () => {
      const remoteCommand = "pnpm build && pnpm test | more < in.txt > out.txt %PATH%";
      const result = runWrapper("provider: aws\n", ["run", "--shell", "--", remoteCommand]);

      expect(result.status).toBe(0);
      expect(parseFakeCrabboxOutput(result).args).toEqual(["run", "--shell", "--", remoteCommand]);
    });
  }

  if (process.platform !== "win32") {
    it("keeps POSIX PATH lookup semantics for non-executable entries", () => {
      const staleBinDir = mkdtempSync(path.join(tmpdir(), "openclaw-stale-crabbox-"));
      tempDirs.push(staleBinDir);
      writeFileSync(path.join(staleBinDir, "crabbox"), "not executable\n", "utf8");
      const result = runWrapper(
        "provider: aws\n",
        ["run", "--provider", "aws", "--", "echo ok"],
        { extraPathEntries: [staleBinDir] },
      );

      expect(result.status).toBe(0);
      expect(parseFakeCrabboxOutput(result).args).toContain("aws");
    });
  }

  it("falls back to normal sync decisions when git is missing from PATH", () => {
    const binDir = makeFakeCrabbox(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
    );
    const result = spawnSync(
      process.execPath,
      ["scripts/crabbox-wrapper.mjs", "run", "--provider", "aws", "--", "echo ok"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: [binDir, path.dirname(process.execPath)].join(path.delimiter),
        },
      },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toContain("aws");
  });

  it("accepts Crabbox provider aliases when their canonical provider is advertised", () => {
    const helpText = [
      "provider: hetzner, aws, gcp, local-container, blacksmith-testbox,",
      "  namespace-devbox, runpod, semaphore, cloudflare, railway, exe-dev, or ssh",
      "",
    ].join("\n");
    const aliases = [
      "blacksmith",
      "cf",
      "container",
      "docker",
      "exe",
      "exedev",
      "google",
      "google-cloud",
      "local-docker",
      "namespace",
      "namespace-devboxes",
      "rail",
      "railwayapp",
      "run-pod",
      "runpodio",
      "sem",
      "static",
      "static-ssh",
    ];

    for (const alias of aliases) {
      const result = runWrapper(helpText, ["run", "--provider", alias, "--", "echo ok"]);

      expect(result.status, alias).toBe(0);
      expect(result.stdout).toContain(`"${alias}"`);
    }
  });

  it("accepts Crabbox provider aliases when upstream help omits Tensorlake", () => {
    const helpText = [
      "provider: hetzner, aws, gcp, local-container, blacksmith-testbox,",
      "  namespace-devbox, runpod, semaphore, cloudflare, railway, exe-dev, or ssh",
      "",
    ].join("\n");

    for (const provider of ["tensorlake", "tl", "tensorlake-sbx"]) {
      const result = runWrapper(helpText, ["run", "--provider", provider, "--", "echo ok"]);

      expect(result.status, provider).toBe(0);
      expect(result.stdout).toContain(`"${provider}"`);
    }
  });

  it("keeps unsupported provider selections rejected", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "bogus", "--", "echo ok"],
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("selected binary does not advertise provider bogus");
  });

  it("parses provider choices from the --provider flag help format", () => {
    const result = runWrapper(
      "Usage: crabbox run [options]\n  --provider hetzner|aws|local-container|blacksmith-testbox|cloudflare\n",
      ["run", "--provider", "aws", "--", "echo ok"],
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "providers=hetzner,aws,local-container,blacksmith-testbox,cloudflare",
    );
  });

  it("uses a temporary full checkout for clean sparse Blacksmith syncs", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "blacksmith-testbox",
        "--blacksmith-ref",
        "feature-branch",
        "--",
        "corepack",
        "pnpm",
        "check:changed",
      ],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('"--no-sync"');
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });

  it("uses a temporary full checkout for clean sparse AWS syncs", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "corepack", "pnpm", "check:changed"],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(result.stderr).toContain("overlaying local HEAD as worktree changes from origin/main");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });

  it("keeps clean sparse local-container syncs on the original checkout", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "local-container", "--", "echo ok"],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toBe(repoRoot);
  });

  it("keeps existing AWS leases on the original sparse checkout", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--id", "cbx_existing", "--", "echo ok"],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toBe(repoRoot);
  });

  it("uses a temporary full checkout when clean sparse branches differ from the Blacksmith ref", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--blacksmith-ref", "main", "--", "echo ok"],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('"--no-sync"');
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });

  it("keeps sparse dirty worktrees on the original checkout", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--blacksmith-ref", "main", "--", "echo ok"],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: " M scripts/crabbox-wrapper.mjs\n" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toBe(repoRoot);
  });

  it("keeps local artifact paths rooted at the original checkout", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "blacksmith-testbox",
        "--blacksmith-ref",
        "main",
        "--capture-stdout=.artifacts/stdout.log",
        "--capture-stderr",
        ".artifacts/stderr.log",
        "--download",
        "/tmp/proof=.artifacts/proof",
        "--",
        "echo ok",
      ],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.cwd).toContain("openclaw-crabbox-sync-");
    expect(output.args).toContain(`--capture-stdout=${path.join(repoRoot, ".artifacts/stdout.log")}`);
    expect(output.args).toContain(path.join(repoRoot, ".artifacts/stderr.log"));
    expect(output.args).toContain(`/tmp/proof=${path.join(repoRoot, ".artifacts/proof")}`);
  });

  it("uses the temporary full checkout for sparse sync-only runs", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "blacksmith-testbox",
        "--blacksmith-ref",
        "feature-branch",
        "--sync-only",
      ],
      {
        gitResponses: {
          ["config\u0000--bool\u0000core.sparseCheckout"]: { stdout: "true\n" },
          ["status\u0000--porcelain=v1"]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });
});
