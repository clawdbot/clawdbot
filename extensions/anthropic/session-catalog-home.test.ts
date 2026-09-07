import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveClaudeCatalogHomeDir } from "./session-catalog-home.js";

describe("resolveClaudeCatalogHomeDir", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "prefers and trims HOME",
      env: { HOME: " /home/primary ", USERPROFILE: " /home/secondary " },
      expected: "/home/primary",
    },
    {
      name: "falls through a blank HOME",
      env: { HOME: " ", USERPROFILE: " /home/secondary " },
      expected: "/home/secondary",
    },
    {
      name: "trims USERPROFILE",
      env: { USERPROFILE: " C:\\Users\\claude " },
      expected: "C:\\Users\\claude",
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveClaudeCatalogHomeDir(env)).toBe(expected);
  });

  it("evaluates the fallback at call time when both variables are absent or blank", () => {
    vi.spyOn(os, "homedir").mockReturnValueOnce("/home/first").mockReturnValueOnce("/home/second");

    expect(resolveClaudeCatalogHomeDir({})).toBe("/home/first");
    expect(resolveClaudeCatalogHomeDir({ HOME: "", USERPROFILE: " " })).toBe("/home/second");
  });

  it("does not evaluate the fallback when an explicit home is available", () => {
    const homedir = vi.spyOn(os, "homedir");

    expect(resolveClaudeCatalogHomeDir({ HOME: " /home/explicit " })).toBe("/home/explicit");
    expect(resolveClaudeCatalogHomeDir({ HOME: " ", USERPROFILE: " C:\\Users\\explicit " })).toBe(
      "C:\\Users\\explicit",
    );
    expect(homedir).not.toHaveBeenCalled();
  });
});
