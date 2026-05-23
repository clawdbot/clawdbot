import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const repoRoot = process.cwd();

function makeFakeCrabbox(helpText: string): string {
  const binDir = mkdtempSync(path.join(tmpdir(), "openclaw-fake-crabbox-"));
  tempDirs.push(binDir);
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
  return binDir;
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
    "if (args[0] === 'worktree' && args[1] === 'remove') { process.exit(0); }",
    "const key = args.join('\\u0000');",
    "const response = responses.get(key);",
    "if (!response) { process.exit(1); }",
    "if (response.stdout) process.stdout.write(response.stdout);",
    "if (response.stderr) process.stderr.write(response.stderr);",
    "process.exit(response.status ?? 0);",
  ].join("\n");
  writeFileSync(gitPath, `${script}\n`, "utf8");
  chmodSync(gitPath, 0o755);
  return binDir;
}

function runWrapper(
  helpText: string,
  args: string[],
  options: { gitResponses?: Record<string, { status?: number; stdout?: string; stderr?: string }> } = {},
) {
  const binDir = makeFakeCrabbox(helpText);
  const gitBinDir = options.gitResponses ? makeFakeGit(options.gitResponses) : "";
  return spawnSync(process.execPath, ["scripts/crabbox-wrapper.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [binDir, gitBinDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
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
