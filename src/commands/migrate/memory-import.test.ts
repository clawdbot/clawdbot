import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MigrationPlan, MigrationProviderPlugin } from "../../plugins/types.js";
const mocks = vi.hoisted(() => ({
  isMemoryIsolationCutoverAgent: vi.fn(() => false),
  runMigrationApply: vi.fn(),
}));

vi.mock("../../plugins/memory-cutover.js", () => ({
  isMemoryIsolationCutoverAgent: mocks.isMemoryIsolationCutoverAgent,
}));
vi.mock("./apply.js", () => ({ runMigrationApply: mocks.runMigrationApply }));

import { applyProviderMemoryImport, planProviderMemoryImport } from "./memory-import.js";

const tempRoots: string[] = [];

async function makeSourceDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "memory-import-test-")));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  mocks.isMemoryIsolationCutoverAgent.mockReset().mockReturnValue(false);
  mocks.runMigrationApply.mockReset();
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

async function memoryPlan(sourceDir: string, ids: string[]): Promise<MigrationPlan> {
  const items = await Promise.all(
    ids.map(async (id, index) => {
      // Duplicate ids still resolve to distinct real files so the dedupe check,
      // not a missing-file error, is what rejects them.
      const source = path.join(sourceDir, `${id}-${index}.md`);
      await fs.writeFile(source, `# ${id}\n`);
      return {
        id,
        kind: "memory" as const,
        action: "copy" as const,
        status: "planned" as const,
        source,
        target: `/target/${id}-${index}.md`,
      };
    }),
  );
  return {
    providerId: "test",
    source: sourceDir,
    summary: {
      total: items.length,
      planned: items.length,
      migrated: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
    items,
  };
}

function stubProvider(plan: MigrationPlan): MigrationProviderPlugin {
  return {
    id: "test",
    label: "Test",
    supportedItemKinds: ["memory"],
    detect: () => ({ found: true, source: plan.source }),
    plan: () => plan,
    apply: () => ({ ...plan, summary: plan.summary }),
  };
}

const config = {} as OpenClawConfig;

describe("planProviderMemoryImport memory-only shaping", () => {
  it("rejects a plan with duplicate memory item ids", async () => {
    const dir = await makeSourceDir();
    await expect(
      planProviderMemoryImport({
        provider: stubProvider(await memoryPlan(dir, ["same-id", "same-id"])),
        config,
        agentId: "main",
      }),
    ).rejects.toThrow('duplicate memory migration item id "same-id"');
  });

  it("accepts a plan with unique memory item ids", async () => {
    const dir = await makeSourceDir();
    const { plan } = await planProviderMemoryImport({
      provider: stubProvider(await memoryPlan(dir, ["memory-a", "memory-b"])),
      config,
      agentId: "main",
    });
    expect(plan.items.map((item) => item.id)).toEqual(["memory-a", "memory-b"]);
  });
});

describe("applyProviderMemoryImport", () => {
  it("does not call a provider after P1C enables read-only isolation", async () => {
    const dir = await makeSourceDir();
    const plan = await memoryPlan(dir, ["memory-a"]);
    mocks.isMemoryIsolationCutoverAgent.mockReturnValue(true);

    await expect(
      applyProviderMemoryImport({
        provider: stubProvider(plan),
        config,
        agentId: "main",
        itemIds: ["memory-a"],
        preflightPlan: plan,
      }),
    ).rejects.toThrow("memory import is unavailable while memory isolation is enforced");

    expect(mocks.runMigrationApply).not.toHaveBeenCalled();
  });
});
