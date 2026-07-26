import { describe, expect, it } from "vitest";
import type { OwnerAndDaclResult, WindowsAccessControlEntry } from "../infra/permissions.js";
import { assertTrustedWindowsAcl } from "./local-repository.js";

const CURRENT_USER_SID = "S-1-5-21-1000";

type SupportedOwnerAndDaclResult = Extract<OwnerAndDaclResult, { status: "supported" }>;

function ace(
  sid: string,
  mask: number,
  options: { type?: "allow" | "deny"; inheritOnly?: boolean } = {},
): WindowsAccessControlEntry {
  return {
    sid,
    mask,
    aceType: options.type ?? "allow",
    flags: {
      raw: options.inheritOnly ? 0x08 : 0,
      objectInherit: false,
      containerInherit: false,
      noPropagateInherit: false,
      inheritOnly: options.inheritOnly ?? false,
      inherited: false,
      successfulAccess: false,
      failedAccess: false,
    },
  };
}

function facts(
  aces: WindowsAccessControlEntry[],
  ownerSid = CURRENT_USER_SID,
): SupportedOwnerAndDaclResult {
  return {
    status: "supported",
    ownerSid,
    currentUserSid: CURRENT_USER_SID,
    daclPresent: true,
    isLocal: true,
    complete: true,
    unsupportedAceTypes: [],
    aces,
  };
}

describe("Windows snapshot ACL policy", () => {
  it("trusts current-user and system principals case-insensitively", () => {
    expect(() =>
      assertTrustedWindowsAcl(
        "C:\\private",
        true,
        CURRENT_USER_SID,
        facts(
          [
            ace(CURRENT_USER_SID.toLowerCase(), 0x10000000),
            ace("S-1-5-18", 0x10000000),
            ace("S-1-5-32-544", 0x10000000),
            ace("S-1-3-0", 0x10000000),
          ],
          "s-1-5-18",
        ),
      ),
    ).not.toThrow();
  });

  it("ignores inherit-only untrusted ACEs on ancestors but rejects them on private roots", () => {
    const security = facts([
      ace(CURRENT_USER_SID, 0x10000000),
      ace("S-1-1-0", 0x10000000, { inheritOnly: true }),
    ]);

    expect(() =>
      assertTrustedWindowsAcl("C:\\ancestor", false, CURRENT_USER_SID, security),
    ).not.toThrow();
    expect(() => assertTrustedWindowsAcl("C:\\private", true, CURRENT_USER_SID, security)).toThrow(
      /permits untrusted SQLite staging access/u,
    );
  });

  it("preserves the private-vs-ancestor rights distinction", () => {
    const writeData = facts([ace(CURRENT_USER_SID, 0x10000000), ace("S-1-1-0", 0x000002)]);
    expect(() =>
      assertTrustedWindowsAcl("C:\\ancestor", false, CURRENT_USER_SID, writeData),
    ).not.toThrow();
    expect(() => assertTrustedWindowsAcl("C:\\private", true, CURRENT_USER_SID, writeData)).toThrow(
      /permits untrusted SQLite staging access/u,
    );

    const deleteChild = facts([ace(CURRENT_USER_SID, 0x10000000), ace("S-1-1-0", 0x000040)]);
    expect(() =>
      assertTrustedWindowsAcl("C:\\ancestor", false, CURRENT_USER_SID, deleteChild),
    ).toThrow(/permits untrusted SQLite staging access/u);
  });

  it("ignores deny ACEs and synchronization-only access as before", () => {
    const security = facts([
      ace(CURRENT_USER_SID, 0x10000000),
      ace("S-1-1-0", 0xffffffff, { type: "deny" }),
      ace("S-1-1-0", 0x00100000),
    ]);

    expect(() =>
      assertTrustedWindowsAcl("C:\\private", true, CURRENT_USER_SID, security),
    ).not.toThrow();
  });
});
