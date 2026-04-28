import path from "node:path";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import pluginEntry from "./index.js";
import { HERMES_REASON_INCLUDE_SECRETS } from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { cleanupTempRoots, makeContext, makeTempRoot, writeFile } from "./test/provider-helpers.js";

describe("Hermes migration provider", () => {
  afterEach(async () => {
    await cleanupTempRoots();
  });

  it("registers the Hermes migration provider through the plugin entry", () => {
    const captured = createCapturedPluginRegistration();
    pluginEntry.register(captured.api);
    expect(captured.migrationProviders.map((provider) => provider.id)).toEqual(["hermes"]);
  });

  it("detects Hermes sources supported by planning", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(path.join(source, "SOUL.md"), "# Hermes soul\n");

    const provider = buildHermesMigrationProvider();
    const detected = await provider.detect?.(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );

    expect(detected).toMatchObject({
      found: true,
      source,
      confidence: "high",
    });
  });

  it("detects archive-only Hermes sources", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    await writeFile(path.join(source, "logs", "run.log"), "log line\n");

    const provider = buildHermesMigrationProvider();
    const detected = await provider.detect?.(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );

    expect(detected).toMatchObject({
      found: true,
      source,
      confidence: "high",
    });
  });

  it("rejects missing Hermes sources before planning", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "missing-hermes");

    const provider = buildHermesMigrationProvider();

    await expect(
      provider.plan(
        makeContext({
          source,
          stateDir: path.join(root, "state"),
          workspaceDir: path.join(root, "workspace"),
        }),
      ),
    ).rejects.toThrow(`Hermes state was not found at ${source}`);
  });

  it("plans model, workspace, memory, skill, and secret items without importing secrets by default", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: openai\n  model: gpt-5.4\n",
    );
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    await writeFile(path.join(source, "SOUL.md"), "# Hermes soul\n");
    await writeFile(path.join(source, "memories", "MEMORY.md"), "remember this\n");
    await writeFile(path.join(source, "skills", "Ship It", "SKILL.md"), "# Ship It\n");
    await writeFile(path.join(workspaceDir, "SOUL.md"), "# Existing soul\n");

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        model: "anthropic/claude-sonnet-4.6",
      }),
    );

    expect(plan.summary).toMatchObject({ total: 8, conflicts: 2, sensitive: 1 });
    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "config:default-model", status: "conflict" }),
        expect.objectContaining({ id: "config:memory", status: "planned" }),
        expect.objectContaining({ id: "config:memory-plugin-slot", status: "planned" }),
        expect.objectContaining({ id: "config:model-providers", status: "planned" }),
        expect.objectContaining({ id: "workspace:SOUL.md", status: "conflict" }),
        expect.objectContaining({ id: "memory:MEMORY.md", action: "append", status: "planned" }),
        expect.objectContaining({ id: "skill:ship-it", status: "planned" }),
        expect.objectContaining({
          id: "secret:openai",
          sensitive: true,
          status: "skipped",
          reason: HERMES_REASON_INCLUDE_SECRETS,
        }),
      ]),
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Secrets were detected but skipped"),
        expect.stringContaining("Conflicts were found"),
      ]),
    );
  });
});
