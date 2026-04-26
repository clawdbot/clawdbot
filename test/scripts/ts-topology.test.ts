import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeTopology } from "../../scripts/lib/ts-topology/analyze.js";
import { renderTextReport } from "../../scripts/lib/ts-topology/reports.js";
import { createFilesystemPublicSurfaceScope } from "../../scripts/lib/ts-topology/scope.js";
import { main } from "../../scripts/ts-topology.ts";
import { createCapturedIo } from "../helpers/captured-io.js";

const repoRoot = path.join(process.cwd(), "test", "fixtures", "ts-topology", "basic");

function buildFixtureScope() {
  return createFilesystemPublicSurfaceScope(repoRoot, {
    id: "custom",
    entrypointRoot: "src/public",
    importPrefix: "fixture-sdk",
  });
}

const fixtureScope = buildFixtureScope();
const publicSurfaceEnvelope = analyzeTopology({
  repoRoot,
  scope: fixtureScope,
  report: "public-surface-usage",
});
const singleOwnerEnvelope = analyzeTopology({
  repoRoot,
  scope: fixtureScope,
  report: "single-owner-shared",
});
const unusedEnvelope = analyzeTopology({
  repoRoot,
  scope: fixtureScope,
  report: "unused-public-surface",
});

describe("ts-topology", () => {
  it("collapses canonical symbols exported by multiple public subpaths", () => {
    const sharedThing = publicSurfaceEnvelope.records.find((record) =>
      record.exportNames.includes("sharedThing"),
    );

    expect(sharedThing).toMatchObject({
      declarationPath: "src/lib/shared.ts",
      declarationLine: 1,
      productionExtensions: ["alpha", "beta"],
      productionPackages: ["src"],
      productionOwners: ["extension:alpha", "extension:beta", "src"],
    });
    expect(sharedThing?.publicSpecifiers).toEqual(["fixture-sdk", "fixture-sdk/extra"]);
  });

  it("counts renamed imports, namespace imports, type-only imports, and test-only consumers", () => {
    const aliasedThing = publicSurfaceEnvelope.records.find((record) =>
      record.exportNames.includes("aliasedThing"),
    );
    const sharedType = publicSurfaceEnvelope.records.find((record) =>
      record.exportNames.includes("SharedType"),
    );
    const testOnlyThing = publicSurfaceEnvelope.records.find((record) =>
      record.exportNames.includes("testOnlyThing"),
    );

    expect(aliasedThing?.productionRefCount).toBe(1);
    expect(sharedType).toMatchObject({
      isTypeOnlyCandidate: true,
      productionExtensions: ["alpha", "beta"],
      productionRefCount: 2,
    });
    expect(testOnlyThing).toMatchObject({
      productionRefCount: 0,
      testRefCount: 1,
      testConsumers: ["tests/public.test.ts"],
    });
  });

  it("surfaces single-owner shared and unused reports correctly", () => {
    expect(singleOwnerEnvelope.records.map((record) => record.exportNames[0])).toContain(
      "singleOwnerHelper",
    );
    expect(singleOwnerEnvelope.records.map((record) => record.exportNames[0])).not.toContain(
      "sharedThing",
    );
    expect(unusedEnvelope.records.map((record) => record.exportNames[0])).toEqual(["unusedThing"]);
  });

  it("renders stable text summaries for the public-surface report", () => {
    expect(renderTextReport({ ...publicSurfaceEnvelope, limit: 3 }, 3)).toMatchInlineSnapshot(`
      "Scope: custom
      Public exports analyzed: 6
      Production-used exports: 4
      Single-owner shared exports: 2
      Unused public exports: 1
      
      Top 2 candidate-to-move exports:
      - fixture-sdk:aliasedThing -> src/lib/shared.ts:9 (prodRefs=1, owners=extension:alpha, sharedness=35, move=85)
      - fixture-sdk:singleOwnerHelper -> src/lib/shared.ts:5 (prodRefs=1, owners=extension:alpha, sharedness=35, move=85)
      
      Top 1 duplicated public exports:
      - fixture-sdk:sharedThing via fixture-sdk, fixture-sdk/extra (src/lib/shared.ts:1)"
    `);
  });

  it("emits stable JSON and filtered report output through the CLI", async () => {
    const captured = createCapturedIo();
    const jsonExit = await main(
      [
        "--scope=custom",
        "--entrypoint-root=src/public",
        "--import-prefix=fixture-sdk",
        "--repo-root=test/fixtures/ts-topology/basic",
        "--report=single-owner-shared",
        "--json",
      ],
      captured.io,
    );

    expect(jsonExit).toBe(0);
    const payload = JSON.parse(captured.readStdout());
    expect(payload.report).toBe("single-owner-shared");
    expect(
      payload.records.map((record: { exportNames: string[] }) => record.exportNames[0]),
    ).toEqual(["aliasedThing", "singleOwnerHelper"]);

    const textCaptured = createCapturedIo();
    const textExit = await main(
      [
        "--scope=custom",
        "--entrypoint-root=src/public",
        "--import-prefix=fixture-sdk",
        "--repo-root=test/fixtures/ts-topology/basic",
        "--report=consumer-topology",
        "--limit=2",
      ],
      textCaptured.io,
    );
    expect(textExit).toBe(0);
    expect(textCaptured.readStdout()).toMatchInlineSnapshot(`
      "Scope: custom
      Records with consumers: 5
      
      Top 2 consumer-topology records:
      - fixture-sdk:sharedThing prod=3 test=0 internal=0
      - fixture-sdk:SharedType prod=2 test=0 internal=0
      "
    `);
  });
});
