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
  const callsFile = path.join(root, "calls.argv");
  mkdirSync(binDir);
  writeFileSync(callsFile, "");
  writeFileSync(
    path.join(binDir, "npm"),
    `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in --*) shift ;; *) break ;; esac
done
printf '%s\\0' "$#" "$@" >> "$FIXTURE_CALLS"
[ "$#" -gt 0 ] || exit 74
case "$1" in
  install) exit ${fixtureStop} ;;
  view)
    for arg do
      if [ "$arg" = versions ]; then printf '%s' "$FIXTURE_VERSIONS"; exit 0; fi
    done
    printf '%s' "$FIXTURE_TARGET"
    ;;
  *) exit 74 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(binDir, "curl"),
    `#!/bin/sh
set -eu
printf '%s\\0' 1 installer >> "$FIXTURE_CALLS"
exit ${fixtureStop}
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
  const fields = readFileSync(callsFile, "utf8").split("\0").slice(0, -1);
  const calls: string[][] = [];
  while (fields.length > 0) {
    const count = Number(fields.shift());
    calls.push(fields.splice(0, count));
  }
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
