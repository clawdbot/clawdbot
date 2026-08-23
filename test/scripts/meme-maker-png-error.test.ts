import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const memeScriptPath = path.resolve(process.cwd(), "skills/meme-maker/scripts/meme.mjs");

describe("meme-maker PNG missing-sharp error text", () => {
  it("directs SVG output and never invites package installs near the skill runner", () => {
    const source = fs.readFileSync(memeScriptPath, "utf8");

    expect(source).toContain("PNG output needs the optional sharp package.");
    expect(source).toContain("Use --out meme.svg instead.");

    // Agents treat install hints literally and can corrupt pnpm workspaces.
    expect(source).not.toMatch(/install\s+sharp/iu);
    expect(source).not.toMatch(/npm\s+install/iu);
    expect(source).not.toMatch(/near the skill runner/iu);
    expect(source).not.toMatch(/install\s+.*\s+near/iu);
  });
});
