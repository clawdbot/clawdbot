import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

describe("happy path prompt snapshots", () => {
  it("matches the committed Codex prompt snapshot artifacts", async () => {
    const generated = await createFormattedPromptSnapshotFiles();
    const expectedPaths = new Set(generated.map((file) => file.path));
    for (const file of generated) {
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
    const generated = await createFormattedPromptSnapshotFiles();
    const telegram = generated.find((file) =>
      file.path.endsWith("telegram-direct-codex-message-tool.md"),
    );

    expect(telegram?.content).toContain("## Reconstructed Model-Bound Prompt Layers");
    expect(telegram?.content).toContain(
      "### System: Codex Model Instructions (gpt-5.5, pragmatic)",
    );
    expect(telegram?.content).toContain("You are Codex, a coding agent based on GPT-5.");
    expect(telegram?.content).toContain("### Developer: Codex Permission Instructions");
    expect(telegram?.content).toContain(
      "Approval policy is currently never. Do not provide the `sandbox_permissions`",
    );
    expect(telegram?.content).toContain(
      "### User: Codex Config Instructions (OpenClaw Workspace Bootstrap Context)",
    );
    expect(telegram?.content).toContain("<SOUL.md contents will be here>");
    expect(telegram?.content).toContain("<TOOLS.md contents will be here>");
    expect(telegram?.content).toContain("<HEARTBEAT.md contents will be here>");
    expect(telegram?.content).toContain("Codex loads AGENTS.md natively");
    expect(telegram?.content).toContain("### Tools: Dynamic Tool Catalog");
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

      await expect(findDefaultCatalogPath({ env: {}, homeDir: root })).resolves.toMatchObject({
        catalogPath: cachePath,
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
