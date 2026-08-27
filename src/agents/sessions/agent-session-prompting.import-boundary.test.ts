// Import-boundary test: agent-session-prompting must not statically import
// from the session loader, which pulls in the workshop curator and SQLite
// runtime.  The bounded skill reader lives in a separate dependency-light
// leaf module shared by both discovery and prompt-expansion callers.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("agent-session-prompting import boundary", () => {
  const promptingSource = readSource("src/agents/sessions/agent-session-prompting.ts");

  it("imports readBoundedSkillFile from the leaf module, not the session loader", () => {
    // Must use the lightweight leaf module — not session.js which transitively
    // loads workshop/curator, SQLite state, ignore rules, skill-contract, etc.
    expect(promptingSource).not.toMatch(
      /import\s+\{[^}]*readBoundedSkillFile[^}]*\}\s+from\s+["'][^"']*session\.js["']/,
    );
    expect(promptingSource).toContain(
      'import { readBoundedSkillFile } from "../../skills/loading/bounded-skill-read.js"',
    );
  });

  it("does not pull in workshop curator, SQLite runtime, or ignore-rules", () => {
    expect(promptingSource).not.toMatch(/from\s+["'][^"']*workshop\/curator/);
    expect(promptingSource).not.toMatch(/from\s+["'][^"']*sqlite/);
    expect(promptingSource).not.toMatch(/from\s+["'][^"']*shared\/ignore-rules/);
    expect(promptingSource).not.toMatch(/from\s+["'][^"']*skill-contract/);
  });

  it("bounded-skill-read leaf module has no session-loader or workshop deps", () => {
    const leafSource = readSource("src/skills/loading/bounded-skill-read.ts");
    expect(leafSource).not.toMatch(/from\s+["'][^"']*session\.js/);
    expect(leafSource).not.toMatch(/from\s+["'][^"']*workshop/);
    expect(leafSource).not.toMatch(/from\s+["'][^"']*sqlite/);
    expect(leafSource).not.toMatch(/from\s+["'][^"']*ignore-rules/);
    expect(leafSource).not.toMatch(/from\s+["'][^"']*curator/);
    expect(leafSource).not.toMatch(/from\s+["'][^"']*skill-contract/);
    // Only allowed heavy import is the boundary-file-read infra module.
    expect(leafSource).toContain("boundary-file-read.js");
  });
});
