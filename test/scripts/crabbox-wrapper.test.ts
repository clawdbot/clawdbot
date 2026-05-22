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
    "console.log(JSON.stringify(args));",
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

function runWrapper(helpText: string, args: string[]) {
  const binDir = makeFakeCrabbox(helpText);
  return spawnSync(process.execPath, ["scripts/crabbox-wrapper.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
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
});
