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
        const interpolated = \`value: \${value}\`;
        const first = value as any;
        const second = <any>value;
        const third = value as /* preserved trivia */ any;
        const fourth = </* preserved trivia */ any>value;
        const fifth = value as // preserved line trivia
          any;
        const typeOnly: any = value;
        // @ts-expect-error invalid contract fixture
        consume({ invalid: true });
      `,
      "src/plain.ts": "export const value = 1;",
    });

    const report = collectTypeSuppressionReport({
      files: ["src/example.ts", "src/plain.ts"],
      repoRoot: fixtureRoot,
    });

    expect(report.summary).toMatchObject({
      findingCount: 6,
      kindCounts: {
        "as-any": 3,
        "expect-error": 1,
        "type-assertion-any": 2,
      },
      scannedFileCount: 2,
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
      "src/plugin-sdk/plugin-entry.reply-trigger.test.ts:8:@ts-expect-error Trigger eligibility is only supported for before_agent_reply.",
      "src/plugin-sdk/plugin-entry.reply-trigger.test.ts:10:@ts-expect-error An empty trigger list cannot prove that a hook is inactive.",
      "src/plugins/contracts/memory-authorization.contract.test.ts:271:@ts-expect-error retrieve only permits broker-internal candidate selection.",
      "src/plugins/contracts/memory-authorization.contract.test.ts:278:@ts-expect-error retrieve only permits broker-internal candidate selection.",
      "src/plugins/contracts/memory-authorization.contract.test.ts:280:@ts-expect-error the context and plan must name the same content operation.",
      "src/plugins/contracts/memory-authorization.contract.test.ts:290:@ts-expect-error retrieve only permits broker-internal candidate selection.",
      "src/plugins/contracts/memory-authorization.contract.test.ts:347:@ts-expect-error retrieve may select candidates only inside the broker.",
      "src/plugins/contracts/memory-authorization.contract.test.ts:353:@ts-expect-error the mutation kind must match the context and plan operation.",
      "src/plugins/contracts/memory-authorization.contract.test.ts:359:@ts-expect-error retrieve may not invoke an import action.",
      "src/plugins/contracts/memory-authorization.contract.test.ts:365:@ts-expect-error retrieve may not invoke a sync action.",
      "src/plugins/contracts/memory-authorization.contract.test.ts:367:@ts-expect-error retrieve may not produce a content-bearing export payload.",
      "src/plugins/contracts/memory-authorization.contract.test.ts:373:@ts-expect-error retrieve may not invoke a status action.",
    ]);
  });
});
