import fs from "node:fs";
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

  it("uses the shipped package launcher for npm start", () => {
    expect(readPackageJson().scripts.start).toBe("node openclaw.mjs");
  });
});
