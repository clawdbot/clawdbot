import { describe, expect, it } from "vitest";
import {
  inspectHostExecEnvOverrides,
  sanitizeHostExecEnvWithDiagnostics,
  sanitizeSystemRunEnvOverrides,
  withHostExecInheritedEnvOmitted,
} from "./host-env-security.js";

describe("host no-pager overrides", () => {
  it.each(["cat", ""])("normalizes exact %j to non-executable empty pager overrides", (value) => {
    const overrides = { GIT_PAGER: value, PAGER: value };
    const result = sanitizeHostExecEnvWithDiagnostics({
      baseEnv: { GIT_PAGER: "less", PAGER: "less", PATH: "/trusted/bin" },
      overrides,
    });
    expect(result.rejectedOverrideBlockedKeys).toEqual([]);
    expect(result.rejectedOverrideInvalidKeys).toEqual([]);
    expect(result.env).toMatchObject({ GIT_PAGER: "", PAGER: "", PATH: "/trusted/bin" });
    expect(inspectHostExecEnvOverrides({ overrides }).rejectedOverrideBlockedKeys).toEqual([]);
    expect(sanitizeSystemRunEnvOverrides({ overrides, shellWrapper: true })).toEqual({
      GIT_PAGER: "",
      PAGER: "",
    });
    expect(overrides).toEqual({ GIT_PAGER: value, PAGER: value });
  });

  it.each([
    "less",
    "/bin/cat",
    "./cat",
    "CAT",
    " cat",
    "cat ",
    "cat\n",
    "\t",
    "cat -u",
    "cat; id",
    "$(id)",
    "cat|sh",
  ])("rejects executable and near-miss pager value %j", (value) => {
    const overrides = { GIT_PAGER: value, PAGER: value, MANPAGER: value };
    const result = sanitizeHostExecEnvWithDiagnostics({ baseEnv: {}, overrides });
    expect(result.rejectedOverrideBlockedKeys).toEqual(["GIT_PAGER", "MANPAGER", "PAGER"]);
    expect(result.env).not.toHaveProperty("GIT_PAGER");
    expect(result.env).not.toHaveProperty("PAGER");
    expect(sanitizeSystemRunEnvOverrides({ overrides, shellWrapper: true })).toBeUndefined();
  });

  it("retains key normalization, scoped omission, and unrelated denials", () => {
    const result = sanitizeHostExecEnvWithDiagnostics({
      baseEnv: {},
      overrides: {
        " git_pager ": "cat",
        PaGeR: "",
        MANPAGER: "cat",
        PATH: "cat",
        LD_PRELOAD: "",
        "BAD-KEY": "cat",
      },
    });
    expect(result.env).toMatchObject({ git_pager: "", PaGeR: "" });
    expect(result.rejectedOverrideBlockedKeys).toEqual(["LD_PRELOAD", "MANPAGER", "PATH"]);
    expect(result.rejectedOverrideInvalidKeys).toEqual(["BAD-KEY"]);
    const omitted = withHostExecInheritedEnvOmitted(["GIT_PAGER", "PAGER"], () =>
      sanitizeHostExecEnvWithDiagnostics({
        baseEnv: {},
        overrides: { GIT_PAGER: "cat", PAGER: "" },
      }),
    );
    expect(omitted.rejectedOverrideBlockedKeys).toEqual(["GIT_PAGER", "PAGER"]);
  });
});
