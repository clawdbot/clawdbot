import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSandboxScript } from "./doctor-sandbox.js";

describe("resolveSandboxScript", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    created.push(dir);
    // Resolve macOS /var → /private/var so expectations match realpath output.
    return fs.realpathSync(dir);
  }

  const scriptRel = path.join("scripts", "sandbox-setup.sh");

  // Create a repo checkout that the shared resolver will recognize: it keys off an openclaw
  // package.json marker, then resolveSandboxScript looks for scripts/ under that root.
  function mkRepo(prefix: string): string {
    const repo = mkTmp(prefix);
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, scriptRel), "#!/bin/sh\n");
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "openclaw" }));
    return repo;
  }

  it("follows a symlinked launcher to find scripts/ in the real repo", () => {
    // Repo checkout that actually contains scripts/sandbox-setup.sh ...
    const repo = mkRepo("ocsbx-repo-");
    const entry = path.join(repo, "openclaw.mjs");
    fs.writeFileSync(entry, "");

    // ... reached only via a symlinked launcher in an unrelated bin dir (the npm/pnpm global case).
    const binDir = mkTmp("ocsbx-bin-");
    const launcher = path.join(binDir, "openclaw");
    fs.symlinkSync(entry, launcher);

    const result = resolveSandboxScript(scriptRel, { argv1: launcher, cwd: binDir });

    // Without following the symlink this returns null (the old bug); with realpath it finds the repo.
    expect(result).not.toBeNull();
    expect(result?.scriptPath).toBe(path.join(repo, scriptRel));
    expect(result?.cwd).toBe(repo);
  });

  it("still resolves a script relative to a non-symlinked launcher dir", () => {
    const repo = mkRepo("ocsbx-direct-");
    const entry = path.join(repo, "openclaw.mjs");
    fs.writeFileSync(entry, "");

    const result = resolveSandboxScript(scriptRel, { argv1: entry, cwd: os.tmpdir() });

    expect(result?.scriptPath).toBe(path.join(repo, scriptRel));
  });

  it("returns null when the script is unreachable from cwd or the launcher", () => {
    const binDir = mkTmp("ocsbx-none-");
    const launcher = path.join(binDir, "openclaw");
    fs.writeFileSync(launcher, "");

    expect(
      resolveSandboxScript(scriptRel, {
        argv1: launcher,
        cwd: binDir,
      }),
    ).toBeNull();
  });

  it("falls back to cwd when the launcher path does not resolve to a repo", () => {
    const repo = mkRepo("ocsbx-missing-argv1-");

    const result = resolveSandboxScript(scriptRel, {
      argv1: "/nonexistent-ocsbx/bin/openclaw",
      cwd: repo,
    });

    expect(result?.scriptPath).toBe(path.join(repo, scriptRel));
    expect(result?.cwd).toBe(repo);
  });

  it("keeps searching cwd when the launcher resolves to a package root without the script", () => {
    // Installed/published openclaw package root: it carries the package.json marker but not
    // scripts/sandbox-setup.sh, because the npm files allowlist drops scripts/. It resolves from
    // argv1 before cwd, so stopping at the first root would miss the source checkout below.
    const installed = mkTmp("ocsbx-installed-");
    fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ name: "openclaw" }));
    const entry = path.join(installed, "openclaw.mjs");
    fs.writeFileSync(entry, "");

    // Valid source checkout (cwd) that does contain the script.
    const repo = mkRepo("ocsbx-source-");

    const result = resolveSandboxScript(scriptRel, { argv1: entry, cwd: repo });

    expect(result?.scriptPath).toBe(path.join(repo, scriptRel));
    expect(result?.cwd).toBe(repo);
  });
});
