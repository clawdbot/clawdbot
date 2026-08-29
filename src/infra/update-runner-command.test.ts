// Covers package-update recovery metadata for blocking Doctor and verify.
import { describe, expect, it } from "vitest";
import { PACKAGE_POST_INSTALL_DOCTOR_ADVISORY } from "./update-doctor-result.js";
import { resolvePackageUpdateRecovery } from "./update-runner-command.js";

describe("resolvePackageUpdateRecovery", () => {
  it.each([{ name: "openclaw doctor" }, { name: "acp doctor" }, { name: "global install verify" }])(
    "marks a blocking $name failure unsafe to restart",
    ({ name }) => {
      expect(resolvePackageUpdateRecovery({ name })).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
      });
    },
  );

  it("does not treat an advisory doctor result as unsafe recovery", () => {
    expect(
      resolvePackageUpdateRecovery({
        name: "openclaw doctor",
        advisory: PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
      }),
    ).toBeUndefined();
  });

  it.each([
    { name: "global update" },
    { name: "global install swap" },
    { name: "ui:build (post-doctor repair)" },
  ])("leaves $name failures without recovery metadata", ({ name }) => {
    expect(resolvePackageUpdateRecovery({ name })).toBeUndefined();
  });

  it("leaves a successful package update without recovery metadata", () => {
    expect(resolvePackageUpdateRecovery(null)).toBeUndefined();
  });
});
