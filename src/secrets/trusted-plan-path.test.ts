import { describe, expect, it } from "vitest";
import { trustedPlanPathPolicy as testing } from "./trusted-plan-path-policy.js";

describe("trusted plan path", () => {
  it("requires verified Windows ownership", () => {
    expect(testing.isTrustedOwner({}, { ownerTrusted: true }, "win32")).toBe(true);
    expect(testing.isTrustedOwner({}, { ownerTrusted: false }, "win32")).toBe(false);
    expect(testing.isTrustedOwner({}, {}, "win32")).toBe(false);
  });

  it("accepts the well-known Windows TrustedInstaller owner", () => {
    const permissions = {
      ownerTrusted: false,
      ownerSid: "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
    };
    expect(testing.isTrustedOwner({}, permissions, "win32", true)).toBe(true);
    expect(testing.isTrustedOwner({}, permissions, "win32")).toBe(false);
  });

  it("accepts only additive, read-only, or inherit-only untrusted directory rights", () => {
    expect(
      testing.isSafeWindowsDirectoryAclEntries([
        { rawRights: "(OI)(CI)(RX)" },
        { rawRights: "(CI)(AD)" },
        { rawRights: "(CI)(IO)(WD)" },
        { rawRights: "(OI)(CI)(IO)(F)" },
      ]),
    ).toBe(true);
    expect(
      testing.isSafeWindowsDirectoryAclEntries([
        { rawRights: "(I)(CI)(WD,AD)" },
        { rawRights: "(I)(GR,GE)" },
      ]),
    ).toBe(true);
    expect(testing.isSafeWindowsDirectoryAclEntries([])).toBe(true);
    expect(testing.isSafeWindowsDirectoryAclEntries([{ rawRights: "(M)" }])).toBe(false);
    expect(testing.isSafeWindowsDirectoryAclEntries([{ rawRights: "unknown" }])).toBe(false);
  });

  it("rejects child creation rights beside the executable", () => {
    expect(testing.isSafeWindowsDirectoryAclEntries([{ rawRights: "(RX)" }], false)).toBe(true);
    expect(testing.isSafeWindowsDirectoryAclEntries([{ rawRights: "(CI)(AD)" }], false)).toBe(
      false,
    );
    expect(testing.isSafeWindowsDirectoryAclEntries([{ rawRights: "(CI)(WD)" }], false)).toBe(
      false,
    );
    expect(testing.isSafeWindowsDirectoryAclEntries([{ rawRights: "(CI)(IO)(WD)" }], false)).toBe(
      true,
    );
  });

  it("uses the verified fs-safe ACL summary for Windows directory rights", () => {
    expect(testing.isSafeWindowsDirectoryAclSummary("trusted-only")).toBe(true);
    expect(
      testing.isSafeWindowsDirectoryAclSummary(
        "BUILTIN\\Users:(RX), CREATOR OWNER:(OI)(CI)(IO)(F)",
      ),
    ).toBe(true);
    expect(testing.isSafeWindowsDirectoryAclSummary("BUILTIN\\Users:(M)")).toBe(false);
    expect(testing.isSafeWindowsDirectoryAclSummary("BUILTIN\\Users:unknown")).toBe(false);
    expect(testing.isSafeWindowsDirectoryAclSummary(undefined)).toBe(false);
  });

  it.runIf(typeof process.getuid === "function")(
    "accepts only the current POSIX uid or root",
    () => {
      const uid = process.getuid?.() ?? 1;
      expect(testing.isTrustedOwner({ uid }, {}, "linux")).toBe(true);
      expect(testing.isTrustedOwner({ uid: 0 }, {}, "linux")).toBe(true);
      expect(testing.isTrustedOwner({ uid: uid + 1 }, {}, "linux")).toBe(false);
    },
  );
});
