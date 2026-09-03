// Upgrade Survivor Config Recipe tests cover upgrade survivor config recipe script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_COMMAND_MAX_BUFFER_BYTES,
  CONFIG_COMMAND_TIMEOUT_MS,
  isReleaseBefore,
  resolveScenarioConfigSteps,
  resolveUpgradeSurvivorConfigSteps,
  resolveUpgradeSurvivorConfigStepsForBaseline,
  resolveUpgradeSurvivorOpenClawCommand,
  runUpgradeSurvivorOpenClawStep,
} from "../../scripts/e2e/lib/upgrade-survivor/config-recipe.mts";
import { AgentsSchema } from "../../src/config/zod-schema.agents.js";

const RECIPE_PATH = "scripts/e2e/lib/upgrade-survivor/config-recipe.mts";
const RUN_PATH = "scripts/e2e/lib/upgrade-survivor/run.sh";
const DOCKER_RUNNER_PATH = "scripts/e2e/upgrade-survivor-docker.sh";

describe("upgrade survivor config recipe command resolution", () => {
  it("selects the prerelease update channel for the plugin registry", () => {
    const runner = readFileSync(RUN_PATH, "utf8");
    expect(runner).toContain('OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL="beta"');
    expect(runner).toContain("OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION");
  });

  it.skipIf(process.platform === "win32")(
    "launches the published baseline with trusted sources and no host dependencies",
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "openclaw-upgrade-docker-boundary-")));
      const harnessRoot = realpathSync(process.cwd());
      try {
        const candidateRoot = join(root, "candidate");
        const binDir = join(root, "bin");
        const candidate = join(candidateRoot, "candidate.tgz");
        const stateScript = "scripts/lib/openclaw-test-state.mts";
        mkdirSync(join(candidateRoot, dirname(stateScript)), { recursive: true });
        cpSync(stateScript, join(candidateRoot, stateScript));
        writeFileSync(candidate, "unused by the Docker boundary stub");
        mkdirSync(binDir);
        writeFileSync(
          join(binDir, "docker"),
          `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  image) test "$2" = inspect ;;
  run) printf '%s\\0' "$@" >"$TMPDIR/docker-args" ;;
  *) echo "Unexpected Docker command: $1" >&2; exit 1 ;;
esac
`,
          { mode: 0o755 },
        );

        const result = spawnSync("bash", [join(harnessRoot, DOCKER_RUNNER_PATH)], {
          cwd: root,
          encoding: "utf8",
          env: {
            HOME: root,
            TMPDIR: root,
            PATH: [binDir, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
            OPENCLAW_SKIP_DOCKER_BUILD: "1",
            OPENCLAW_DOCKER_E2E_REPO_ROOT: candidateRoot,
            OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR: join(root, "artifacts"),
            OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "1",
            OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.7.1-2",
            OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE: candidate,
          },
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        const args = readFileSync(join(root, "docker-args"), "utf8").split("\0").slice(0, -1);
        const mounts = args.filter((_, index) => args[index - 1] === "-v");
        expect(mounts.filter((mount) => mount.includes("node_modules"))).toEqual([]);
        expect(args.some((arg) => arg.startsWith("OPENCLAW_UPGRADE_SURVIVOR_TSX_IMPORT="))).toBe(
          false,
        );
        expect(mounts).toEqual(
          expect.arrayContaining([
            `${harnessRoot}/scripts/e2e:/app/scripts/e2e:ro`,
            `${harnessRoot}/scripts/lib:/app/scripts/lib:ro`,
            `${harnessRoot}/scripts/windows-cmd-helpers.mjs:/app/scripts/windows-cmd-helpers.mjs:ro`,
            `${harnessRoot}/${RUN_PATH}:/tmp/openclaw-upgrade-survivor-run.sh:ro`,
            `${candidate}:/tmp/openclaw-current.tgz:ro`,
          ]),
        );
        expect(mounts.filter((mount) => mount.startsWith(`${candidateRoot}/`))).toEqual([
          `${candidate}:/tmp/openclaw-current.tgz:ro`,
        ]);
        expect(args).toContain(
          "OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC=/tmp/openclaw-current.tgz",
        );
        expect(args.slice(-5)).toEqual([
          "timeout",
          "--kill-after=30s",
          "1200s",
          "bash",
          "/tmp/openclaw-upgrade-survivor-run.sh",
        ]);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("compares baseline versions with the shared release parser", () => {
    expect(isReleaseBefore("2026.3.31", "2026.4.0")).toBe(true);
    expect(isReleaseBefore("2026.3.31-beta.1", "2026.4.0")).toBe(true);
    expect(isReleaseBefore("2026.4.1", "2026.4.0")).toBe(false);
    expect(isReleaseBefore(null, "2026.4.0")).toBe(false);
    expect(isReleaseBefore("2026.3.31junk", "2026.4.0")).toBe(false);
    expect(isReleaseBefore("2026.3.9007199254740993", "2026.4.0")).toBe(false);
  });

  it("wraps Windows openclaw npm shims through cmd.exe", () => {
    expect(
      resolveUpgradeSurvivorOpenClawCommand(
        ["config", "set", "models.providers.openai", '{"apiKey":"sk test"}', "--strict-json"],
        {
          comSpec: String.raw`C:\Windows\System32\cmd.exe`,
          platform: "win32",
        },
      ),
    ).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        'openclaw.cmd config set models.providers.openai "{""apiKey"":""sk test""}" --strict-json',
      ],
      command: String.raw`C:\Windows\System32\cmd.exe`,
      commandLabel:
        'openclaw config set models.providers.openai {"apiKey":"sk test"} --strict-json',
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("keeps POSIX openclaw invocations direct", () => {
    expect(
      resolveUpgradeSurvivorOpenClawCommand(["config", "validate"], {
        platform: "linux",
      }),
    ).toEqual({
      args: ["config", "validate"],
      command: "openclaw",
      commandLabel: "openclaw config validate",
      shell: false,
    });
  });

  it("adds the Codex allowlist survival scenario", () => {
    expect(resolveScenarioConfigSteps("codex-allowlist-survival")).toEqual([
      {
        argv: [
          "config",
          "set",
          "plugins.allow",
          JSON.stringify(["discord", "memory", "telegram", "whatsapp", "codex"]),
          "--strict-json",
        ],
        id: "plugins-codex-allowlist",
        intent: "codex-allowlist-survival",
      },
    ]);
  });

  it.each([
    ["base", undefined, "stable"],
    ["base", "beta", "beta"],
    ["prerelease-plugin-registry", undefined, "beta"],
  ])(
    "keeps the %s scenario on the %s override update channel",
    (scenario, channel, expectedChannel) => {
      const updateChannels = resolveUpgradeSurvivorConfigSteps(scenario, channel)
        .filter((step) => step.argv.slice(0, 3).join(" ") === "config set update.channel")
        .map((step) => step.argv[3]);

      expect(updateChannels.at(-1)).toBe(expectedChannel);
    },
  );

  it("inserts scenario config before final validation", () => {
    const steps = resolveUpgradeSurvivorConfigSteps("feishu-channel");
    const gateway = JSON.parse(steps.find((step) => step.id === "gateway")?.argv[3] ?? "{}");
    expect(gateway.reload).toEqual({ mode: "off" });
    expect(steps.find((step) => step.id === "channels-discord")).toBeDefined();
    expect(steps.find((step) => step.id === "channels-feishu")).toBeDefined();
    expect(steps.at(-1)?.id).toBe("validate");
  });

  it("keeps the watch direct-node recipe isolated from unrelated plugin fixtures", () => {
    const steps = resolveUpgradeSurvivorConfigSteps("watchos-direct-node");
    const intents = steps.map((step) => step.intent);

    expect(intents).toEqual(["update", "gateway", "validate"]);
    expect(steps.at(-1)?.id).toBe("validate");
  });

  it("composes configured plugin installs into the SQLite volume scenario", () => {
    expect(resolveScenarioConfigSteps("sqlite-volume")).toEqual(
      resolveScenarioConfigSteps("configured-plugin-installs"),
    );
  });

  it.each([
    { version: "2026.3.13", legacy: true },
    { version: "2026.7.1-2", legacy: true },
    { version: "2026.8.1-beta.1", legacy: true },
    { version: "2026.8.1-beta.2", legacy: false },
    { version: "2026.8.1", legacy: false },
    { version: null, legacy: false },
  ])("authors one version-correct recovery roster for $version", ({ version, legacy }) => {
    const steps = resolveUpgradeSurvivorConfigStepsForBaseline("recovery-cleanup", version);
    const agentSteps = steps.filter(
      (step) =>
        step.argv[0] === "config" && step.argv[1] === "set" && step.argv[2]?.startsWith("agents"),
    );
    expect(agentSteps).toHaveLength(1);
    expect(agentSteps[0]?.argv.slice(0, 3)).toEqual(["config", "set", "agents"]);
    const agents = JSON.parse(agentSteps[0]?.argv[3] ?? "{}");
    const ids = legacy
      ? agents.list.map((agent: { id: string }) => agent.id)
      : Object.keys(agents.entries);
    expect(ids).toEqual(["main", "ops", "recovery-clean", "recovery-protected"]);
    const ops = legacy
      ? agents.list.find((agent: { id: string }) => agent.id === "ops")
      : agents.entries.ops;
    expect(ops.fastModeDefault).toBe(version === "2026.3.13" ? undefined : true);
    expect(agents.defaults.heartbeat.every).toBe("0m");
    if (legacy) {
      expect(agents.ownership).toBeUndefined();
      expect(agents.list.filter((agent: { default?: boolean }) => agent.default)).toEqual([
        expect.objectContaining({ id: "main" }),
      ]);
    } else {
      expect(agents.ownership).toBe("explicit");
      expect(AgentsSchema.safeParse(agents).success).toBe(true);
    }
    const baseStep = resolveUpgradeSurvivorConfigStepsForBaseline("base", version).find(
      (step) => step.id === "agents",
    );
    const baseAgents = JSON.parse(baseStep?.argv[3] ?? "{}");
    expect(
      legacy
        ? baseAgents.list.map((agent: { id: string }) => agent.id)
        : Object.keys(baseAgents.entries),
    ).toEqual(["main", "ops"]);
    expect(steps.find((step) => step.id === "channels-whatsapp")).toBeDefined();
    expect(steps.at(-1)?.id).toBe("validate");
  });

  it("removes unsupported scenario config for older baselines", () => {
    const steps = resolveUpgradeSurvivorConfigStepsForBaseline("feishu-channel", "2026.3.13");
    expect(steps.find((step) => step.id === "channels-discord")).toBeDefined();
    expect(steps.find((step) => step.id === "channels-feishu")).toBeUndefined();
    expect(steps.at(-1)?.id).toBe("validate");
  });

  it.each([null, "2026.8.1-beta.2", "2026.8.1"])(
    "authors a schema-valid explicit agent roster for baseline %s",
    (version) => {
      const agentStep = resolveUpgradeSurvivorConfigStepsForBaseline("base", version).find(
        (step) => step.id === "agents",
      );
      const agents = JSON.parse(agentStep?.argv[3] ?? "{}");
      expect(AgentsSchema.safeParse(agents).success).toBe(true);
      expect(agents.ownership).toBe("explicit");
      expect(agents.defaults.heartbeat.every).toBe("0m");
      expect(Object.keys(agents.entries)).toEqual(["main", "ops"]);
      expect(agents.entries.ops.fastModeDefault).toBe(true);
    },
  );

  it.each(["2026.3.13", "2026.4.1", "2026.8.1-beta.1"])(
    "preserves the legacy agent contract for baseline %s",
    (version) => {
      const agentStep = resolveUpgradeSurvivorConfigStepsForBaseline("base", version).find(
        (step) => step.id === "agents",
      );
      const agents = JSON.parse(agentStep?.argv[3] ?? "{}");
      expect(agents.ownership).toBeUndefined();
      expect(agents.entries).toBeUndefined();
      expect(agents.list.map((agent: { id: string }) => agent.id)).toEqual(["main", "ops"]);
      expect(agents.list.filter((agent: { default?: boolean }) => agent.default)).toEqual([
        expect.objectContaining({ id: "main" }),
      ]);
      expect(agents.list[1].fastModeDefault).toBe(version === "2026.3.13" ? undefined : true);
    },
  );

  it("bounds baseline config commands and reports spawn errors", () => {
    const calls: unknown[] = [];
    const timeoutError = Object.assign(new Error("spawnSync openclaw ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });

    const outcome = runUpgradeSurvivorOpenClawStep(
      {
        argv: ["config", "validate"],
        id: "validate",
        intent: "validate",
      },
      {
        spawnSyncCommand(command: string, args: string[], options: unknown) {
          calls.push({ args, command, options });
          return {
            error: timeoutError,
            signal: "SIGTERM",
            status: null,
            stderr: "still validating",
            stdout: "partial output",
          };
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      args: ["config", "validate"],
      command: "openclaw",
      options: {
        killSignal: "SIGTERM",
        maxBuffer: CONFIG_COMMAND_MAX_BUFFER_BYTES,
        timeout: CONFIG_COMMAND_TIMEOUT_MS,
      },
    });
    expect(outcome).toMatchObject({
      command: "openclaw config validate",
      errorCode: "ETIMEDOUT",
      errorMessage: "spawnSync openclaw ETIMEDOUT",
      ok: false,
      signal: "SIGTERM",
      status: null,
      stderr: "still validating",
      stdout: "partial output",
    });
  });

  it.each(process.platform === "win32" ? ["recipe CLI"] : ["recipe CLI", "survivor shell"])(
    "skips unsupported ACPX bridge config through the %s",
    (entrypoint) => {
      const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-recipe-acpx-"));
      try {
        const binDir = join(root, "bin");
        const logPath = join(root, "openclaw-argv.jsonl");
        const summaryPath = join(root, "summary.json");
        mkdirSync(binDir, { recursive: true });
        const openclawLogPath = join(binDir, "openclaw-log.js");
        const openclawPath = join(binDir, "openclaw");
        const openclawCmdPath = join(binDir, "openclaw.cmd");
        writeFileSync(
          openclawLogPath,
          `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(0);
`,
        );
        writeFileSync(openclawPath, `#!/usr/bin/env node\nrequire("./openclaw-log.js");\n`);
        chmodSync(openclawPath, 0o755);
        writeFileSync(
          openclawCmdPath,
          `@echo off\r\n"${process.execPath}" "%~dp0openclaw-log.js" %*\r\n`,
        );

        let command = process.execPath;
        let cwd = process.cwd();
        let args = [
          "--import",
          "tsx",
          RECIPE_PATH,
          "apply",
          "--summary",
          summaryPath,
          "--baseline-version",
          "2026.4.21",
        ];
        if (entrypoint === "survivor shell") {
          // Source mounts contain the recipe closure, but no host dependency tree.
          for (const file of [
            RECIPE_PATH,
            "scripts/e2e/lib/upgrade-survivor/config-recipe",
            "scripts/lib/release-version.mjs",
            "scripts/windows-cmd-helpers.mjs",
          ]) {
            mkdirSync(dirname(join(root, file)), { recursive: true });
            cpSync(file, join(root, file), { recursive: true });
          }
          const launcher = readFileSync(RUN_PATH, "utf8").match(
            /^apply_baseline_config_recipe\(\) \{[\s\S]*?^\}/mu,
          )?.[0];
          expect(launcher).toBeTruthy();
          command = "bash";
          cwd = root;
          args = [
            "-c",
            `set -euo pipefail\nsource "$1"\n${launcher}\nCONFIG_COVERAGE_JSON="$2"\nbaseline_version=2026.4.21\napply_baseline_config_recipe`,
            "survivor-recipe",
            join(process.cwd(), "scripts/lib/openclaw-e2e-instance.sh"),
            summaryPath,
          ];
        }
        execFileSync(command, args, {
          cwd,
          env: {
            ...process.env,
            OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "acpx-openclaw-tools-bridge",
            PATH: [binDir, join(process.cwd(), "node_modules/.bin"), process.env.PATH ?? ""].join(
              delimiter,
            ),
          },
          stdio: "pipe",
        });

        const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
        const loggedArgs = readFileSync(logPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(summary.skippedIntents).toContain("acpx-openclaw-tools-bridge");
        expect(summary.acceptedIntents).not.toContain("acpx-openclaw-tools-bridge");
        expect(summary.baselineVersion).toBe("2026.4.21");
        expect(loggedArgs.at(-1)).toEqual(["config", "validate"]);
        expect(loggedArgs).not.toContainEqual(
          expect.arrayContaining([
            "set",
            "plugins",
            expect.stringContaining("openClawToolsMcpBridge"),
          ]),
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );
});
