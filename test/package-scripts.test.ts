// Package script tests validate root package script invariants.
import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";

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
        "FOO=1 node --import tsx scripts/release-check.ts && node --max-old-space-size=8192 scripts/plugin-sdk-surface-report.mjs && env BAR=1 node -r tsx scripts/check.ts",
      ),
    ).toEqual([
      "scripts/release-check.ts",
      "scripts/plugin-sdk-surface-report.mjs",
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

  it.each([
    { scriptName: "build:docker", expectedCount: 4 },
    { scriptName: "build:plugin-sdk:strict-smoke", expectedCount: 1 },
    { scriptName: "build:strict-smoke", expectedCount: 1 },
  ])("runs TypeScript steps in $scriptName through tsx", ({ scriptName, expectedCount }) => {
    const script = expectDefined(
      readPackageJson().scripts[scriptName],
      `package script ${scriptName}`,
    );

    expect(script).not.toContain("--experimental-strip-types");
    expect(script.match(/node --import tsx scripts\/[^\s]+\.ts/gu)).toHaveLength(expectedCount);
  });

  it("enables live cache validation in the package script", () => {
    expect(readPackageJson().scripts["test:live:cache"]).toBe(
      "node scripts/run-with-env.mjs OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CACHE_TEST=1 -- node --import tsx scripts/check-live-cache.ts",
    );
  });

  it("runs browser copilot E2E against real Chromium", () => {
    expect(readPackageJson().scripts["test:e2e:browser-copilot"]).toBe(
      "node scripts/run-with-env.mjs PLAYWRIGHT_BROWSERS_PATH=.artifacts/playwright-browsers -- node scripts/ensure-playwright-chromium.mjs --require-playwright-chromium && node scripts/run-with-env.mjs PLAYWRIGHT_BROWSERS_PATH=.artifacts/playwright-browsers OPENCLAW_BROWSER_COPILOT_E2E=1 OPENCLAW_E2E_WORKERS=1 -- node scripts/run-vitest.mjs run --config test/vitest/vitest.e2e.config.ts extensions/browser/chrome-extension/page-share.e2e.test.ts extensions/browser/chrome-extension/sidepanel.e2e.test.ts",
    );
  });

  it("gives the plugin SDK usage scan enough heap for repository-wide analysis", () => {
    expect(readPackageJson().scripts["plugin-sdk:usage"]).toBe(
      "node --max-old-space-size=8192 --import tsx scripts/analyze-plugin-sdk-usage.ts",
    );
  });

  it("runs runtime postbuild before plugin SDK strict export checks", () => {
    expect(readPackageJson().scripts["build:plugin-sdk:strict-smoke"]).toBe(
      "node scripts/tsdown-build.mjs && node scripts/runtime-postbuild.mjs && node scripts/run-with-env.mjs OPENCLAW_PLUGIN_SDK_CANONICAL_DTS=1 -- node --import tsx scripts/write-plugin-sdk-entry-dts.ts && node scripts/check-plugin-sdk-exports.mjs",
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

  it("runs generated module formatting coverage in Windows CI", () => {
    expect(readPackageJson().scripts["test:windows:ci"]).toContain(
      "test/scripts/format-generated-module.test.ts",
    );
  });

  it("runs Docker package process-tree coverage in Windows CI", () => {
    expect(readPackageJson().scripts["test:windows:ci"]).toContain(
      "test/e2e/qa-lab/runtime/package-openclaw-for-docker.e2e.test.ts",
    );
  });

  it("runs legacy session importer atomicity coverage in Windows CI", () => {
    expect(readPackageJson().scripts["test:windows:ci"]).toContain(
      "src/infra/state-migrations.legacy-session-store.test.ts",
    );
  });

  it("runs SQLite snapshot path coverage in Windows CI", () => {
    expect(readPackageJson().scripts["test:windows:ci"]).toContain(
      "src/infra/sqlite-snapshot.test.ts",
    );
  });

  it("runs the native OpenSSH resolver proof in Windows CI", () => {
    expect(readPackageJson().scripts["test:windows:ci"]).toContain(
      "src/infra/ssh-client.windows.test.ts",
    );
  });

  it("runs shared test-state cleanup coverage in Windows CI", () => {
    expect(readPackageJson().scripts["test:windows:ci"]).toContain(
      "src/test-utils/openclaw-test-state.test.ts",
    );
  });

  it("runs snapshot repository verification coverage in Windows CI", () => {
    expect(readPackageJson().scripts["test:windows:ci"]).toContain(
      "src/snapshot/local-repository.windows.test.ts",
    );
  });

  it("runs backup verification coverage in Windows CI", () => {
    expect(readPackageJson().scripts["test:windows:ci"]).toContain(
      "src/commands/backup-verify.test.ts",
    );
  });

  it("runs cross-OS installer behavior coverage in Windows CI", () => {
    expect(readPackageJson().scripts["test:windows:ci"]).toContain(
      "test/scripts/openclaw-cross-os-installer.windows.test.ts",
    );
  });

  it("runs env launcher coverage in Windows CI", () => {
    expect(readPackageJson().scripts["test:windows:ci"]).toContain(
      "test/scripts/run-with-env.test.ts",
    );
  });

  it("runs ts-topology entrypoint coverage in Windows CI", () => {
    expect(readPackageJson().scripts["test:windows:ci"]).toContain(
      "test/scripts/ts-topology.test.ts",
    );
  });

  it("runs Windows-only MXC backend coverage in Windows CI", () => {
    const script = readPackageJson().scripts["test:windows:ci"];

    expect(script).toContain("extensions/mxc/test/mxc-backend.test.ts");
    expect(script).toContain("extensions/mxc/test/sandbox-policy-loader.test.ts");
  });

  it("runs Windows-only exec script preflight coverage in Windows CI", () => {
    expect(readPackageJson().scripts["test:windows:ci"]).toContain(
      "src/agents/bash-tools.exec.script-preflight.test.ts",
    );
  });

  it("runs Windows-only exec allowlist matching coverage in Windows CI", () => {
    expect(readPackageJson().scripts["test:windows:ci"]).toContain(
      "src/infra/exec-allowlist-pattern.test.ts",
    );
  });
});
