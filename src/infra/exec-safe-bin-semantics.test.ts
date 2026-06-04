// Tests safe executable detection for shell command approval.
import { describe, expect, it } from "vitest";
import {
  listRiskyConfiguredSafeBins,
  validateSafeBinSemantics,
} from "./exec-safe-bin-semantics.js";

describe("exec safe-bin semantics", () => {
  it("rejects awk and sed variants even when configured via path-like entries", () => {
    expect(
      validateSafeBinSemantics({
        binName: "/opt/homebrew/bin/gawk",
        positional: ['BEGIN { system("id") }'],
      }),
    ).toBe(false);
    expect(
      validateSafeBinSemantics({
        binName: "C:\\Tools\\mawk.exe",
        positional: ['BEGIN { print ENVIRON["HOME"] }'],
      }),
    ).toBe(false);
    expect(
      validateSafeBinSemantics({
        binName: "nawk",
        positional: ['BEGIN { print "hi" > "/tmp/out" }'],
      }),
    ).toBe(false);
    expect(
      validateSafeBinSemantics({
        binName: "/usr/local/bin/gsed",
        positional: ["e"],
      }),
    ).toBe(false);
  });

  it("reports normalized risky configured safe bins once per executable family member", () => {
    expect(
      listRiskyConfiguredSafeBins([
        " Awk ",
        "/opt/homebrew/bin/gawk",
        "C:\\Tools\\mawk.exe",
        "nawk",
        "sed",
        "/usr/local/bin/gsed",
        "jq",
        "jq",
      ]),
    ).toEqual([
      {
        bin: "awk",
        warning:
          "awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
      {
        bin: "gawk",
        warning:
          "awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
      {
        bin: "gsed",
        warning:
          "sed scripts can execute commands and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
      {
        bin: "jq",
        warning:
          "jq supports broad jq programs and builtins (for example `env`), so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
      {
        bin: "mawk",
        warning:
          "awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
      {
        bin: "nawk",
        warning:
          "awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
      {
        bin: "sed",
        warning:
          "sed scripts can execute commands and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.",
      },
    ]);
  });
});
