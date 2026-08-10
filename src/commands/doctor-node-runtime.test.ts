// Tests for the Node.js runtime Doctor health contribution.
//
// Redaction scenarios (POSIX/Windows home boundaries, case-insensitivity)
// are intentionally NOT tested here: path redaction moved to the shared
// shortenHomePath helper (#121455) which carries its own regression tests.
// This file covers version-manager detection, diagnostics collection,
// lifecycle warnings, and the two summary forms (default without the
// executable path, verbose-style with it).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildNodeRuntimeSummary,
  buildNodeRuntimeWarnings,
  collectNodeRuntimeDiagnostics,
  detectVersionManagerName,
  type NodeRuntimeDiagnostics,
} from "./doctor-node-runtime.js";

/** Convenience factory for diagnostics fixtures. */
function makeDiag(overrides: Partial<NodeRuntimeDiagnostics> = {}): NodeRuntimeDiagnostics {
  return {
    version: "24.14.0",
    major: 24,
    execPath: "/usr/bin/node",
    versionManaged: false,
    versionManagerHint: null,
    ...overrides,
  };
}

describe("detectVersionManagerName", () => {
  it("returns null for empty environment and null path", () => {
    expect(detectVersionManagerName({}, null)).toBe(null);
  });

  it("returns null for a plain system install path", () => {
    expect(detectVersionManagerName({}, "/usr/bin/node")).toBe(null);
  });

  it("detects nvm via NVM_DIR", () => {
    expect(detectVersionManagerName({ NVM_DIR: "/home/test/.nvm" }, "/usr/bin/node")).toBe("nvm");
  });

  it("detects nvm via execPath", () => {
    expect(
      detectVersionManagerName({}, "/home/test/.nvm/versions/node/v24.14.0/bin/node"),
    ).toBe("nvm");
  });

  it("detects fnm via execPath", () => {
    expect(
      detectVersionManagerName(
        {},
        "/home/test/.local/share/fnm/node-versions/v24.14.0/installation/bin/node",
      ),
    ).toBe("fnm");
  });

  it("detects volta via execPath", () => {
    expect(
      detectVersionManagerName({}, "/home/test/.volta/tools/image/node/24.14.0/bin/node"),
    ).toBe("volta");
  });

  it("detects asdf via execPath", () => {
    expect(
      detectVersionManagerName({}, "/home/test/.asdf/installs/nodejs/24.14.0/bin/node"),
    ).toBe("asdf");
  });

  it("detects n via execPath", () => {
    expect(detectVersionManagerName({}, "/usr/local/n/versions/node/24.14.0/bin/node")).toBe("n");
  });

  it("detects nodenv via execPath", () => {
    expect(detectVersionManagerName({}, "/home/test/.nodenv/versions/24.14.0/bin/node")).toBe(
      "nodenv",
    );
  });

  it("detects nodebrew via execPath", () => {
    expect(detectVersionManagerName({}, "/home/test/.nodebrew/node/v24.14.0/bin/node")).toBe(
      "nodebrew",
    );
  });

  it("detects nvs via execPath", () => {
    expect(detectVersionManagerName({}, "/home/test/.nvs/node/24.14.0/x64/bin/node")).toBe("nvs");
  });

  it("detects managers on Windows-style backslash paths regardless of casing", () => {
    expect(
      detectVersionManagerName({}, "C:\\Users\\Test\\.NVM\\versions\\node\\v24.14.0\\node.exe"),
    ).toBe("nvm");
    expect(
      detectVersionManagerName(
        {},
        "c:\\users\\test\\.volta\\tools\\image\\node\\24.14.0\\node.exe",
      ),
    ).toBe("volta");
  });
});

describe("collectNodeRuntimeDiagnostics", () => {
  it("collects an nvm-managed runtime", () => {
    const diag = collectNodeRuntimeDiagnostics(
      {},
      "/home/test/.nvm/versions/node/v24.14.0/bin/node",
      "v24.14.0",
    );
    expect(diag.version).toBe("24.14.0");
    expect(diag.major).toBe(24);
    expect(diag.versionManaged).toBe(true);
    expect(diag.versionManagerHint).toBe("nvm");
  });

  it("degrades gracefully for an unknown runtime shape", () => {
    const diag = collectNodeRuntimeDiagnostics({}, null, null);
    expect(diag.version).toBe(null);
    expect(diag.major).toBe(null);
    expect(diag.execPath).toBe(null);
    expect(diag.versionManaged).toBe(false);
    expect(diag.versionManagerHint).toBe(null);
  });

  it("collects a system install runtime", () => {
    const diag = collectNodeRuntimeDiagnostics({}, "/usr/bin/node", "v24.14.0");
    expect(diag.versionManaged).toBe(false);
    expect(diag.versionManagerHint).toBe(null);
    expect(diag.execPath).toBe("/usr/bin/node");
  });
});

describe("buildNodeRuntimeWarnings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Fixed reference date: Node 24 is current and not yet in maintenance;
    // Node 22 is in maintenance; Node 20 and Node 25 are past EOL.
    vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns no warnings for the recommended current version", () => {
    expect(buildNodeRuntimeWarnings(makeDiag({ version: "24.14.0", major: 24 }))).toEqual([]);
  });

  it("warns when the version is below the minimum requirement", () => {
    const warnings = buildNodeRuntimeWarnings(makeDiag({ version: "20.18.0", major: 20 }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("does not meet the minimum requirement");
    expect(warnings[0]).toContain(">=22.19.0");
  });

  it("warns when the release is past end-of-life", () => {
    // Node 25 (odd, non-LTS) reached EOL 2026-06-01 and satisfies the minimum.
    const warnings = buildNodeRuntimeWarnings(makeDiag({ version: "25.6.1", major: 25 }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("end-of-life");
    expect(warnings[0]).toContain("Node 24");
  });

  it("warns when the release is in maintenance mode", () => {
    const warnings = buildNodeRuntimeWarnings(makeDiag({ version: "22.19.0", major: 22 }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("maintenance mode");
    expect(warnings[0]).toContain("EOL 2027-04-30");
  });

  it("nudges toward the recommended LTS for supported majors not yet in maintenance", () => {
    // At an earlier reference date Node 22 has not entered maintenance yet
    // (maintenanceStart 2025-10-21), is LTS, and is older than the
    // recommended major, so the gentle nudge fires.
    vi.setSystemTime(new Date("2025-09-01T00:00:00Z"));
    const warnings = buildNodeRuntimeWarnings(makeDiag({ version: "22.19.0", major: 22 }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("older than the recommended LTS");
    expect(warnings[0]).toContain("Node 24");
  });

  it("returns no warnings when the version is missing", () => {
    expect(buildNodeRuntimeWarnings(makeDiag({ version: null, major: null }))).toEqual([]);
  });

  it("returns no warnings for an unknown future major", () => {
    expect(buildNodeRuntimeWarnings(makeDiag({ version: "99.0.0", major: 99 }))).toEqual([]);
  });

  it("prioritizes the below-minimum warning over lifecycle warnings", () => {
    // Node 20 is both below minimum and past EOL; only the minimum warning
    // should surface (it already forces an upgrade).
    const warnings = buildNodeRuntimeWarnings(makeDiag({ version: "20.18.0", major: 20 }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("minimum requirement");
    expect(warnings[0]).not.toContain("end-of-life");
  });
});

describe("buildNodeRuntimeSummary", () => {
  it("renders version and channel only by default (no executable path)", () => {
    const summary = buildNodeRuntimeSummary(
      makeDiag({
        execPath: "/home/test/.nvm/versions/node/v24.14.0/bin/node",
        versionManaged: true,
        versionManagerHint: "nvm",
      }),
    );
    expect(summary).toBe("Node 24.14.0 \u00b7 via nvm");
    expect(summary).not.toContain("/home/test");
    expect(summary).not.toContain(".nvm");
  });

  it("renders a system install without a path by default", () => {
    expect(buildNodeRuntimeSummary(makeDiag())).toBe("Node 24.14.0 \u00b7 system install");
  });

  it("includes the executable path when includeExecPath is set", () => {
    const summary = buildNodeRuntimeSummary(
      makeDiag({
        execPath: "/opt/node/bin/node",
        versionManaged: true,
        versionManagerHint: "volta",
      }),
      { includeExecPath: true },
    );
    expect(summary).toContain("/opt/node/bin/node");
    expect(summary).toContain("via volta");
  });

  it("labels a version-managed runtime without a hint generically", () => {
    const summary = buildNodeRuntimeSummary(
      makeDiag({ versionManaged: true, versionManagerHint: null }),
    );
    expect(summary).toBe("Node 24.14.0 \u00b7 version-managed");
  });

  it("degrades gracefully when the version is unknown", () => {
    const summary = buildNodeRuntimeSummary(makeDiag({ version: null }));
    expect(summary).toBe("Node (version unknown) \u00b7 system install");
  });

  it("uses the interpunct separator between segments", () => {
    const summary = buildNodeRuntimeSummary(makeDiag(), { includeExecPath: true });
    const segments = summary.split(" \u00b7 ");
    expect(segments).toHaveLength(3);
    expect(segments[0]).toBe("Node 24.14.0");
    expect(segments[2]).toBe("system install");
  });
});
