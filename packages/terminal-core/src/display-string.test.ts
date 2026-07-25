// Terminal Core tests cover display-safe path shortening.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { displayString } from "./display-string.js";

function stubHome(home: string, openclawHome = ""): void {
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", "");
  vi.stubEnv("OPENCLAW_HOME", openclawHome);
}

describe("displayString", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shortens whole-value homes and child paths without clipping sibling prefixes", () => {
    const home = path.resolve("test-home", "alice");
    stubHome(home);

    expect(displayString(home)).toBe("~");
    expect(displayString(`${home}/project`)).toBe("~/project");
    expect(displayString(`${home}\\project`)).toBe("~\\project");
    expect(displayString(`Workspace: ${home}/project`)).toBe("Workspace: ~/project");
    expect(displayString(`${home}/one ${home}/two`)).toBe("~/one ~/two");
    expect(displayString(`Home: ${home},`)).toBe("Home: ~,");
    expect(displayString(`(${home})`)).toBe("(~)");
    expect(displayString(`${home}.`)).toBe("~.");

    expect(displayString(`${home}2/project`)).toBe(`${home}2/project`);
    expect(displayString(`${home},backup`)).toBe(`${home},backup`);
    expect(displayString(`${home} backup/project`)).toBe(`${home} backup/project`);
    expect(displayString(`${home}../project`)).toBe(`${home}../project`);
    expect(displayString(`prefix${home}/project`)).toBe(`prefix${home}/project`);
    expect(displayString(`/tmp${home}/project`)).toBe(`/tmp${home}/project`);
  });

  it("uses OPENCLAW_HOME as the display prefix", () => {
    const home = path.resolve("test-home", "alice");
    const openclawHome = path.resolve("test-openclaw-home");
    stubHome(home, openclawHome);

    expect(displayString(openclawHome)).toBe("$OPENCLAW_HOME");
    expect(displayString(`${openclawHome}/state`)).toBe("$OPENCLAW_HOME/state");
    expect(displayString(`${openclawHome}2/state`)).toBe(`${openclawHome}2/state`);
  });
});
