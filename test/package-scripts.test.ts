// Package script tests validate root package script invariants.
import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { detectChangedScope } from "../scripts/ci-changed-scope.mjs";

type RootPackageJson = {
  scripts: Record<string, string>;
};

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const NODE_OPTIONS_WITH_VALUE = new Set([
  "--conditions",
  "--env-file",
  "--env-file-if-exists",
  "--import",
  "--loader",
  "--max-old-space-size",
  "--require",
  "--test-name-pattern",
  "--test-reporter",
  "-C",
  "-r",
]);

function readPackageJson(): RootPackageJson {
  return JSON.parse(fs.readFileSync("package.json", "utf8")) as RootPackageJson;
}

function readWindowsCiPartScripts(): [string, string] {
  const scripts = readPackageJson().scripts;
  return [
    expectDefined(scripts["test:windows:ci:1"], "Windows CI part 1 script"),
    expectDefined(scripts["test:windows:ci:2"], "Windows CI part 2 script"),
  ];
}

function readWindowsCiCoverageScript(): string {
  return readWindowsCiPartScripts().join(" ");
}

function readWindowsCiTargets(script: string): string[] {
  const tokens = tokenizeCommand(script);
  const runnerIndex = tokens.indexOf("scripts/test-projects.mts");
  return runnerIndex < 0 ? [] : tokens.slice(runnerIndex + 1);
}

function tokenizeCommand(command: string): string[] {
  return (
    command
      .match(/"[^"]*"|'[^']*'|[^\s]+/gu)
      ?.map((token) => token.replace(/^(['"])(.*)\1$/u, "$2")) ?? []
  );
}

function extractNodeScriptTargets(script: string): string[] {
  return script.split(/\s*(?:&&|\|\||;)\s*/u).flatMap((command) => {
    const tokens = tokenizeCommand(command);
    let index = tokens[0] === "env" ? 1 : 0;

    while (ENV_ASSIGNMENT_RE.test(tokens[index] ?? "")) {
      index += 1;
    }

    if (tokens[index] !== "node") {
      return [];
    }

    for (let tokenIndex = index + 1; tokenIndex < tokens.length; tokenIndex += 1) {
      const token = tokens[tokenIndex];
      if (!token) {
        continue;
      }
      if (token.startsWith("scripts/")) {
        return [token];
      }
      if (token === "--") {
        continue;
      }
      if (token.startsWith("--") && token.includes("=")) {
        continue;
      }
      if (NODE_OPTIONS_WITH_VALUE.has(token)) {
        tokenIndex += 1;
        continue;
      }
      if (token.startsWith("-")) {
        continue;
      }

      return [];
    }

    return [];
  });
}

describe("package scripts", () => {
  it("finds node script targets after env assignments and valued node options", () => {
    expect(
      extractNodeScriptTargets(
        "FOO=1 node --import ./scripts/tsx.mjs scripts/release-check.ts && node --max-old-space-size=8192 --import ./scripts/tsx.mjs scripts/plugin-sdk-surface-report.mts && env BAR=1 node -r ./preload.cjs scripts/check.ts",
      ),
    ).toEqual([
      "scripts/release-check.ts",
      "scripts/plugin-sdk-surface-report.mts",
      "scripts/check.ts",
    ]);
  });

  it("keeps direct node script targets present in the source checkout", () => {
    const packageJson = readPackageJson();
    const missingTargets = Object.entries(packageJson.scripts).flatMap(([name, script]) =>
      extractNodeScriptTargets(script)
        .filter((target) => !fs.existsSync(target))
        .map((target) => `${name}: ${target}`),
    );

    expect(missingTargets).toEqual([]);
  });

  it("keeps direct Node package scripts off POSIX-only env assignment prefixes", () => {
    const packageJson = readPackageJson();
    const directNodeEnvScripts = Object.entries(packageJson.scripts).flatMap(([name, script]) =>
      script
        .split(/\s*(?:&&|\|\||;)\s*/u)
        .filter((command) => {
          const tokens = tokenizeCommand(command);
          let index = tokens[0] === "env" ? 1 : 0;
          const hasEnvPrefix = ENV_ASSIGNMENT_RE.test(tokens[index] ?? "");
          while (ENV_ASSIGNMENT_RE.test(tokens[index] ?? "")) {
            index += 1;
          }
          return hasEnvPrefix && tokens[index] === "node";
        })
        .map((command) => `${name}: ${command}`),
    );

    expect(directNodeEnvScripts).toEqual([]);
  });

  it.each([{ scriptName: "build:docker", expectedCount: 2 }])(
    "runs TypeScript steps in $scriptName through the tooling bootstrap",
    ({ scriptName, expectedCount }) => {
      const script = expectDefined(
        readPackageJson().scripts[scriptName],
        `package script ${scriptName}`,
      );

      expect(script).not.toContain("--experimental-strip-types");
      expect(
        script.match(/node --import \.\/scripts\/tsx\.mjs scripts\/[^\s]+\.ts(?=\s|$)/gu),
      ).toHaveLength(expectedCount);
    },
  );

  it("enables live cache validation in the package script", () => {
    expect(readPackageJson().scripts["test:live:cache"]).toBe(
      "node --import ./scripts/tsx.mjs scripts/run-with-env.mts OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CACHE_TEST=1 -- node --import ./scripts/tsx.mjs scripts/check-live-cache.ts",
    );
  });

  it("builds the native host before browser bootstrap E2E against real Chromium", () => {
    expect(readPackageJson().scripts["test:e2e:browser-extension"]).toBe(
      "pnpm build && node --import ./scripts/tsx.mjs scripts/run-with-env.mts PLAYWRIGHT_BROWSERS_PATH=.artifacts/playwright-browsers -- node --import ./scripts/tsx.mjs scripts/ensure-playwright-chromium.mts --require-playwright-chromium && node --import ./scripts/tsx.mjs scripts/run-with-env.mts PLAYWRIGHT_BROWSERS_PATH=.artifacts/playwright-browsers OPENCLAW_BROWSER_EXTENSION_E2E=1 OPENCLAW_E2E_WORKERS=1 -- node scripts/run-vitest.mjs extensions/browser/chrome-extension/bootstrap.chromium.test.ts",
    );
  });

  it("gives the plugin SDK usage scan enough heap for repository-wide analysis", () => {
    expect(readPackageJson().scripts["plugin-sdk:usage"]).toBe(
      "node --max-old-space-size=8192 --import ./scripts/tsx.mjs scripts/analyze-plugin-sdk-usage.ts",
    );
  });

  it("runs dead-code reports fail-fast", () => {
    expect(readPackageJson().scripts["deadcode:report"]).toBe(
      "pnpm deadcode:full && pnpm deadcode:exports",
    );
  });

  it("runs runtime postbuild before plugin SDK strict export checks", () => {
    expect(readPackageJson().scripts["build:plugin-sdk:strict-smoke"]).toBe(
      "node --import ./scripts/tsx.mjs scripts/tsdown-build.mts && node scripts/runtime-postbuild.mjs && node --import ./scripts/tsx.mjs scripts/check-plugin-sdk-exports.mts",
    );
  });

  it("builds generated plugin assets before Docker runtime postbuild", () => {
    const commands = expectDefined(
      readPackageJson().scripts["build:docker"],
      "package script build:docker",
    ).split(" && ");

    expect(commands.indexOf("pnpm plugins:assets:build")).toBeLessThan(
      commands.indexOf("node scripts/runtime-postbuild.mjs"),
    );
  });

  it("cleans package builds before validating release contents", () => {
    const scripts = readPackageJson().scripts;

    expect(scripts["build:package"]).toBe(
      "node --import ./scripts/tsx.mjs scripts/build-all.mts package",
    );
    expect(scripts["release:check"]).toBe(
      "pnpm build:package && pnpm release:generated:check && node --import ./scripts/tsx.mjs scripts/release-check.ts",
    );
  });

  it("uses the shipped package launcher for npm start", () => {
    expect(readPackageJson().scripts.start).toBe("node openclaw.mjs");
  });

  it("builds iOS against a generic simulator by default", () => {
    const script = readPackageJson().scripts["ios:build"];

    expect(script).toContain("${IOS_DEST:-generic/platform=iOS Simulator}");
    expect(script).not.toContain("name=iPhone");
  });

  it("keeps the Wear app in the root Android contributor gates", () => {
    const scripts = readPackageJson().scripts;

    expect(scripts["android:assemble"]).toContain(":wear:assembleDebug");
    expect(scripts["android:format"]).toContain(":wear:ktlintFormat");
    expect(scripts["android:lint"]).toContain(":wear:ktlintCheck");
    expect(scripts["android:lint:android"]).toContain(":wear:lintDebug");
    expect(scripts["android:test"]).toContain(":wear:testDebugUnitTest");
  });

  it("routes every declared Windows CI test to its native lane", () => {
    const missedTargets = readWindowsCiPartScripts()
      .flatMap(readWindowsCiTargets)
      .filter((target) => !detectChangedScope([target]).runWindows);
    expect(missedTargets).toEqual([]);
  });

  it("partitions Windows CI coverage into two disjoint explicit test lists", () => {
    const scripts = readPackageJson().scripts;
    const partScripts = readWindowsCiPartScripts();
    const partTargets = partScripts.map(readWindowsCiTargets);

    // Blacksmith's Windows class admits exactly 2 concurrent jobs, so the split
    // width is pinned here: a 3rd part queues and a single lane serializes.
    expect(scripts["test:windows:ci"]).toBe("pnpm test:windows:ci:1 && pnpm test:windows:ci:2");
    expect(scripts["test:windows:ci:3"]).toBeUndefined();
    for (const [partIndex, targets] of partTargets.entries()) {
      const laterTargets = new Set(partTargets.slice(partIndex + 1).flat());
      expect(
        targets.filter((target) => laterTargets.has(target)),
        `Windows CI part ${partIndex + 1} overlaps a later part`,
      ).toEqual([]);
    }
  });

  it("runs node workspace transfer coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain(
      "src/node-host/node-worker-transfer-client.test.ts",
    );
  });

  it("runs generated module formatting coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain("test/scripts/format-generated-module.test.ts");
  });

  it("runs direct-run entrypoint coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain("test/scripts/direct-run-entrypoints.test.ts");
  });

  it("runs compiled worker path, IPC, and cleanup coverage in Windows CI", () => {
    expect(readWindowsCiPartScripts().flatMap(readWindowsCiTargets)).toContain(
      "test/scripts/vitest-worker-artifacts.test.ts",
    );
  });

  it("runs Docker package process-tree coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain(
      "test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts",
    );
  });

  it("runs the Doctor managed-service SecretRef renderer in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain(
      "src/commands/doctor-gateway-auth-token.windows.test.ts",
    );
  });

  it("runs legacy session importer atomicity coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain(
      "src/infra/state-migrations.legacy-session-store.test.ts",
    );
  });

  it("runs SQLite snapshot path coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain("src/infra/sqlite-snapshot.test.ts");
  });

  it("runs shared-state ownership coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain("src/state/openclaw-state-ownership.test.ts");
  });

  it("runs mixed-case local media file URL coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain("src/media/local-media-path.windows.test.ts");
  });

  it("runs sandbox media staging file URL coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain(
      "src/auto-reply/reply.triggers.trigger-handling.stages-inbound-media-into-sandbox-workspace.test.ts",
    );
  });

  it("runs the native OpenSSH resolver proof in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain("src/infra/ssh-client.windows.test.ts");
  });

  it("runs native port diagnostics coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain("src/infra/ports.test.ts");
  });

  it("runs native LAN advertisement coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain(
      "src/infra/advertised-lan-host.windows.test.ts",
    );
  });

  it("keeps the native Scheduled Task lifecycle proof opt-in", () => {
    const scripts = readPackageJson().scripts;

    expect(readWindowsCiCoverageScript()).not.toContain("schtasks.integration.e2e.test.ts");
    expect(scripts["test:windows:schtasks:integration"]).toContain(
      "CI_WINDOWS_SCHTASKS_INTEGRATION=1",
    );
    expect(scripts["test:windows:schtasks:integration"]).toContain(
      "src/daemon/schtasks.integration.e2e.test.ts",
    );
  });

  it("runs shared test-state cleanup coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain("src/test-utils/openclaw-test-state.test.ts");
  });

  it("runs snapshot repository verification coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain(
      "src/snapshot/local-repository.windows.test.ts",
    );
  });

  it("runs backup verification coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain("src/commands/backup-verify.test.ts");
  });

  it("runs SQLite transcript archive worker coverage in Windows CI", () => {
    const windowsCi = readWindowsCiCoverageScript();
    expect(windowsCi).toContain(
      "src/config/sessions/session-accessor.sqlite-archive.worker.test.ts",
    );
  });

  it("runs cross-OS installer behavior coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain(
      "test/scripts/openclaw-cross-os-installer.windows.test.ts",
    );
    expect(
      readWindowsCiPartScripts()
        .flatMap(readWindowsCiTargets)
        .filter((target) => target === "test/scripts/install-ps1.test.ts"),
    ).toHaveLength(1);
  });

  it("runs env launcher coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain("test/scripts/run-with-env.test.ts");
  });

  it("runs ts-topology entrypoint coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain("test/scripts/ts-topology.test.ts");
  });

  it("runs Windows-only MXC backend coverage in Windows CI", () => {
    const script = readWindowsCiCoverageScript();

    expect(script).toContain("extensions/mxc/test/mxc-backend.test.ts");
    expect(script).toContain("extensions/mxc/test/sandbox-policy-loader.test.ts");
  });

  it("runs Windows-only exec script preflight coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain(
      "src/agents/bash-tools.exec.script-preflight.test.ts",
    );
  });

  it("runs Windows-only exec allowlist matching coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain("src/infra/exec-allowlist-pattern.test.ts");
  });

  it("runs native executable resolution coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain("src/infra/executable-path.test.ts");
  });

  it("runs node-host npm shim and PTY launcher coverage in Windows CI", () => {
    const script = readWindowsCiCoverageScript();

    expect(script).toContain("src/plugin-sdk/node-host.test.ts");
    expect(script).toContain("src/process/terminal-pty.test.ts");
    expect(script).toContain("src/tui/tui.resolve-codex-bin.test.ts");
  });

  it("runs Windows-only safe removal coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain("src/infra/fs-safe-remove.test.ts");
  });

  it("runs web and Teams file URL coverage in Windows CI", () => {
    const script = readWindowsCiCoverageScript();

    expect(script).toContain("src/agents/tools/media-tool-file-url.windows.test.ts");
    expect(script).toContain("src/media/web-media.file-url.windows.test.ts");
    expect(script).toContain("extensions/msteams/src/media-helpers.test.ts");
    expect(script).toContain("extensions/msteams/src/messenger.test.ts");
  });

  it("runs native usage footer home-path coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain(
      "src/auto-reply/usage-bar/template.windows.test.ts",
    );
  });

  it("runs native media-understanding file URL coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain(
      "src/media-understanding/attachments.file-url.windows.test.ts",
    );
  });

  it("runs shared home display and visible command coverage in Windows CI", () => {
    const script = readWindowsCiCoverageScript();

    expect(script).toContain("src/utils.test.ts");
    expect(script).toContain("src/commands/agents.commands.list.test.ts");
    expect(script).toContain("src/cli/daemon-cli/status.print.test.ts");
    expect(script).toContain("packages/terminal-core/src/display-string.test.ts");
    expect(script).toContain("src/agents/sandbox/fs-paths.test.ts");
    expect(script).toContain("src/agents/sessions/tools/render-utils.test.ts");
  });

  it("runs native OS-home path tool coverage in Windows CI", () => {
    const script = readWindowsCiCoverageScript();

    expect(script).toContain("src/agents/agent-tools.read.windows.test.ts");
    expect(script).toContain("src/agents/agent-tools.read.host-operations.test.ts");
    expect(script).toContain("src/agents/sessions/tools/path-utils.test.ts");
  });

  it("runs child environment and native doctor coverage in Windows CI", () => {
    const script = readWindowsCiCoverageScript();

    expect(script).toContain("src/agents/provider-local-service.env-case.test.ts");
    expect(script).toContain("src/infra/process-env.test.ts");
    expect(script).toContain("src/cli/mcp-cli.path-case.windows.test.ts");
  });

  it("runs explicit memory extra-file casing coverage in Windows CI", () => {
    expect(readWindowsCiCoverageScript()).toContain(
      "extensions/memory-core/src/memory-extra-file-path.windows.test.ts",
    );
  });
});
