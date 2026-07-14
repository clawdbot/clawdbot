// Type Suppression Inventory tests cover AST detection and the repository suppression ratchet.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectTypeSuppressionReport } from "../../scripts/type-suppression-inventory.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

function createFixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-type-suppressions-"));
  temporaryDirectories.push(root);
  for (const [relativePath, source] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, source);
  }
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("type suppression inventory", () => {
  it("detects syntax suppressions without counting prose", () => {
    const fixtureRoot = createFixture({
      "src/example.ts": `
        const prose = "as any and @ts-expect-error";
        const first = value as any;
        const second = <any>value;
        // @ts-expect-error invalid contract fixture
        consume({ invalid: true });
      `,
    });

    const report = collectTypeSuppressionReport({
      files: ["src/example.ts"],
      repoRoot: fixtureRoot,
    });

    expect(report.summary).toMatchObject({
      findingCount: 3,
      kindCounts: {
        "as-any": 1,
        "expect-error": 1,
        "type-assertion-any": 1,
      },
      touchedFileCount: 1,
    });
  });

  it("keeps unchecked any casts at zero and negative type assertions explicit", () => {
    const report = collectTypeSuppressionReport({ repoRoot });

    expect(report.summary.kindCounts["as-any"]).toBe(0);
    expect(report.summary.kindCounts["type-assertion-any"]).toBe(0);
    expect(
      report.findings
        .filter((finding) => finding.kind === "expect-error")
        .map((finding) => `${finding.file}:${finding.line}:${finding.excerpt}`),
    ).toEqual([
      "src/infra/kysely-sync.types.test.ts:49:@ts-expect-error Kysely checks selected column string literals.",
      "src/infra/kysely-sync.types.test.ts:52:@ts-expect-error Kysely checks table string literals.",
      "src/infra/kysely-sync.types.test.ts:55:@ts-expect-error Kysely checks where-reference string literals.",
      "src/infra/kysely-sync.types.test.ts:58:@ts-expect-error Kysely checks grouped column string literals.",
      "src/infra/kysely-sync.types.test.ts:61:@ts-expect-error Kysely checks order references and selected aliases.",
    ]);
  });
});
