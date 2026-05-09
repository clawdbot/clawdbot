import { describe, expect, it } from "vitest";
import { mockNodeBuiltinModule } from "./node-builtin-mocks.js";

describe("mockNodeBuiltinModule", () => {
  it("merges partial overrides into the original module", async () => {
    const actual = { readFileSync: () => "actual", watch: () => "watch" };
    const readFileSync = () => "mock";

    const mocked = await mockNodeBuiltinModule(async () => actual, {
      readFileSync,
    });

    expect(mocked.readFileSync).toBe(readFileSync);
    expect(mocked.watch).toBe(actual.watch);
    expect("default" in mocked).toBe(false);
  });

  it("mirrors overrides into the default export when requested", async () => {
    const tmpdir = () => "/tmp";
    const homedir = () => "/tmp/home";

    const mocked = await mockNodeBuiltinModule<{
      tmpdir: () => string;
      homedir?: () => string;
      default?: Record<string, unknown>;
    }>(async () => ({ tmpdir }), { homedir }, { mirrorToDefault: true });

    expect(mocked.default?.homedir).toBe(homedir);
    expect(mocked.default?.tmpdir).toBe(tmpdir);
  });

  it("preserves existing default exports while overriding members", async () => {
    const actual = {
      readFileSync: () => "actual",
      default: {
        readFileSync: () => "actual",
        statSync: () => "stat",
      },
    };
    const readFileSync = () => "mock";

    const mocked = await mockNodeBuiltinModule(
      async () => actual,
      { readFileSync },
      { mirrorToDefault: true },
    );

    expect(mocked.default?.readFileSync).toBe(readFileSync);
    expect(mocked.default?.statSync).toBe(actual.default.statSync);
  });
});
