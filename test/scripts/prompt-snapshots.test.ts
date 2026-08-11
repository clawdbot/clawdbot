// Prompt Snapshots tests cover prompt snapshots script behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFormattedPromptSnapshotFiles,
  materializeCodexDynamicToolSnapshot,
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
import { createHappyPathPromptSnapshotFiles } from "../helpers/agents/happy-path-prompt-snapshots.js";
import {
  CODEX_MODEL_PROMPT_FIXTURE_DIR,
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

describe("happy path prompt snapshots", () => {
  it("loads the generator entrypoint used by the prompt snapshot check", () => {
    expect(createFormattedPromptSnapshotFiles).toEqual(expect.any(Function));
  });

  it("reconstructs complete Codex tool catalogs from readable full-tool overrides", async () => {
    const generated = await createHappyPathPromptSnapshotFiles();
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

  it("generates snapshots without jiti plugin-loader fallbacks", async () => {
    // Perf contract for the check-prompt-snapshots CI lane: scenario channel
    // plugins are preloaded through the ambient module graph. A jiti
    // plugin-loader call here means a scenario channel (or another plugin
    // surface) fell back to source re-transpilation, which re-evaluates the
    // core graph and stalls the lane by minutes.
    const callsBefore = getPluginModuleLoaderStats().calls;
    const files = await createHappyPathPromptSnapshotFiles();
    expect(files.length).toBeGreaterThan(0);
    const stats = getPluginModuleLoaderStats();
    expect(
      stats.calls - callsBefore,
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
      const stalePath = path.join(
        CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR,
        "stale-snapshot.md",
      );
      fs.writeFileSync(path.join(root, stalePath), "stale\n");

      const deleted = await deleteStalePromptSnapshotFiles(root, [
        { path: path.join(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, "current.md") },
      ]);

      expect(deleted).toEqual([stalePath]);
      expect(fs.existsSync(path.join(root, stalePath))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders the Codex model-bound prompt layers", async () => {
    const telegram = readCommittedSnapshot("telegram-direct-codex-message-tool.md");

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

  it("keeps heartbeat guidance in heartbeat collaboration mode only", async () => {
    const direct = readCommittedSnapshot("telegram-direct-codex-message-tool.md");
    const group = readCommittedSnapshot("discord-group-codex-message-tool.md");
    const heartbeat = readCommittedSnapshot("telegram-heartbeat-codex-tool.md");
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
    expect(heartbeat).toContain('"developer_instructions": "This is an OpenClaw heartbeat turn.');
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
    expect(collaborationModeInstructions).toContain(heartbeatPhrase);
    // Monitor context now lives in cron scratch; the collaboration prompt must
    // no longer reference the retired workspace file.
    expect(collaborationModeInstructions).not.toContain("HEARTBEAT.md");
    expect(collaborationModeInstructions.split(heartbeatPhrase)).toHaveLength(2);
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
