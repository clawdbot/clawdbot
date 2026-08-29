import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { linkPnpmBootstrapShellTools } from "./test-helpers.js";

describe("source-server updater bootstrap", () => {
  it.each(
    [
      "success",
      "missing",
      "enable-failure",
      "install-failure",
      "build-failure",
      "dirty",
      "symlink",
      "rebase-failure",
      "interrupted",
      "probe-failure",
      "wrong-version",
      "missing-pin",
      "invalid-pin",
      "invalid-json",
      "missing-manifest",
      "hash-pin",
      "local-pin",
    ].flatMap((scenario) =>
      (scenario === "rebase-failure" || scenario === "local-pin"
        ? ["server"]
        : ["main", "server"]
      ).map((branch) => ({ scenario, branch })),
    ),
  )("keeps checkout and restart boundaries for $scenario on $branch", ({ scenario, branch }) => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-server-bootstrap-"));
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const temp = join(root, "temp");
    for (const dir of [join(repo, "scripts"), join(repo, ".git"), bin, temp])
      mkdirSync(dir, { recursive: true });
    linkPnpmBootstrapShellTools(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    const script = join(repo, "scripts/update-gateway.sh");
    writeFileSync(script, readFileSync("scripts/update-gateway.sh"));
    const originalManifest = '{"packageManager":"pnpm@11.15.1"}';
    const originalHead = "b".repeat(40);
    const targetSha = "a".repeat(40);
    const targetPin = `pnpm@12.0.0${scenario === "hash-pin" ? `+sha512.${"c".repeat(128)}` : ""}`;
    writeFileSync(join(repo, "package.json"), originalManifest);
    writeFileSync(join(repo, ".git/HEAD"), originalHead);
    writeFileSync(join(root, "remote-head"), targetSha);
    writeFileSync(
      join(root, "fetched-package.json"),
      scenario === "invalid-json"
        ? "{"
        : JSON.stringify({
            packageManager:
              scenario === "missing-pin"
                ? undefined
                : scenario === "invalid-pin"
                  ? "pnpm@latest"
                  : targetPin,
            scripts: { preinstall: "must-not-run" },
            dependencies: { "must-not-install": "1.0.0" },
          }),
    );
    writeFileSync(join(repo, "pnpm-lock.yaml"), "untouched\n");
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages: []\n");
    const executable = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    executable(
      "git",
      `
      echo "$*" >> "$FIXTURE/git-calls"
      case "$*" in
        'rev-parse --git-dir') echo .git ;;
        'diff --quiet') [[ "$SCENARIO" != dirty ]] ;;
        'diff --cached --quiet'|'ls-files --others --exclude-standard') exit 0 ;;
        'status --short') echo ' M package.json' ;;
        'rev-parse --abbrev-ref HEAD') echo "$TEST_BRANCH" ;;
        'rev-parse --verify FETCH_HEAD^{commit}') echo "$TARGET_SHA" ;;
        show*)
          [[ "$2" == "$TARGET_SHA:package.json" ]]
          [[ "$SCENARIO" != missing-manifest ]] || exit 1
          printf '%s\\n' "$(<"$FIXTURE/fetched-package.json")"
          ;;
        'rev-parse --short HEAD') echo abc123 ;;
        *)
          echo "$*" >> "$FIXTURE/git-mutations"
          [[ "$SCENARIO" != rebase-failure || "$1" != rebase || "$2" == --abort ]] || exit 1
          if [[ "$1" == merge || ( "$1" == rebase && "$2" != --abort ) ]]; then
            if [[ "$SCENARIO" == local-pin ]]; then
              echo '{"packageManager":"pnpm@11.15.1"}' > package.json
            else
              cp "$FIXTURE/fetched-package.json" package.json
            fi
            mutation_target="\${!#}"
            if [[ "$mutation_target" == origin/main ]]; then mutation_target="$(<"$FIXTURE/remote-head")"; fi
            printf '%s' "$mutation_target" > .git/HEAD
          fi
          ;;
      esac
    `,
    );
    executable("pnpm", 'echo ambient >> "$FIXTURE/steps"; exit 93');
    executable(
      "selected",
      `
      [[ "\${COREPACK_ENABLE_DOWNLOAD_PROMPT:-}" == 0 ]] || { echo "Corepack would await terminal input" >&2; exit 91; }
      [[ -z "\${CI:-}" ]]
      [[ "$NPM_CONFIG_WORKSPACE_DIR" == "$PWD" && "$npm_config_workspace_dir" == "$PWD" ]]
      [[ "$PNPM_CONFIG_LOCKFILE_DIR" == "$PWD" && "$pnpm_config_lockfile_dir" == "$PWD" ]]
      if [[ "$1" == --version ]]; then
        [[ "$PWD" == "$TMPDIR/"* && "$PWD" != "$TARGET" ]]
        node - <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.deepEqual(JSON.parse(fs.readFileSync('package.json', 'utf8')), { private: true, packageManager: process.env.TARGET_PIN });
assert.equal(fs.readFileSync('pnpm-workspace.yaml', 'utf8').trim(), 'packages: []');
assert.deepEqual(fs.readdirSync('.').sort(), ['package.json', 'pnpm-workspace.yaml']);
assert.equal(fs.readFileSync(process.env.TARGET + '/.git/HEAD', 'utf8'), 'b'.repeat(40));
NODE
        echo probe >> "$FIXTURE/steps"
        # A later remote-ref move must not change the probed commit's mutation target.
        echo cccccccccccccccccccccccccccccccccccccccc > "$FIXTURE/remote-head"
        [[ "$SCENARIO" != probe-failure ]] || exit 42
        if [[ "$SCENARIO" == wrong-version ]]; then echo 0.0.0; else echo 12.0.0; fi
        exit 0
      fi
      [[ "$PWD" == "$TARGET" ]]
      [[ "$SCENARIO" != probe-failure ]] || exit 42
      node - <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const expected = process.env.SCENARIO === 'local-pin' ? 'pnpm@11.15.1' : process.env.TARGET_PIN;
assert.equal(JSON.parse(fs.readFileSync('package.json', 'utf8')).packageManager, expected);
NODE
      case "$1" in
        install) [[ "$2" == --frozen-lockfile ]]; echo install >> "$FIXTURE/steps"; [[ "$SCENARIO" != install-failure ]] || exit 42 ;;
        build) echo build >> "$FIXTURE/steps"; pnpm nested ;;
        nested) [[ "$SCENARIO" != build-failure ]] || exit 42; echo nested >> "$FIXTURE/steps" ;;
        *) exit 94 ;;
      esac
    `,
    );
    if (scenario !== "missing")
      executable(
        "corepack",
        `
      [[ "$1 $2" == 'enable --install-directory' && "$4" == pnpm ]]
      [[ "$3" == "$FIXTURE/"* ]]
      [[ "$SCENARIO" != enable-failure ]] || exit 1
      cp "$FIXTURE/bin/selected" "$3/pnpm"
    `,
      );
    if (scenario === "symlink") symlinkSync(root, join(repo, "dist"));
    if (scenario === "interrupted") mkdirSync(join(repo, ".git/rebase-merge"));
    try {
      const result = spawnSync("/bin/bash", [script], {
        encoding: "utf8",
        env: {
          PATH: bin,
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "1",
          HOME: root,
          TMPDIR: temp,
          FIXTURE: root,
          TARGET: repo,
          SCENARIO: scenario,
          TEST_BRANCH: branch,
          TARGET_SHA: targetSha,
          TARGET_PIN: targetPin,
          NPM_CONFIG_WORKSPACE_DIR: root,
          npm_config_workspace_dir: root,
          PNPM_CONFIG_LOCKFILE_DIR: root,
          pnpm_config_lockfile_dir: root,
          OPENCLAW_UPDATE_RESTART_CMD:
            '[[ "$COREPACK_ENABLE_DOWNLOAD_PROMPT" == 1 && "$PATH" == "$FIXTURE/bin" && "$NPM_CONFIG_WORKSPACE_DIR" == "$FIXTURE" && "$npm_config_workspace_dir" == "$FIXTURE" && "$PNPM_CONFIG_LOCKFILE_DIR" == "$FIXTURE" && "$pnpm_config_lockfile_dir" == "$FIXTURE" ]] && echo restart >> "$FIXTURE/steps"',
        },
      });
      const preflightFailure = [
        "probe-failure",
        "wrong-version",
        "missing-pin",
        "invalid-pin",
        "invalid-json",
        "missing-manifest",
      ].includes(scenario);
      const lines = (name: string) =>
        existsSync(join(root, name))
          ? readFileSync(join(root, name), "utf8").trim().split("\n")
          : [];
      if (preflightFailure) {
        expect(
          readFileSync(join(repo, ".git/HEAD"), "utf8"),
          "failed target preflight advanced HEAD",
        ).toBe(originalHead);
        expect(readFileSync(join(repo, "package.json"), "utf8")).toBe(originalManifest);
        expect(lines("git-mutations")).toEqual(["fetch origin main"]);
        expect(lines("git-calls")).toContain(`show ${targetSha}:package.json`);
        expect(result.stdout + result.stderr).toContain("no checkout update or restart");
      }
      const succeeded = ["success", "hash-pin", "local-pin"].includes(scenario);
      expect(result.status, result.stdout + result.stderr).toBe(
        succeeded
          ? 0
          : scenario.endsWith("-failure") && ["install-failure", "build-failure"].includes(scenario)
            ? 42
            : 1,
      );
      const steps = lines("steps");
      const beforeFetch = ["missing", "enable-failure", "dirty", "interrupted"].includes(scenario);
      const beforeProbe =
        beforeFetch ||
        ["missing-pin", "invalid-pin", "invalid-json", "missing-manifest"].includes(scenario);
      expect(steps).toEqual(
        beforeProbe
          ? []
          : succeeded
            ? ["probe", "install", "build", "nested", "restart"]
            : scenario === "build-failure"
              ? ["probe", "install", "build"]
              : ["install-failure", "symlink"].includes(scenario)
                ? ["probe", "install"]
                : ["probe"],
      );
      if (beforeFetch) expect(existsSync(join(root, "git-mutations"))).toBe(false);
      else if (!preflightFailure) {
        expect(lines("git-calls")).toContain(`show ${targetSha}:package.json`);
        expect(lines("git-mutations")).toEqual([
          "fetch origin main",
          branch === "main"
            ? `merge --ff-only ${targetSha}`
            : `rebase --rebase-merges ${targetSha}`,
          ...(scenario === "rebase-failure" ? ["rebase --abort"] : []),
        ]);
        if (scenario !== "rebase-failure")
          expect(readFileSync(join(repo, ".git/HEAD"), "utf8")).toBe(targetSha);
      }
      if (scenario === "missing" || scenario === "enable-failure")
        expect(result.stdout + result.stderr).toContain("Corepack");
      if (scenario === "rebase-failure")
        expect(readFileSync(join(root, "git-mutations"), "utf8")).toContain("rebase --abort");
      expect(readFileSync(join(repo, "pnpm-lock.yaml"), "utf8")).toBe("untouched\n");
      expect(readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8")).toBe("packages: []\n");
      expect(readdirSync(temp)).toEqual([]);
      expect(result.stdout.includes("OK abc123")).toBe(succeeded);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
