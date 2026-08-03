import { describe, expect, it } from "vitest";
import { parseRunArgs } from "../../scripts/lib/plugin-npm-package-manifest.mjs";

const usage =
  "usage: node scripts/lib/plugin-npm-package-manifest.mjs --run <package-dir> -- <command> [args...]";

describe("plugin-npm-package-manifest run args", () => {
  it("parses package-scoped run commands", () => {
    expect(parseRunArgs(["--run", "extensions/slack", "--", "npm", "pack"])).toEqual({
      packageDir: "extensions/slack",
      command: "npm",
      args: ["pack"],
    });
  });

  it("returns help before resolving package dirs", () => {
    expect(parseRunArgs(["--help"])).toEqual({
      help: true,
      packageDir: "",
      command: "",
      args: [],
    });
  });

  it("rejects missing or option-looking package dirs", () => {
    expect(() => parseRunArgs(["--run"])).toThrow(usage);
    expect(() => parseRunArgs(["--run", "--", "npm", "pack"])).toThrow(usage);
    expect(() => parseRunArgs(["--run", "--bad", "--", "npm", "pack"])).toThrow(usage);
  });

  it("rejects unexpected args before the command separator", () => {
    expect(() => parseRunArgs(["--run", "extensions/slack", "extra", "--", "npm"])).toThrow(
      "unexpected plugin npm package manifest run argument: extra",
    );
  });
});
