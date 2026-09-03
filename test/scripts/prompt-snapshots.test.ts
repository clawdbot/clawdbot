// Prompt Snapshots tests cover prompt snapshots script behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  materializeCodexDynamicToolSnapshot,
  materializeCodexPromptSnapshot,
  materializeCodexPromptSnapshotDelta,
} from "../../scripts/generate-prompt-snapshots.js";
import { deleteStalePromptSnapshotFiles } from "../../scripts/prompt-snapshot-files.js";
import {
  CODEX_MODEL_PROMPT_FIXTURE_DIR as SYNC_CODEX_MODEL_PROMPT_FIXTURE_DIR,
  defaultCatalogPathCandidates,
  findDefaultCatalogPath,
  renderCodexModelInstructions,
  runCodexModelPromptFixtureSync,
} from "../../scripts/sync-codex-model-prompt-fixture.js";
import { getPluginModuleLoaderStats } from "../../src/plugins/plugin-module-loader-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../src/state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";
import {
  restoreStateDirEnv,
  setStateDirEnv,
  snapshotStateDirEnv,
} from "../../src/test-helpers/state-dir-env.js";
import { createHappyPathPromptSnapshotFiles } from "../helpers/agents/happy-path-prompt-snapshots.js";
import {
  CODEX_MODEL_PROMPT_FIXTURE_DIR,
  CODEX_PROMPT_SNAPSHOT_BASE_SCENARIO,
  CODEX_PROMPT_SNAPSHOT_FILES,
  CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR,
} from "../helpers/agents/prompt-snapshot-paths.js";

function readCommittedSnapshot(fileName: string): string {
  return fs.readFileSync(path.join(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, fileName), "utf8");
}

function renderedPromptSection(content: string, heading: string, nextHeading: string): string {
  const start = content.indexOf(heading);
  const end = content.indexOf(nextHeading, start + heading.length);
  if (start === -1 || end === -1) {
    throw new Error(`Missing rendered prompt section ${heading}`);
  }
  return content.slice(start, end);
}

let generated: Awaited<ReturnType<typeof createHappyPathPromptSnapshotFiles>>;
let pluginLoaderCallsBefore: number;
let pluginLoaderCallsAfter: number;
let poisonedStateRoot: string | undefined;
const stateDirEnv = snapshotStateDirEnv();

describe("happy path prompt snapshots", () => {
  beforeAll(async () => {
    poisonedStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prompt-snapshot-poison-"));
    const databasePath = resolveOpenClawStateSqlitePath({
      ...process.env,
      OPENCLAW_STATE_DIR: poisonedStateRoot,
    });
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
    } finally {
      database.close();
    }
    setStateDirEnv(poisonedStateRoot);

    pluginLoaderCallsBefore = getPluginModuleLoaderStats().calls;
    generated = await createHappyPathPromptSnapshotFiles();
    pluginLoaderCallsAfter = getPluginModuleLoaderStats().calls;
  }, 300_000);

  afterAll(() => {
    restoreStateDirEnv(stateDirEnv);
    if (poisonedStateRoot) {
      fs.rmSync(poisonedStateRoot, { recursive: true, force: true });
    }
  });

  it("reconstructs complete Codex tool catalogs from readable full-tool overrides", async () => {
    const scenarios = [
      { name: "telegram-direct", replacements: [] },
      { name: "discord-group", replacements: ["sessions_spawn"] },
      { name: "heartbeat-turn", replacements: ["openclaw_direct"] },
    ];

    for (const { name, replacements } of scenarios) {
      const fileName = `codex-dynamic-tools.${name}.json`;
      const expected = generated.find((file) => path.basename(file.path) === fileName);
      expect(expected, `missing complete generated tool catalog for ${name}`).toBeDefined();

      const committed = JSON.parse(readCommittedSnapshot(fileName)) as
        | unknown[]
        | {
            base: string;
            replace: Record<string, { name: string; inputSchema?: unknown; tools?: unknown[] }>;
          };
      if (Array.isArray(committed)) {
        expect(replacements).toEqual([]);
      } else {
        expect(committed.base).toBe("codex-dynamic-tools.telegram-direct.json");
        expect(Object.keys(committed.replace)).toEqual(replacements);
        for (const [toolName, tool] of Object.entries(committed.replace)) {
          expect(tool.name).toBe(toolName);
          expect(tool.inputSchema !== undefined || Array.isArray(tool.tools)).toBe(true);
        }
      }

      const materialized = await materializeCodexDynamicToolSnapshot(name);
      expect(JSON.parse(materialized)).toEqual(JSON.parse(expected!.content));
    }
  });

  it("rejects invalid Codex dynamic-tool materialization scenarios", async () => {
    await expect(materializeCodexDynamicToolSnapshot("../outside")).rejects.toThrow(
      "Invalid Codex dynamic-tool snapshot scenario",
    );
  });

  it.each(Object.entries(CODEX_PROMPT_SNAPSHOT_FILES))(
    "materializes the complete committed Codex prompt for %s",
    async (scenario, fileName) => {
      const materialized = await materializeCodexPromptSnapshot(scenario);
      if (scenario === CODEX_PROMPT_SNAPSHOT_BASE_SCENARIO) {
        expect(materialized).toBe(readCommittedSnapshot(fileName));
        return;
      }
      const base = readCommittedSnapshot(
        CODEX_PROMPT_SNAPSHOT_FILES[CODEX_PROMPT_SNAPSHOT_BASE_SCENARIO],
      );
      const delta = readCommittedSnapshot(`${fileName}.diff`);
      expect(materializeCodexPromptSnapshotDelta({ scenario, base, delta })).toBe(materialized);
      expect(fs.existsSync(path.join(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, fileName))).toBe(
        false,
      );
    },
  );

  it("rejects unknown and noncanonical Codex prompt deltas", async () => {
    await expect(materializeCodexPromptSnapshot("../outside")).rejects.toThrow(
      "Unknown Codex prompt snapshot scenario",
    );
    const scenario = "discord-group";
    const fileName = CODEX_PROMPT_SNAPSHOT_FILES[scenario];
    const base = readCommittedSnapshot(
      CODEX_PROMPT_SNAPSHOT_FILES[CODEX_PROMPT_SNAPSHOT_BASE_SCENARIO],
    );
    const delta = readCommittedSnapshot(`${fileName}.diff`);
    const corruptions = [
      `${delta}\ntrailing text\n`,
      delta.replace("\n", "\r\n"),
      `${delta}\n${delta}`,
      delta.replace(fileName, "wrong.md"),
      delta.replace(/sha256=[a-f0-9]{64}/u, `sha256=${"0".repeat(64)}`),
    ];
    for (const corrupt of corruptions) {
      expect(() => materializeCodexPromptSnapshotDelta({ scenario, base, delta: corrupt })).toThrow(
        /Codex prompt snapshot/u,
      );
    }
  });

  it("generates snapshots without jiti plugin-loader fallbacks", async () => {
    // Perf contract for the check-prompt-snapshots CI lane: scenario channel
    // plugins are preloaded through the ambient module graph. A jiti
    // plugin-loader call here means a scenario channel (or another plugin
    // surface) fell back to source re-transpilation, which re-evaluates the
    // core graph and stalls the lane by minutes.
    expect(generated.length).toBeGreaterThan(0);
    const stats = getPluginModuleLoaderStats();
    expect(
      pluginLoaderCallsAfter - pluginLoaderCallsBefore,
      `prompt snapshot generation hit the jiti plugin loader; targets: ${stats.topSourceTransformTargets
        .map((entry) => entry.target)
        .join(", ")}`,
    ).toBe(0);
  });

  it("deletes stale generated snapshot artifacts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prompt-snapshot-stale-"));
    try {
      const snapshotDir = path.join(root, CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR);
      fs.mkdirSync(snapshotDir, { recursive: true });
      const stalePaths = ["stale-snapshot.md", "stale-snapshot.md.patch"].map((fileName) =>
        path.join(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, fileName),
      );
      const currentPath = path.join(
        CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR,
        "current-snapshot.md.diff",
      );
      for (const stalePath of stalePaths) {
        fs.writeFileSync(path.join(root, stalePath), "stale\n");
      }
      fs.writeFileSync(path.join(root, currentPath), "current\n");

      const deleted = await deleteStalePromptSnapshotFiles(root, [{ path: currentPath }]);

      expect(deleted.toSorted()).toEqual(stalePaths.toSorted());
      for (const stalePath of stalePaths) {
        expect(fs.existsSync(path.join(root, stalePath))).toBe(false);
      }
      expect(fs.readFileSync(path.join(root, currentPath), "utf8")).toBe("current\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders the Codex model-bound prompt layers", async () => {
    const telegram = await materializeCodexPromptSnapshot("telegram-direct");

    expect(telegram).toContain("## Reconstructed Model-Bound Prompt Layers");
    expect(telegram).toContain("### System: Codex Model Instructions (gpt-5.5, pragmatic)");
    expect(telegram).toContain("You are Codex, a coding agent based on GPT-5.");
    expect(telegram).toContain("### Developer: Codex Permission Instructions");
    expect(telegram).toContain(
      "Approval policy is currently never. Do not provide the `sandbox_permissions`",
    );
    expect(telegram).toContain("### User: Codex Config Instructions");
    expect(telegram).toContain("### User: Turn Input Text");
    expect(telegram).toContain("OpenClaw runtime context for this turn:");
    expect(telegram).toContain("<SOUL.md contents will be here>");
    expect(telegram).toContain("<IDENTITY.md contents will be here>");
    expect(telegram).toContain("<USER.md contents will be here>");
    expect(telegram).toContain("<MEMORY.md contents will be here>");
    expect(telegram).not.toContain("<HEARTBEAT.md contents will be here>");
    expect(telegram).toContain("Codex loads AGENTS.md natively");
    expect(telegram).toContain("### Tools: Dynamic Tool Catalog");
  });

  it("uses normal Codex collaboration instructions for every scheduled heartbeat", async () => {
    const [direct, group, heartbeat] = await Promise.all([
      materializeCodexPromptSnapshot("telegram-direct"),
      materializeCodexPromptSnapshot("discord-group"),
      materializeCodexPromptSnapshot("heartbeat-turn"),
    ]);
    const heartbeatPhrase = "Heartbeat = useful proactive progress";
    const agentSoulHeading = "## OpenClaw Agent Soul";

    expect(direct).toContain('"collaborationMode": {');
    expect(direct).toContain('"developer_instructions": "# Collaboration Mode: Default');
    expect(direct).toContain(agentSoulHeading);
    expect(group).toContain('"collaborationMode": {');
    expect(group).toContain('"developer_instructions": "# Collaboration Mode: Default');
    expect(group).toContain(agentSoulHeading);
    expect(direct).not.toContain(heartbeatPhrase);
    expect(group).not.toContain(heartbeatPhrase);
    expect(direct).not.toContain("This is an OpenClaw heartbeat turn.");
    expect(group).not.toContain("This is an OpenClaw heartbeat turn.");

    expect(heartbeat).toContain('"collaborationMode": {');
    expect(heartbeat).toContain('"developer_instructions": "# Collaboration Mode: Default');
    expect(heartbeat).toContain(agentSoulHeading);
    const openClawRuntimeInstructions = renderedPromptSection(
      heartbeat,
      "### Developer: OpenClaw Runtime Instructions",
      "### Developer: Codex Collaboration Mode Instructions",
    );
    const collaborationModeInstructions = renderedPromptSection(
      heartbeat,
      "### Developer: Codex Collaboration Mode Instructions",
      "### User: Turn Input Text",
    );

    expect(openClawRuntimeInstructions).not.toContain(heartbeatPhrase);
    expect(collaborationModeInstructions).not.toContain(heartbeatPhrase);
    expect(collaborationModeInstructions).not.toContain("HEARTBEAT.md");
    expect(heartbeat).not.toContain("This is an OpenClaw heartbeat turn.");
    expect(heartbeat).not.toContain("simulatedHeartbeatWorkspaceFile");
  });

  it("keeps the Codex model prompt fixture next to its source metadata", () => {
    expect(SYNC_CODEX_MODEL_PROMPT_FIXTURE_DIR).toBe(CODEX_MODEL_PROMPT_FIXTURE_DIR);
    expect(
      fs.existsSync(path.join(CODEX_MODEL_PROMPT_FIXTURE_DIR, "gpt-5.5.pragmatic.instructions.md")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(CODEX_MODEL_PROMPT_FIXTURE_DIR, "gpt-5.5.pragmatic.source.json")),
    ).toBe(true);
  });

  it("renders Codex model catalog instructions with the selected personality", () => {
    const rendered = renderCodexModelInstructions({
      model: {
        slug: "gpt-5.5",
        base_instructions: "fallback",
        model_messages: {
          instructions_template: "Intro\n{{ personality }}\nEnd",
          instructions_variables: {
            personality_pragmatic: "Pragmatic voice",
          },
        },
      },
      personality: "pragmatic",
    });

    expect(rendered).toEqual({
      instructions: "Intro\nPragmatic voice\nEnd",
      field:
        "model_messages.instructions_template + model_messages.instructions_variables.personality_pragmatic",
    });
  });

  it("prefers the Codex runtime model cache before local checkout fallbacks", () => {
    const candidates = defaultCatalogPathCandidates({
      env: { CODEX_HOME: "/tmp/codex-home" },
      homeDir: "/tmp/home",
    });

    expect(candidates).toEqual([
      path.join("/tmp/codex-home", "models_cache.json"),
      path.join("/tmp/home", ".codex", "models_cache.json"),
      path.join("/tmp/home", "code", "codex", "codex-rs", "models-manager", "models.json"),
    ]);
  });

  it("finds the first available default Codex model catalog source", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-catalog-"));
    try {
      const cachePath = path.join(root, ".codex", "models_cache.json");
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({ models: [] }));

      await expect(findDefaultCatalogPath({ env: {}, homeDir: root })).resolves.toEqual({
        catalogPath: cachePath,
        candidates: [
          cachePath,
          path.join(root, "code", "codex", "codex-rs", "models-manager", "models.json"),
        ],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips Codex model prompt fixture sync when no default catalog exists", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-catalog-missing-"));
    const chunks: string[] = [];
    try {
      const result = await runCodexModelPromptFixtureSync([], {
        env: {},
        homeDir: root,
        stdout: {
          write(chunk) {
            chunks.push(chunk);
          },
        },
      });

      expect(result.status).toBe("skipped");
      expect(chunks.join("")).toContain("No Codex model catalog/cache found");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes Codex model prompt fixtures from an explicit catalog", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-catalog-write-"));
    try {
      const catalogPath = path.join(root, "models_cache.json");
      const outputDir = path.join(root, "out");
      fs.writeFileSync(
        catalogPath,
        JSON.stringify({
          models: [
            {
              slug: "gpt-5.6-sol",
              model_messages: {
                instructions_template: "System\n{{ personality }}\nEnd",
                instructions_variables: {
                  personality_pragmatic: "Use terse engineering judgement.",
                },
              },
            },
          ],
        }),
      );

      const result = await runCodexModelPromptFixtureSync([
        "--catalog",
        catalogPath,
        "--source-label",
        "<test-catalog>",
        "--catalog-git-head",
        "abc123",
        "--out-dir",
        outputDir,
      ]);

      expect(result.status).toBe("written");
      expect(
        fs.readFileSync(path.join(outputDir, "gpt-5.6-sol.pragmatic.instructions.md"), "utf8"),
      ).toBe("System\nUse terse engineering judgement.\nEnd\n");
      expect(
        JSON.parse(
          fs.readFileSync(path.join(outputDir, "gpt-5.6-sol.pragmatic.source.json"), "utf8"),
        ),
      ).toEqual({
        model: "gpt-5.6-sol",
        personality: "pragmatic",
        source: {
          catalogPath: "<test-catalog>",
          catalogKind: "models_cache",
          catalogGitHead: "abc123",
          field:
            "model_messages.instructions_template + model_messages.instructions_variables.personality_pragmatic",
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
