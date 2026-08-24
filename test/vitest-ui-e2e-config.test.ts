// Vitest UI E2E config tests protect complete, duration-balanced browser sharding.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestSpecification } from "vitest/node";
import uiE2eConfig from "./vitest/vitest.ui-e2e.config.ts";
import { UiE2eSequencer } from "./vitest/vitest.ui-e2e.sequencer.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

function requireTestConfig(config: unknown): {
  sequence?: { sequencer?: unknown };
} {
  if (!config || typeof config !== "object" || !("test" in config) || !config.test) {
    throw new Error("expected UI E2E Vitest test config");
  }
  return config.test as { sequence?: { sequencer?: unknown } };
}

async function shardFiles(files: TestSpecification[], index: number, count: number) {
  const sequencer = new UiE2eSequencer({ config: { shard: { count, index } } } as never);
  return sequencer.shard(files);
}

describe("Control UI E2E Vitest sharding", () => {
  it("uses the duration weighted sequencer", () => {
    expect(requireTestConfig(uiE2eConfig).sequence?.sequencer).toBe(UiE2eSequencer);
  });

  it("covers every file once while balancing unhinted files by source bytes", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ui-e2e-shards-"));
    tempDirs.push(tempDir);
    const files = [600, 500, 400, 300, 200, 100].map((bytes, index) => {
      const moduleId = path.join(tempDir, `suite-${index}.e2e.test.ts`);
      fs.writeFileSync(moduleId, "x".repeat(bytes));
      return { moduleId } as TestSpecification;
    });

    const shards = await Promise.all([1, 2, 3].map((index) => shardFiles(files, index, 3)));
    const assignedFiles = shards.flat().map((file) => file.moduleId);
    const assignedBytes = shards.map((shard) =>
      shard.reduce((total, file) => total + fs.statSync(file.moduleId).size, 0),
    );

    expect(assignedFiles.toSorted()).toEqual(files.map((file) => file.moduleId).toSorted());
    expect(new Set(assignedFiles).size).toBe(files.length);
    expect(assignedBytes).toEqual([700, 700, 700]);
  });

  it("packs a slow hinted suite ahead of a much larger unhinted one", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ui-e2e-hints-"));
    tempDirs.push(tempDir);
    // chat-sidebar-panel-contract is hinted at 27s; the byte proxy would score
    // this 1 KB file at well under a second and bury it behind the 40 KB suite.
    const hinted = path.join(tempDir, "chat-sidebar-panel-contract.e2e.test.ts");
    const large = path.join(tempDir, "unhinted-large.e2e.test.ts");
    fs.writeFileSync(hinted, "x".repeat(1024));
    fs.writeFileSync(large, "x".repeat(40 * 1024));
    const files = [{ moduleId: hinted }, { moduleId: large }] as TestSpecification[];

    const shards = await Promise.all([1, 2].map((index) => shardFiles(files, index, 2)));

    expect(shards.map((shard) => shard.map((file) => file.moduleId))).toEqual([[hinted], [large]]);
  });

  it("keeps every duration hint pointed at a real Control UI E2E suite", () => {
    const sequencerSource = fs.readFileSync(
      path.join(import.meta.dirname, "vitest/vitest.ui-e2e.sequencer.ts"),
      "utf8",
    );
    const hintedNames = [...sequencerSource.matchAll(/\["([^"]+\.e2e\.test\.ts)", \d+\]/g)].map(
      (match) => match[1]!,
    );
    expect(hintedNames.length).toBeGreaterThan(0);
    const missing = hintedNames.filter(
      (name) => !fs.existsSync(path.join(import.meta.dirname, "..", "ui/src/e2e", name)),
    );
    expect(missing).toEqual([]);
  });
});
