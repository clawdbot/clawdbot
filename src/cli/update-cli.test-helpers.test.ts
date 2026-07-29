// Update CLI test-helper tests cover helper fixtures used by update command tests.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isOwningNpmCommand } from "./update-cli.test-helpers.js";

describe("isOwningNpmCommand", () => {
  it("accepts absolute npm binaries under the owning prefix", () => {
    const prefix = path.join(path.sep, "opt", "homebrew");

    expect(isOwningNpmCommand(path.join(prefix, "bin", "npm"), prefix)).toBe(true);
    expect(isOwningNpmCommand(path.join(prefix, "npm.cmd"), prefix)).toBe(true);
  });

  it("rejects plain npm and paths outside the owning prefix", () => {
    const prefix = path.join(path.sep, "opt", "homebrew");

    expect(isOwningNpmCommand("npm", prefix)).toBe(false);
    expect(isOwningNpmCommand(path.join(path.sep, "usr", "local", "bin", "npm"), prefix)).toBe(
      false,
    );
  });
});
