import { describe, expect, it } from "vitest";
import {
  mergeProcessEnv,
  resolveDiagnosticProcessEnv,
  resolveEnvironmentValue,
} from "./process-env.js";

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

describe("resolveDiagnosticProcessEnv", () => {
  it("keeps native POSIX routing and known locale categories without arbitrary namespaces", () => {
    const native = {
      PATH: "/fixture/bin",
      Path: "/fixture/fallback",
      HOME: "/fixture/home",
      USER: "fixture",
      LOGNAME: "fixture",
      TMPDIR: "/fixture/tmp",
      LANG: "C",
      LANGUAGE: "en",
      TZ: "UTC",
      LC_ALL: "C",
      LC_CTYPE: "C",
      LC_MESSAGES: "C",
      LC_COLLATE: "C",
      LC_MONETARY: "C",
      LC_NUMERIC: "C",
      LC_TIME: "C",
    };
    const source = Object.freeze({
      ...native,
      path: "/unexpected",
      LC_UNKNOWN_CATEGORY: "synthetic",
      NEUTRAL_FLAG: "synthetic",
      NODE_OPTIONS: "--no-warnings",
      PSModulePath: "/fixture/modules",
      OPENAI_API_KEY: "synthetic",
    });
    expect(resolveDiagnosticProcessEnv(source, "linux")).toEqual(native);
  });

  it("preserves Windows bootstrap, profile, DLL and PowerShell cache routing with source casing", () => {
    const native = {
      Path: "C:\\tools",
      systemRoot: "C:\\Windows",
      windir: "C:\\Windows",
      comSpec: "C:\\Windows\\System32\\cmd.exe",
      pathExt: ".EXE;.COM",
      systemDrive: "C:",
      userProfile: "C:\\Users\\fixture",
      homeDrive: "C:",
      homePath: "\\Users\\fixture",
      userName: "fixture",
      userDomain: "fixture-host",
      temp: "C:\\Temp",
      tmp: "C:\\Temp",
      appData: "C:\\Users\\fixture\\AppData\\Roaming",
      localAppData: "C:\\Users\\fixture\\AppData\\Local",
      programData: "C:\\ProgramData",
      allUsersProfile: "C:\\ProgramData",
      programFiles: "C:\\Program Files",
      "programFiles(x86)": "C:\\Program Files (x86)",
      programW6432: "C:\\Program Files",
      commonProgramFiles: "C:\\Program Files\\Common Files",
      "commonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
      commonProgramW6432: "C:\\Program Files\\Common Files",
      PSModuleAnalysisCachePath: "C:\\Temp\\ModuleAnalysisCache",
    };
    expect(
      resolveDiagnosticProcessEnv(
        {
          ...native,
          PSModulePath: "C:\\ExtraModules",
          OPENCLAW_GATEWAY_TOKEN: "synthetic",
          https_proxy: "http://proxy.invalid",
        },
        "win32",
      ),
    ).toEqual(native);
  });

  it("uses canonical Windows duplicate precedence, including undefined masking", () => {
    expect(
      resolveDiagnosticProcessEnv(
        { path: "lower", Path: "first", temp: "later", TEMP: undefined },
        "win32",
      ),
    ).toEqual({ Path: "first" });
    expect(resolveDiagnosticProcessEnv({ PATH: undefined, Path: "masked" }, "win32")).toEqual({});
  });
});
