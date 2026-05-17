import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchesExecAllowlistPattern } from "./exec-allowlist-pattern.js";

describe("matchesExecAllowlistPattern", () => {
  it.each([
    { pattern: "", target: "/tmp/tool", expected: false },
    { pattern: "   ", target: "/tmp/tool", expected: false },
    { pattern: "/tmp/tool", target: "/tmp/tool", expected: true },
  ])("handles literal patterns for %j", ({ pattern, target, expected }) => {
    expect(matchesExecAllowlistPattern(pattern, target)).toBe(expected);
  });

  it("does not let ? cross path separators", () => {
    expect(matchesExecAllowlistPattern("/tmp/a?b", "/tmp/a/b")).toBe(false);
    expect(matchesExecAllowlistPattern("/tmp/a?b", "/tmp/acb")).toBe(true);
  });

  it.each([
    { pattern: "/tmp/*/tool", target: "/tmp/a/tool", expected: true },
    { pattern: "/tmp/*/tool", target: "/tmp/a/b/tool", expected: false },
    { pattern: "/tmp/**/tool", target: "/tmp/a/b/tool", expected: true },
  ])("handles star patterns for %j", ({ pattern, target, expected }) => {
    expect(matchesExecAllowlistPattern(pattern, target)).toBe(expected);
  });

  it.runIf(process.platform !== "win32")(
    "matches wildcard paths after collapsing dot segments",
    () => {
      expect(matchesExecAllowlistPattern("/usr/bin/**", "/usr/bin/../../bin/sh")).toBe(false);
      expect(
        matchesExecAllowlistPattern("/trusted/tools/**", "/trusted/tools/../../etc/shadow"),
      ).toBe(false);
      expect(matchesExecAllowlistPattern("/usr/bin/**", "../../etc/shadow")).toBe(false);
      expect(matchesExecAllowlistPattern("/usr/bin/**", "/usr/bin/./env")).toBe(true);
      expect(matchesExecAllowlistPattern("/usr/bin/**", "/usr/./bin/./env")).toBe(true);
      expect(matchesExecAllowlistPattern("/usr/bin/**", "/usr/bin/sub/../env")).toBe(true);
      expect(matchesExecAllowlistPattern("/usr/bin/*", "/usr/bin/sub/../env")).toBe(true);
      expect(matchesExecAllowlistPattern("/usr/bin/**", "/usr/bin/sub/tool")).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps wildcard dot-segment matches inside the declared POSIX root",
    () => {
      const bases = ["/usr/bin", "/opt/tools", "/srv/bin"] as const;
      for (const base of bases) {
        const pattern = `${base}/**`;
        expect(matchesExecAllowlistPattern(pattern, `${base}/inside/file`)).toBe(true);
        expect(matchesExecAllowlistPattern(pattern, `${base}/sub/../inside`)).toBe(true);
        expect(matchesExecAllowlistPattern(pattern, `${base}/../escape`)).toBe(false);
        expect(matchesExecAllowlistPattern(pattern, `${base}/sub/../../escape`)).toBe(false);
      }
    },
  );

  it("expands home-prefix patterns", () => {
    const prevOpenClawHome = process.env.OPENCLAW_HOME;
    const prevHome = process.env.HOME;
    process.env.OPENCLAW_HOME = "/srv/openclaw-home";
    process.env.HOME = "/home/other";
    const openClawHome = path.join(path.resolve("/srv/openclaw-home"), "bin", "tool");
    const fallbackHome = path.join(path.resolve("/home/other"), "bin", "tool");
    try {
      expect(matchesExecAllowlistPattern("~/bin/tool", openClawHome)).toBe(true);
      expect(matchesExecAllowlistPattern("~/bin/tool", fallbackHome)).toBe(false);
    } finally {
      if (prevOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = prevOpenClawHome;
      }
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
    }
  });

  it.runIf(process.platform !== "win32")("preserves case sensitivity on POSIX", () => {
    expect(matchesExecAllowlistPattern("/tmp/Allowed-Tool", "/tmp/allowed-tool")).toBe(false);
    expect(matchesExecAllowlistPattern("/tmp/Allowed-Tool", "/tmp/Allowed-Tool")).toBe(true);
  });

  it.runIf(process.platform === "win32")("preserves case-insensitive matching on Windows", () => {
    expect(matchesExecAllowlistPattern("C:/Tools/Allowed-Tool", "c:/tools/allowed-tool")).toBe(
      true,
    );
  });

  it.runIf(process.platform === "win32")(
    "matches Windows wildcard paths after collapsing dot segments",
    () => {
      expect(
        matchesExecAllowlistPattern("C:/Tools/**", "C:/Tools/../../Windows/System32/cmd.exe"),
      ).toBe(false);
      expect(matchesExecAllowlistPattern("C:/Tools/**", String.raw`..\..\Windows\cmd.exe`)).toBe(
        false,
      );
      expect(matchesExecAllowlistPattern("C:/Tools/**", "C:/Tools/bin/../runner.exe")).toBe(true);
    },
  );
});
