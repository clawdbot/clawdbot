import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
// Platform contract: macOS tooling must not select Homebrew Bash through PATH.
const nativeScripts = [
  "scripts/lib/plistbuddy.sh",
  "scripts/e2e/parallels-linux-smoke.sh",
  "scripts/e2e/parallels-windows-smoke.sh",
  "scripts/e2e/parallels-npm-update-smoke.sh",
  "scripts/apple-release-source-check.sh",
  "scripts/build-and-run-mac.sh",
  "scripts/check-swift-tools.sh",
  "scripts/codesign-mac-app.sh",
  "scripts/create-dmg.sh",
  "scripts/dev/computer-use-macos-live-rig.sh",
  "scripts/dev/ios-pull-gateway-log.sh",
  "scripts/e2e/parallels-macos-smoke.sh",
  "scripts/e2e/parallels-windows-prepare.sh",
  "scripts/format-swift.sh",
  "scripts/generate-mac-app-icons.sh",
  "scripts/install-swift-tools.sh",
  "scripts/ios-app-store-connect-keychain-setup.sh",
  "scripts/ios-configure-signing.sh",
  "scripts/ios-release-archive.sh",
  "scripts/ios-release-cut.sh",
  "scripts/ios-release-plan.sh",
  "scripts/ios-release-prepare.sh",
  "scripts/ios-release-upload.sh",
  "scripts/ios-run.sh",
  "scripts/ios-screenshots.sh",
  "scripts/ios-team-id.sh",
  "scripts/ios-validate-app-store-ipa.sh",
  "scripts/ios-write-version-xcconfig.sh",
  "scripts/lib/ios-fastlane.sh",
  "scripts/lib/mac-app-bundle.sh",
  "scripts/lib/mac-swift-build.sh",
  "scripts/lib/restart-mac-gateway.sh",
  "scripts/lib/swift-toolchain.sh",
  "scripts/lint-swift.sh",
  "scripts/mac-elevation-host.sh",
  "scripts/make_appcast.sh",
  "scripts/notarize-mac-artifact.sh",
  "scripts/package-mac-app.sh",
  "scripts/package-mac-dist.sh",
  "scripts/restart-mac.sh",
  "scripts/stage-cloudflared-macos.sh",
  "scripts/stage-cua-driver-macos.sh",
  "scripts/stage-mac-node-worker.sh",
  "scripts/test-macos-health-render.sh",
];

// Includes host wrappers whose sourced Docker helpers use heredocs.
const portableScripts = [
  "scripts/android-release-upload.sh",
  "scripts/android-screenshots.sh",
  "scripts/changelog-to-html.sh",
  "scripts/ci-hydrate-live-auth.sh",
  "scripts/ci-hydrate-testbox-env.sh",
  "scripts/connect.sh",
  "scripts/docker/setup.sh",
  "scripts/docker/shared-image-artifact.sh",
  "scripts/docs-spellcheck.sh",
  "scripts/e2e/agent-bundle-mcp-tools-docker.sh",
  "scripts/e2e/agents-delete-shared-workspace-docker.sh",
  "scripts/e2e/browser-cdp-snapshot-docker.sh",
  "scripts/e2e/browser-plugin-profiles-docker.sh",
  "scripts/e2e/build-image.sh",
  "scripts/e2e/bun-global-install-smoke.sh",
  "scripts/e2e/bundled-plugin-install-uninstall-docker.sh",
  "scripts/e2e/cli-installer-distribution-docker.sh",
  "scripts/e2e/codex-media-path-docker.sh",
  "scripts/e2e/codex-npm-plugin-live-docker.sh",
  "scripts/e2e/codex-on-demand-docker.sh",
  "scripts/e2e/compose-setup.sh",
  "scripts/e2e/config-reload-source-docker.sh",
  "scripts/e2e/cron-cli-docker.sh",
  "scripts/e2e/cron-mcp-cleanup-docker.sh",
  "scripts/e2e/docker-package-install.sh",
  "scripts/e2e/docker-selected-plugins.sh",
  "scripts/e2e/doctor-install-switch-docker.sh",
  "scripts/e2e/gateway-concurrency-docker.sh",
  "scripts/e2e/gateway-network-docker.sh",
  "scripts/e2e/kitchen-sink-plugin-docker.sh",
  "scripts/e2e/kitchen-sink-rpc-docker.sh",
  "scripts/e2e/live-plugin-tool-docker.sh",
  "scripts/e2e/mcp-channels-docker.sh",
  "scripts/e2e/mcp-code-mode-gateway-docker.sh",
  "scripts/e2e/mcp-code-mode-gateway-live-docker.sh",
  "scripts/e2e/multi-node-update-docker.sh",
  "scripts/e2e/npm-onboard-channel-agent-docker.sh",
  "scripts/e2e/npm-telegram-live-docker.sh",
  "scripts/e2e/onboard-docker.sh",
  "scripts/e2e/openai-chat-tools-docker.sh",
  "scripts/e2e/openai-image-auth-docker.sh",
  "scripts/e2e/openai-web-search-minimal-docker.sh",
  "scripts/e2e/openwebui-docker.sh",
  "scripts/e2e/plugin-binding-command-escape-docker.sh",
  "scripts/e2e/plugin-lifecycle-matrix-docker.sh",
  "scripts/e2e/plugin-update-unchanged-docker.sh",
  "scripts/e2e/plugins-docker.sh",
  "scripts/e2e/qr-import-docker.sh",
  "scripts/e2e/release-media-memory-docker.sh",
  "scripts/e2e/release-plugin-marketplace-docker.sh",
  "scripts/e2e/release-typed-onboarding-docker.sh",
  "scripts/e2e/release-upgrade-user-journey-docker.sh",
  "scripts/e2e/release-user-journey-docker.sh",
  "scripts/e2e/sandbox-browser-sidecar-docker.sh",
  "scripts/e2e/session-runtime-context-docker.sh",
  "scripts/e2e/skill-install-docker.sh",
  "scripts/e2e/status-corrupt-plugin-deps.sh",
  "scripts/e2e/system-agent-first-run-docker.sh",
  "scripts/e2e/system-agent-rescue-docker.sh",
  "scripts/e2e/systemd-sealed-service-definition.sh",
  "scripts/e2e/update-channel-switch-docker.sh",
  "scripts/e2e/update-corrupt-plugin-docker.sh",
  "scripts/e2e/update-first-hop-compat-docker.sh",
  "scripts/e2e/update-run-package-self-upgrade-docker.sh",
  "scripts/e2e/upgrade-survivor-docker.sh",
  "scripts/github/find-reusable-release-validation.sh",
  "scripts/github/resolve-openclaw-ref.sh",
  "scripts/github/resolve-release-check-artifacts.sh",
  "scripts/k8s/create-kind.sh",
  "scripts/k8s/deploy.sh",
  "scripts/plugin-clawhub-publish.sh",
  "scripts/plugin-npm-publish.sh",
  "scripts/podman/setup.sh",
  "scripts/pr",
  "scripts/release-telegram-provenance.sh",
  "scripts/run-openclaw-podman.sh",
  "scripts/run-opengrep.sh",
  "scripts/sandbox-browser-setup.sh",
  "scripts/sandbox-common-setup.sh",
  "scripts/sandbox-setup.sh",
  "scripts/test-cleanup-docker.sh",
  "scripts/test-install-sh-docker.sh",
  "scripts/test-install-sh-e2e-docker.sh",
  "scripts/test-live-acp-bind-docker.sh",
  "scripts/test-live-build-docker.sh",
  "scripts/test-live-cli-backend-docker.sh",
  "scripts/test-live-codex-harness-docker.sh",
  "scripts/test-live-gateway-models-docker.sh",
  "scripts/test-live-models-docker.sh",
  "scripts/test-live-subagent-announce-docker.sh",
  "scripts/update-gateway.sh",
];

const guard =
  '# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.\nif [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then\n  exec /bin/bash "$0" "$@"\nfi\n';

// bash -n accepts unknown builtins and expansions that only fail at runtime.
// This deliberately conservative scan includes embedded shell payloads, ignores
// full-line comments, and is not a shell parser. Keep compatibility exceptions
// empty; a future exception must name its file and explain its interpreter boundary.
const bash4Patterns: [string, RegExp][] = [
  ["modern builtin", /\b(?:mapfile|readarray|coproc)\b/u],
  [
    "associative array, nameref, or case attribute",
    /(?<![\w-])(?:declare|typeset|local|readonly)\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[Anlu]/u,
  ],
  ["case conversion", /\$\{[a-zA-Z_][\w]*(?:\[[^\]]*\])?[,^]/u],
  ["negative array index", /\$\{[^}\n]*\[\s*-\s*\d/u],
  ["name enumeration", /\$\{![a-zA-Z_]\w*[@*]\}/u],
  ["parameter transformation", /\$\{[^}\n]*@[a-zA-Z]\}/u],
  ["modern redirection or case fallthrough", /\|&|&>>|;;&|;&/u],
  ["array printf destination", /\bprintf\s+-v\s+["']?[^\s"']*\[/u],
  ["variable existence conditional", /(?:\[\[|&&|\|\|)\s*(?:!\s*)?(?:\(\s*)?-v\s/u],
  ["modern wait option", /\bwait\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[npf]\b/u],
  ["allocated file descriptor", /(?<![$\w])\{[a-zA-Z_]\w*\}\s*[<>]/u],
  ["fixed-length read", /\bread\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*N/u],
  [
    "modern shell option",
    /\bshopt\s+[^\n]*\b(?:globstar|lastpipe|inherit_errexit|assoc_expand_once|localvar_inherit|localvar_unset)\b/u,
  ],
];

function bash4Findings(source: string): string[] {
  return source.split("\n").flatMap((line, index) => {
    if (line.trimStart().startsWith("#")) {
      return [];
    }
    return bash4Patterns
      .filter(([, pattern]) => pattern.test(line))
      .map(([name]) => `${index + 1}: ${name}: ${line.trim()}`);
  });
}

function bash32Sources(): Map<string, string> {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter(
      (file) =>
        file &&
        (!path.extname(file) || file.endsWith(".sh")) &&
        existsSync(file) &&
        statSync(file).isFile(),
    );
  const shells = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
  const selected = new Map(
    [...shells].filter(
      ([file, source]) =>
        source.startsWith("#!/bin/bash\n") ||
        /exec \/bin\/bash/u.test(source) ||
        // Include whole helper directories: some callers select a helper via a
        // variable, and Docker payloads source scripts inside their container.
        /^scripts\/(?:lib|pr-lib|e2e\/lib|docker\/install-sh-common)\/.*\.sh$/u.test(file),
    ),
  );
  for (const source of selected.values()) {
    // Match literal source basenames regardless of ROOT_DIR/SCRIPT_DIR spelling.
    // Include all matches when a basename is shared, then visit their sources too.
    // Operator profiles and generated env files are not repository libraries.
    for (const match of source.matchAll(
      /(?:^|[;\s])(?:source|\.)\s+["']?[^\s"']*?([\w.-]+\.sh)(?=["'\s;]|$)/gmu,
    )) {
      for (const [file, contents] of shells) {
        if (path.posix.basename(file) === match[1]) {
          selected.set(file, contents);
        }
      }
    }
  }
  return selected;
}

describe("macOS Bash selection", () => {
  it("keeps system-Bash entrypoints and their sourced libraries compatible with Bash 3.2", () => {
    const findings = [...bash32Sources()].flatMap(([file, source]) =>
      bash4Findings(source).map((finding) => `${file}:${finding}`),
    );
    expect(findings).toEqual([]);
  });

  it.each([
    'mapfile -t fields <<<"$metadata"',
    "readarray fields",
    "coproc worker",
    "declare -A values",
    "local -rA values",
    "declare -n ref=value",
    "${value,,}",
    "${value^}",
    "${values[-1]}",
    "${!prefix@}",
    "${value@Q}",
    "cmd |& reader",
    "cmd &>>log",
    "case x in x) cmd ;;& esac",
    "case x in x) cmd ;& esac",
    'printf -v "values[0]" %s x',
    "[[ -v value ]]",
    "wait -n",
    "exec {fd}<file",
    "read -N 3 value",
    "shopt -s globstar",
  ])("rejects runtime-incompatible syntax: %s", (source) => {
    expect(bash4Findings(source).length).toBeGreaterThan(0);
  });

  it("allows Bash 3.2 array reads, scalar printf, negative substrings, and explanatory comments", () => {
    expect(
      bash4Findings("read -a fields\nprintf -v value %s x\n${value: -1}\n# avoid mapfile"),
    ).toEqual([]);
  });

  it("keeps package commands from overriding native script shebangs through PATH", () => {
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const [name, command] of Object.entries(scripts)) {
      if (/^(ios:|mac:|test:parallels:)/u.test(name)) {
        expect(command, name).not.toMatch(/(^|[;&|]\s*)bash\s/u);
      }
    }
  });

  it.each(nativeScripts)("pins %s to the system Bash", (filename) => {
    expect(readFileSync(filename, "utf8").split("\n")[0]).toBe("#!/bin/bash");
  });

  it.each(portableScripts)("guards %s before any heredoc can run", (filename) => {
    const source = readFileSync(filename, "utf8");
    expect(source.slice(source.indexOf("\n") + 1).startsWith(guard)).toBe(true);
  });

  it.skipIf(process.platform !== "darwin")(
    "reexecs modern Bash with arguments intact and preserves system Bash",
    () => {
      const root = tempDirs.make("openclaw-bash-guard-");
      const script = path.join(root, "script with [glob] spaces.sh");
      writeFileSync(script, `#!/usr/bin/env bash\n${guard}printf '%s\n' "$BASH" "$@"\n`);
      for (const shell of ["/bin/bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash"].filter(
        existsSync,
      )) {
        const version = spawnSync(shell, ["-c", "printf '%s' \"$BASH_VERSION\""], {
          encoding: "utf8",
        });
        const [major = 0, minor = 0] = version.stdout.split(".").map(Number);
        if (shell !== "/bin/bash" && !(major > 5 || (major === 5 && minor >= 3))) {
          continue;
        }
        const result = spawnSync(shell, [script, "argument with spaces", "", "*[literal]"], {
          encoding: "utf8",
          timeout: 5000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("/bin/bash\nargument with spaces\n\n*[literal]\n");
      }
    },
  );

  it.skipIf(process.platform !== "darwin").each(["install.sh", "install-cli.sh"])(
    "handles file, sourced, and stdin execution of %s without replaying consumed input",
    (filename) => {
      const root = tempDirs.make("openclaw-installer-bash-guard-");
      const script = path.join(root, filename);
      const source = readFileSync(path.join("scripts", filename), "utf8");
      const prelude = source.slice(0, source.indexOf("set -euo pipefail"));
      expect(prelude).toContain('exec /bin/bash "$0" "$@"');
      const probe = `${prelude}printf '%s\n' "$BASH" "$@"\n`;
      writeFileSync(script, probe);
      for (const shell of ["/opt/homebrew/bin/bash", "/usr/local/bin/bash"].filter(existsSync)) {
        const version = spawnSync(shell, ["-c", "printf '%s' \"$BASH_VERSION\""], {
          encoding: "utf8",
        });
        const [major = 0, minor = 0] = version.stdout.split(".").map(Number);
        if (!(major > 5 || (major === 5 && minor >= 3))) {
          continue;
        }
        const direct = spawnSync(shell, [script, "kept argument"], {
          encoding: "utf8",
          timeout: 5000,
        });
        expect(direct.status, direct.stderr).toBe(0);
        expect(direct.stdout).toBe("/bin/bash\nkept argument\n");
        for (const args of [["-s"], ["-c", 'source "$1"', "installer-source", script]]) {
          const result = spawnSync(shell, args, { input: probe, encoding: "utf8", timeout: 5000 });
          expect(result.status).toBe(1);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain("Run this installer with /bin/bash on macOS");
        }
      }
    },
  );
});
