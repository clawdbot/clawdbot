import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TYPES_PATH = fileURLToPath(new URL("./types.ts", import.meta.url));

const concreteRuntimePolicyImportPatterns = [
  /from\s+["'][^"']*auto-reply(?:\/|\.js|["'])/,
  /from\s+["'](?:[^"']*\/)?config(?:\/|\.js|["'])/,
  /from\s+["'](?:[^"']*\/)?plugins(?:\/|\.js|["'])/,
  /from\s+["'][^"']*pi-embedded-/,
  /from\s+["'][^"']*transcript-policy(?:\.[^/"']+)?(?:\/|\.js|["'])/,
  /from\s+["'][^"']*system-prompt(?:\.[^/"']+)?(?:\/|\.js|["'])/,
];

describe("AgentRuntimePlan leaf contracts", () => {
  it("keeps runtime plan type contracts independent from concrete runtime policy modules", async () => {
    const source = await fs.readFile(TYPES_PATH, "utf8");

    for (const pattern of concreteRuntimePolicyImportPatterns) {
      expect(source).not.toMatch(pattern);
    }
  });

  it("guards against policy type imports re-entering the leaf contract", () => {
    const forbiddenImports = [
      'import type { PromptContribution } from "../system-prompt.types.js";',
      'import type { TranscriptPolicy } from "../transcript-policy.types.js";',
    ];

    for (const importStatement of forbiddenImports) {
      expect(
        concreteRuntimePolicyImportPatterns.some((pattern) => pattern.test(importStatement)),
      ).toBe(true);
    }
  });
});
