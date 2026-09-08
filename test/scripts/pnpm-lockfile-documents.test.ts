import { describe, expect, it } from "vitest";
import { pnpmLockfileDocuments } from "../../scripts/lib/pnpm-lockfile-documents.mjs";

describe("pnpm lockfile document framing", () => {
  const dependencies = "lockfileVersion: '9.0'\nimporters: {}\n";
  const environment =
    "lockfileVersion: '9.0'\nimporters:\n  .:\n    packageManagerDependencies: {}\n";

  it.each(["\n", "\r\n"])("reads upstream framing with %j line endings and a BOM", (newline) => {
    const source = `---\n${environment}\n---\n${dependencies}`;
    expect(pnpmLockfileDocuments(`\uFEFF${source.replaceAll("\n", newline)}`)).toEqual({
      environment,
      dependencies,
    });
    expect(pnpmLockfileDocuments(dependencies.replaceAll("\n", newline))).toEqual({
      environment: null,
      dependencies,
    });
  });

  it.each([
    `---\n${environment}`,
    `${dependencies}\n---\n${environment}`,
    `---\n${environment}\n---\n${dependencies}\n---\n`,
  ])("rejects incomplete or extra documents", (source) => {
    expect(() => pnpmLockfileDocuments(source)).toThrow("pnpm-lock.yaml");
  });
});
