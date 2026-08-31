// Upgrade Survivor Config Recipe tests cover upgrade survivor config recipe script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("uses trusted tsx or the candidate compiled config recipe entrypoint", () => {
    const runner = readFileSync(RUN_PATH, "utf8");
    const dockerRunner = readFileSync(DOCKER_RUNNER_PATH, "utf8");
    expect(runner).toContain("OPENCLAW_UPGRADE_SURVIVOR_TSX_IMPORT:-tsx");
    expect(runner).toContain(
      'node --import "$tsx_import" scripts/e2e/lib/upgrade-survivor/config-recipe.mts',
    );
    expect(runner).toContain(
      "recipe_runner=(node scripts/e2e/lib/upgrade-survivor/config-recipe.mjs)",
    );
    expect(runner).toContain('OPENCLAW_UPGRADE_SURVIVOR_UPDATE_CHANNEL="beta"');
    expect(runner).toContain("OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION");
    expect(runner).toContain('"${recipe_runner[@]}" apply');
    expect(dockerRunner).toContain(
      'TRUSTED_TSX_IMPORT="$TRUSTED_TSX_NODE_MODULES/tsx/dist/loader.mjs"',
    );
  });

  it("keeps trusted tsx dependencies resolvable at the Docker mount target", () => {
    const dockerRunner = readFileSync(DOCKER_RUNNER_PATH, "utf8");
    const loaderTarget = dockerRunner.match(
      /OPENCLAW_UPGRADE_SURVIVOR_TSX_IMPORT=(\/tmp\/\S+\/loader\.mjs)/u,
    )?.[1];
    const mountTarget = dockerRunner.match(
      /-v "\$TRUSTED_TSX_NODE_MODULES:(\/tmp\/[^:"]+):ro"/u,
    )?.[1];
    expect(loaderTarget).toBeTruthy();
    expect(mountTarget).toBeTruthy();
    if (!loaderTarget || !mountTarget) {
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "openclaw-upgrade-tsx-mount-"));
    try {
      const mountedNodeModules = join(root, mountTarget.slice(1));
      mkdirSync(mountedNodeModules, { recursive: true });
      for (const packageName of ["tsx", "esbuild", "@esbuild"]) {
        cpSync(
          join(process.cwd(), "node_modules", packageName),
          join(mountedNodeModules, packageName),
          {
            dereference: true,
            recursive: true,
          },
        );
      }

      const loaderPath = join(root, loaderTarget.slice(1));
      const result = spawnSync(process.execPath, ["--import", loaderPath, "-e", ""], {
        cwd: root,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

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
    expect(steps.find((step) => step.id === "channels-discord")).toBeDefined();
    expect(steps.find((step) => step.id === "channels-feishu")).toBeDefined();
    expect(steps.at(-1)?.id).toBe("validate");
  });

  it("composes configured plugin installs into the SQLite volume scenario", () => {
    expect(resolveScenarioConfigSteps("sqlite-volume")).toEqual(
      resolveScenarioConfigSteps("configured-plugin-installs"),
    );
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
      const step = resolveUpgradeSurvivorConfigStepsForBaseline("base", version).find(
        (step) => step.id === "agents",
      );
      const agents = JSON.parse(step?.argv[3] ?? "{}");
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
      const step = resolveUpgradeSurvivorConfigStepsForBaseline("base", version).find(
        (step) => step.id === "agents",
      );
      const agents = JSON.parse(step?.argv[3] ?? "{}");
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

  it("skips ACPX bridge config on baselines before the bridge field existed", () => {
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

      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          RECIPE_PATH,
          "apply",
          "--summary",
          summaryPath,
          "--baseline-version",
          "2026.4.21",
        ],
        {
          env: {
            ...process.env,
            OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "acpx-openclaw-tools-bridge",
            PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
          },
          stdio: "pipe",
        },
      );

      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
      const loggedArgs = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(summary.skippedIntents).toContain("acpx-openclaw-tools-bridge");
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
  });
});
