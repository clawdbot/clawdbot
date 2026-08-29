import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = createTempDirTracker();
const fixtureStop = 73;
afterEach(() => tempDirs.cleanup());

function runInstallerVersionSelection(
  runner: string,
  options: { target: string; versions: string[]; previous?: string; skipPrevious?: boolean },
) {
  const root = tempDirs.make("openclaw-install-previous-");
  const binDir = path.join(root, "bin");
  const callsFile = path.join(root, "calls.jsonl");
  mkdirSync(binDir);
  writeFileSync(callsFile, "");
  writeFileSync(
    path.join(binDir, "npm"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
while (args[0]?.startsWith("--")) args.shift();
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "install") process.exit(${fixtureStop});
if (args[0] !== "view") process.exit(74);
process.stdout.write(args.includes("versions") ? process.env.FIXTURE_VERSIONS : process.env.FIXTURE_TARGET);
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(binDir, "curl"),
    `#!/usr/bin/env node
require("node:fs").appendFileSync(process.env.FIXTURE_CALLS, '["installer"]\\n');
process.exit(${fixtureStop});
`,
    { mode: 0o755 },
  );
  writeFileSync(path.join(binDir, "timeout"), '#!/usr/bin/env bash\nshift 2\nexec "$@"\n', {
    mode: 0o755,
  });
  const result = spawnSync("bash", [`scripts/docker/install-sh-${runner}/run.sh`], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      HOME: root,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      NPM_CONFIG_PREFIX: path.join(root, "npm-global"),
      FIXTURE_CALLS: callsFile,
      FIXTURE_TARGET: options.target,
      FIXTURE_VERSIONS: JSON.stringify(options.versions),
      OPENAI_API_KEY: "fixture-api-key",
      OPENCLAW_E2E_MODELS: "openai",
      OPENCLAW_INSTALL_TAG: options.target,
      OPENCLAW_INSTALL_E2E_PREVIOUS: options.previous ?? "",
      OPENCLAW_INSTALL_SMOKE_PREVIOUS: options.previous ?? "",
      OPENCLAW_INSTALL_E2E_SKIP_PREVIOUS: options.skipPrevious ? "1" : "0",
      OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS: options.skipPrevious ? "1" : "0",
      OPENCLAW_INSTALL_SMOKE_HEARTBEAT_INTERVAL: "0",
    },
  });
  const calls = readFileSync(callsFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
  return { ...result, calls };
}

describe.each(["e2e", "smoke"])("%s installer upgrade baseline", (runner) => {
  it.each([
    { target: "2026.7.1-2", previous: "2026.7.1-1" },
    { target: "2026.7.1-beta.2", previous: "2026.7.1-beta.1" },
    { target: "2026.7.1", previous: "2026.7.1-beta.2" },
  ])(
    "preinstalls the predecessor of $target despite newer publications",
    ({ target, previous }) => {
      const result = runInstallerVersionSelection(runner, {
        target,
        versions: [
          "2026.7.1-1",
          "2026.7.1-2",
          "2026.7.1-beta.1",
          "2026.7.1-beta.2",
          "2026.7.1",
          "2026.8.1-beta.3",
          "2026.8.1-beta.4",
        ],
      });
      expect(result.status, result.stderr).toBe(fixtureStop);
      expect(result.calls).toContainEqual(["install", "-g", `openclaw@${previous}`]);
    },
  );

  it.each([
    { target: "2026.7.1", versions: ["2026.7.1", "2026.8.1"] },
    { target: "2026.7.2", versions: ["2026.7.1", "2026.8.1"] },
  ])("rejects a missing predecessor for $target before installing", (options) => {
    const result = runInstallerVersionSelection(runner, options);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("No published predecessor");
    expect(result.calls.every(([command]) => command === "view")).toBe(true);
  });

  it("preserves an explicit baseline without querying the version history", () => {
    const result = runInstallerVersionSelection(runner, {
      target: "2026.7.1",
      versions: [],
      previous: "2026.6.1",
    });
    expect(result.status, result.stderr).toBe(fixtureStop);
    expect(result.calls).toEqual([
      ["view", runner === "e2e" ? "openclaw@2026.7.1" : "openclaw", "version"],
      ["install", "-g", "openclaw@2026.6.1"],
    ]);
  });

  it("skips baseline lookup and preinstallation for a fresh install", () => {
    const result = runInstallerVersionSelection(runner, {
      target: "2026.7.1",
      versions: [],
      skipPrevious: true,
    });
    expect(result.status, result.stderr).toBe(fixtureStop);
    expect(result.calls).toEqual([
      ["view", runner === "e2e" ? "openclaw@2026.7.1" : "openclaw", "version"],
      ["installer"],
    ]);
  });
});
