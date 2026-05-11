import os from "node:os";
import path from "node:path";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { resolveHomePath } from "./helpers.js";
import pluginEntry from "./index.js";
import { HERMES_REASON_INCLUDE_SECRETS } from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { cleanupTempRoots, makeContext, makeTempRoot, writeFile } from "./test/provider-helpers.js";

function itemById(
  items: Array<{ id: string; [key: string]: unknown }>,
  id: string,
): { id: string; [key: string]: unknown } | undefined {
  return items.find((item) => item.id === id);
}

describe("Hermes migration provider", () => {
  afterEach(async () => {
    await cleanupTempRoots();
  });

  it("registers the Hermes migration provider through the plugin entry", () => {
    const captured = createCapturedPluginRegistration();
    pluginEntry.register(captured.api);
    expect(captured.migrationProviders.map((provider) => provider.id)).toEqual(["hermes"]);
  });

  it("resolves tilde source paths against the OS home when OPENCLAW_HOME is set", () => {
    const previous = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = path.join(path.sep, "tmp", "openclaw-home");
    try {
      expect(resolveHomePath("~/.hermes")).toBe(path.join(os.homedir(), ".hermes"));
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previous;
      }
    }
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

    expect(detected?.found).toBe(true);
    expect(detected?.source).toBe(source);
    expect(detected?.confidence).toBe("high");
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

    expect(detected?.found).toBe(true);
    expect(detected?.source).toBe(source);
    expect(detected?.confidence).toBe("high");
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

    expect(plan.summary.total).toBe(8);
    expect(plan.summary.conflicts).toBe(2);
    expect(plan.summary.sensitive).toBe(1);
    expect(itemById(plan.items, "config:default-model")?.status).toBe("conflict");
    expect(itemById(plan.items, "config:memory")?.status).toBe("planned");
    expect(itemById(plan.items, "config:memory-plugin-slot")?.status).toBe("planned");
    expect(itemById(plan.items, "config:model-providers")?.status).toBe("planned");
    expect(itemById(plan.items, "workspace:SOUL.md")?.status).toBe("conflict");
    const memory = itemById(plan.items, "memory:MEMORY.md");
    expect(memory?.action).toBe("append");
    expect(memory?.status).toBe("planned");
    expect(itemById(plan.items, "skill:ship-it")?.status).toBe("planned");
    const secret = itemById(plan.items, "secret:openai");
    expect(secret?.sensitive).toBe(true);
    expect(secret?.status).toBe("skipped");
    expect(secret?.reason).toBe(HERMES_REASON_INCLUDE_SECRETS);
    const warnings = plan.warnings ?? [];
    expect(warnings.some((warning) => warning.includes("Secrets were detected but skipped"))).toBe(
      true,
    );
    expect(warnings.some((warning) => warning.includes("Conflicts were found"))).toBe(true);
  });
});
