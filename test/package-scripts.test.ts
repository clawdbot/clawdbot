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

  it("runs generated module formatting coverage in Windows CI", () => {
    expect(readPackageJson().scripts["test:windows:ci"]).toContain(
      "test/scripts/format-generated-module.test.ts",
    );
  });

  it("runs SQLite transcript archive durability coverage in Windows CI", () => {
    expect(readPackageJson().scripts["test:windows:ci"]).toContain(
      "src/config/sessions/store.session-lifecycle-mutation.test.ts",
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
});
