import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createFormattedPromptSnapshotFiles,
  deleteStalePromptSnapshotFiles,
} from "../../scripts/generate-prompt-snapshots.js";
import {
  defaultCatalogPathCandidates,
  findDefaultCatalogPath,
  renderCodexModelInstructions,
  runCodexModelPromptFixtureSync,
} from "../../scripts/sync-codex-model-prompt-fixture.js";
import {
  CODEX_MODEL_PROMPT_FIXTURE_DIR,
  CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR,
} from "../helpers/agents/happy-path-prompt-snapshots.js";

function requireGeneratedSnapshot(
  generated: Array<{ path: string; content: string }>,
  fileName: string,
): string {
  const match = generated.find((file) => file.path.endsWith(fileName));
  if (!match) {
    throw new Error(`Missing generated prompt snapshot ${fileName}`);
  }
  return match.content;
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
  let generatedSnapshots: Awaited<ReturnType<typeof createFormattedPromptSnapshotFiles>>;

  beforeAll(async () => {
    generatedSnapshots = await createFormattedPromptSnapshotFiles();
  });

  it("matches the committed Codex prompt snapshot artifacts", async () => {
    const expectedPaths = new Set(generatedSnapshots.map((file) => file.path));
    for (const file of generatedSnapshots) {
      expect(fs.readFileSync(file.path, "utf8"), file.path).toBe(file.content);
    }
    const committed = fs
      .readdirSync(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR)
      .filter((entry) => entry.endsWith(".md") || entry.endsWith(".json"))
      .map((entry) => path.join(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, entry));
    expect(committed.toSorted()).toEqual([...expectedPaths].toSorted());
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
    const telegram = requireGeneratedSnapshot(
      generatedSnapshots,
      "telegram-direct-codex-message-tool.md",
    );

    expect(telegram).toContain("## Reconstructed Model-Bound Prompt Layers");
    expect(telegram).toContain("### System: Codex Model Instructions (gpt-5.5, pragmatic)");
    expect(telegram).toContain("You are Codex, a coding agent based on GPT-5.");
    expect(telegram).toContain("### Developer: Codex Permission Instructions");
    expect(telegram).toContain(
      "Approval policy is currently never. Do not provide the `sandbox_permissions`",
    );
    expect(telegram).toContain(
      "### User: Codex Config Instructions (OpenClaw Workspace Bootstrap Context)",
    );
    expect(telegram).toContain("<SOUL.md contents will be here>");
    expect(telegram).toContain("<TOOLS.md contents will be here>");
    expect(telegram).toContain("<HEARTBEAT.md contents will be here>");
    expect(telegram).toContain("Codex loads AGENTS.md natively");
    expect(telegram).toContain("### Tools: Dynamic Tool Catalog");
  });

  it("keeps heartbeat guidance in heartbeat collaboration mode only", async () => {
    const direct = requireGeneratedSnapshot(
      generatedSnapshots,
      "telegram-direct-codex-message-tool.md",
    );
    const group = requireGeneratedSnapshot(
      generatedSnapshots,
      "discord-group-codex-message-tool.md",
    );
    const heartbeat = requireGeneratedSnapshot(
      generatedSnapshots,
      "telegram-heartbeat-codex-tool.md",
    );
    const heartbeatPhrase = "Use heartbeats to create useful proactive progress";

    expect(direct).toContain('"collaborationMode": {');
    expect(direct).toContain('"developer_instructions": null');
    expect(group).toContain('"collaborationMode": {');
    expect(group).toContain('"developer_instructions": null');
    expect(direct).not.toContain(heartbeatPhrase);
    expect(group).not.toContain(heartbeatPhrase);

    expect(heartbeat).toContain('"collaborationMode": {');
    expect(heartbeat).toContain('"developer_instructions": "This is an OpenClaw heartbeat turn.');
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
    expect(collaborationModeInstructions.split(heartbeatPhrase)).toHaveLength(2);
  });

  it("keeps the Codex model prompt fixture next to its source metadata", () => {
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
});
