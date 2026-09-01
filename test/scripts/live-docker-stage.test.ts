// Live Docker Stage tests cover live docker stage script behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { addStagedPrivatePluginSdkExports } from "../../scripts/live-docker-stage-private-sdk-exports.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stageScriptPath = path.join(repoRoot, "scripts/lib/live-docker-stage.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("live Docker state staging", () => {
  it.each([
    { geminiKey: "test-gemini-key", googleKey: "", expectedType: "gemini-api-key" },
    { geminiKey: "", googleKey: "test-google-key", expectedType: "vertex-ai" },
    { geminiKey: "", googleKey: "", expectedType: "oauth-personal" },
  ])("selects $expectedType from the supplied Gemini credentials", (testCase) => {
    const home = tempDirs.make("openclaw-live-stage-gemini-");
    const settingsPath = path.join(home, ".gemini", "settings.json");
    mkdirSync(path.dirname(settingsPath));
    writeFileSync(
      settingsPath,
      JSON.stringify({
        security: { auth: { selectedType: "oauth-personal" } },
        privacy: { usageStatisticsEnabled: false },
      }),
    );

    const result = spawnSync(
      "bash",
      ["-c", 'source "$1"; openclaw_live_stage_gemini_auth', "bash", stageScriptPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          GEMINI_API_KEY: testCase.geminiKey,
          GOOGLE_API_KEY: testCase.googleKey,
          GOOGLE_GENAI_USE_VERTEXAI: "",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.security.auth.selectedType).toBe(testCase.expectedType);
    expect(settings.security.auth.enforcedType).toBe(
      testCase.geminiKey || testCase.googleKey ? testCase.expectedType : undefined,
    );
    expect(settings.privacy).toEqual({ usageStatisticsEnabled: false });
    expect(readFileSync(settingsPath, "utf8")).not.toContain("test-gemini-key");
    expect(readFileSync(settingsPath, "utf8")).not.toContain("test-google-key");
  });

  it("installs missing CLI executables and refreshes pinned packages", () => {
    const root = tempDirs.make("openclaw-live-stage-cli-");
    const binDir = path.join(root, "bin");
    mkdirSync(binDir);
    const npmPath = path.join(binDir, "npm");
    writeFileSync(
      npmPath,
      '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$3" >> "$INSTALL_LOG"\nprintf "#!/usr/bin/env bash\\nprintf fixture-ok" > "$CLI_PATH"\nchmod +x "$CLI_PATH"\n',
    );
    chmodSync(npmPath, 0o755);
    const installLog = path.join(root, "installs.log");
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; openclaw_live_prepare_cli_backend "$CLI_PATH" @fixture/backend 10; "$CLI_PATH"; openclaw_live_prepare_cli_backend "$CLI_PATH" @fixture/backend 10; openclaw_live_prepare_cli_backend "$CLI_PATH" @fixture/backend@1.0.0 10',
        "test",
        stageScriptPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH}`,
          CLI_PATH: path.join(binDir, "fixture"),
          INSTALL_LOG: installLog,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("fixture-ok");
    expect(readFileSync(installLog, "utf8").trim().split("\n")).toEqual([
      "@fixture/backend",
      "@fixture/backend@1.0.0",
    ]);
  });

  it("fails explicitly when a selected backend has no executable or install package", () => {
    const root = tempDirs.make("openclaw-live-stage-cli-missing-");
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; source "$1"; openclaw_live_prepare_cli_backend "$2" "" 10',
        "test",
        stageScriptPath,
        path.join(root, "missing-cli"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("CLI backend executable was not provisioned:");
  });

  it.each([
    {
      entrypoint: "scripts/test-live.mts",
      expected: "--import tsx scripts/test-live.mts -- target",
    },
    { entrypoint: "scripts/test-live.mjs", expected: "scripts/test-live.mjs -- target" },
  ])("runs the staged $entrypoint live runner", ({ entrypoint, expected }) => {
    const root = tempDirs.make("openclaw-live-stage-entrypoint-");
    const binDir = path.join(root, "bin");
    const callsPath = path.join(root, "calls");
    mkdirSync(path.join(root, path.dirname(entrypoint)), { recursive: true });
    mkdirSync(binDir);
    writeFileSync(path.join(root, entrypoint), "");
    writeFileSync(
      path.join(binDir, "node"),
      '#!/usr/bin/env bash\nset -eu\nprintf "%s\\n" "$*" > "$CALLS_PATH"\n',
      { mode: 0o755 },
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -euo pipefail; cd "$1"; source "$2"; openclaw_live_run_staged_script scripts/test-live -- target',
        "test",
        root,
        stageScriptPath,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CALLS_PATH: callsPath },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(callsPath, "utf8").trim()).toBe(expected);
  });

  it("refuses to replace a missing staged live runner", () => {
    const root = tempDirs.make("openclaw-live-stage-entrypoint-missing-");
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set +e; cd "$1"; source "$2"; openclaw_live_run_staged_script scripts/test-live -- target',
        "test",
        root,
        stageScriptPath,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("staged OpenClaw script entrypoint not found");
  });

  it("keeps repo-local generated artifacts out of the source copy", () => {
    const script = readFileSync(stageScriptPath, "utf8");

    expect(script).toContain("--exclude=.artifacts");
    expect(script).toContain('node "$scripts_dir/live-docker-stage-private-sdk-exports.mjs"');
  });

  it("adds private SDK source exports only to the disposable source stage", () => {
    const root = tempDirs.make("openclaw-live-stage-sdk-");
    mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
    mkdirSync(path.join(root, "src", "plugin-sdk"), { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ exports: { "./plugin-sdk/core": "./dist/plugin-sdk/core.js" } }),
    );
    writeFileSync(
      path.join(root, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
      JSON.stringify(["keyed-async-queue"]),
    );
    writeFileSync(path.join(root, "src", "plugin-sdk", "keyed-async-queue.ts"), "export {};\n");

    addStagedPrivatePluginSdkExports(root);

    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(packageJson.exports).toEqual({
      "./plugin-sdk/core": "./dist/plugin-sdk/core.js",
      "./plugin-sdk/keyed-async-queue": {
        types: "./src/plugin-sdk/keyed-async-queue.ts",
        default: "./src/plugin-sdk/keyed-async-queue.ts",
      },
    });
  });

  it("keeps host-only generated registry state out of the container copy", () => {
    const script = readFileSync(stageScriptPath, "utf8");

    expect(script).toContain("--exclude=workspace");
    expect(script).toContain("--exclude=sandboxes");
    expect(script).toContain("--exclude=plugins/installs.json");
    expect(script).toContain("--exclude=plugins/installs.json.migrated");
    expect(script).toContain(
      `db.prepare("DELETE FROM config_machine_state WHERE state_key = ?").run("plugins.installedIndex");`,
    );
    expect(script).toContain("PRAGMA secure_delete = ON");
    expect(script).toContain("VACUUM");
    expect(script).toContain("host-absolute paths");
  });
});
