// Covers the Windows ACL remediation facade used by security fixes.
import { describe, expect, it } from "vitest";
import { createIcaclsResetCommand, formatIcaclsResetCommand } from "./windows-acl.js";

const DEFAULT_ICACLS = "C:\\Windows\\System32\\icacls.exe";

describe("windows ACL remediation", () => {
  it("builds a file reset command for the current principal and SYSTEM", () => {
    const command = createIcaclsResetCommand("C:\\test\\file.txt", {
      isDir: false,
      env: {
        SystemRoot: "C:\\Windows",
        USERNAME: "TestUser",
        USERDOMAIN: "WORKGROUP",
      },
    });

    expect(command).toMatchObject({
      command: DEFAULT_ICACLS,
      args: [
        "C:\\test\\file.txt",
        "/inheritance:r",
        "/grant:r",
        "WORKGROUP\\TestUser:F",
        "/grant:r",
        "*S-1-5-18:F",
      ],
    });
  });

  it("adds inheritance flags for directory remediation", () => {
    const display = formatIcaclsResetCommand("C:\\test\\dir", {
      isDir: true,
      env: { SystemRoot: "C:\\Windows", USERNAME: "TestUser" },
    });

    expect(display).toContain("(OI)(CI)F");
    expect(display).toContain("*S-1-5-18:(OI)(CI)F");
  });

  it("uses a validated SystemRoot for the executable", () => {
    const command = createIcaclsResetCommand("C:\\test\\file.txt", {
      isDir: false,
      env: { SystemRoot: "D:\\Windows", USERNAME: "TestUser" },
    });

    expect(command?.command).toBe("D:\\Windows\\System32\\icacls.exe");
  });

  it("returns null when no user principal can be resolved", () => {
    const command = createIcaclsResetCommand("C:\\test\\file.txt", {
      isDir: false,
      env: { USERNAME: "", USERDOMAIN: "" },
      userInfo: () => ({ username: "" }),
    });

    expect(command).toBeNull();
  });
});
