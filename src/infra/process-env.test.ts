import { describe, expect, it } from "vitest";
import { mergeProcessEnv, resolveEnvironmentValue } from "./process-env.js";

describe("resolveEnvironmentValue", () => {
  it("preserves exact POSIX keys and the existing Path fallback", () => {
    const env = { PATH: "exact", Path: "fallback", path: "lowercase" };

    expect(resolveEnvironmentValue(env, "PATH", "linux")).toBe("exact");
    expect(resolveEnvironmentValue({ Path: "fallback" }, "PATH", "linux")).toBe("fallback");
    expect(resolveEnvironmentValue({ path: "lowercase" }, "PATH", "linux")).toBeUndefined();
  });

  it("reads arbitrary Windows key casing with child_process precedence", () => {
    const env = { path: "lowercase", Path: "lexical-first", pAtHeXt: ".MiXeD" };

    expect(resolveEnvironmentValue(env, "PATH", "win32")).toBe("lexical-first");
    expect(resolveEnvironmentValue(env, "PATHEXT", "win32")).toBe(".MiXeD");
  });

  it("does not fall through a lexically preferred undefined Windows key", () => {
    expect(
      resolveEnvironmentValue({ PATH: undefined, Path: "later" }, "PATH", "win32"),
    ).toBeUndefined();
  });
});

describe("mergeProcessEnv", () => {
  it("lets later Windows sources override inherited keys regardless of case", () => {
    expect(
      mergeProcessEnv([{ TEMP: "inherited", HOME: "base" }, { temp: "configured" }], "win32"),
    ).toEqual({ HOME: "base", temp: "configured" });
  });

  it("keeps Node's lexicographically first Windows duplicate within one source", () => {
    expect(mergeProcessEnv([{ temp: "lower", Temp: "first" }], "win32")).toEqual({
      Temp: "first",
    });
  });

  it("removes inherited Windows keys with a case-insensitive undefined override", () => {
    expect(mergeProcessEnv([{ Path: "C:\\base" }, { PATH: undefined }], "win32")).toEqual({});
  });

  it("preserves case-distinct POSIX keys", () => {
    expect(mergeProcessEnv([{ Path: "/base" }, { PATH: "/override" }], "linux")).toEqual({
      Path: "/base",
      PATH: "/override",
    });
  });
});
