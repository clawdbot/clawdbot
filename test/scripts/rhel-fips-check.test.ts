import { describe, expect, it } from "vitest";
import {
  createRhelFipsReport,
  evaluateRhelFipsChecks,
  formatRhelFipsReport,
} from "../../scripts/compliance/rhel-fips-check.mjs";

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    platform: "linux",
    arch: "x64",
    hostname: "gateway",
    osRelease: {
      ID: "rhel",
      VERSION_ID: "9.8",
      PRETTY_NAME: "Red Hat Enterprise Linux 9.8",
    },
    node: {
      version: "v24.18.0",
      openSslVersion: "3.5.5",
      sharedOpenSsl: true,
      sqliteAvailable: true,
      sqliteError: "",
    },
    fips: {
      kernelIndicator: "1",
      systemMarkerPresent: true,
      nodeEnabled: true,
    },
    openSslCli: {
      ok: true,
      version: "OpenSSL 3.5.5",
      error: "",
    },
    crypto: {
      hashes: ["sha256", "sha384", "sha512"],
      ciphers: ["aes-256-gcm"],
      curves: ["prime256v1", "secp384r1"],
      primitiveProbes: [
        { name: "sha256", ok: true },
        { name: "hmac-sha256", ok: true },
        { name: "aes-256-gcm", ok: true },
        { name: "random-bytes", ok: true },
      ],
      tls13: { name: "tls13", ok: true },
      md4Available: false,
      ed25519: { name: "ed25519", ok: false, error: "unsupported" },
    },
    ...overrides,
  };
}

describe("rhel-fips-check", () => {
  it("passes required checks for a Red Hat FIPS runtime", () => {
    const report = createRhelFipsReport(evidence(), Date.UTC(2026, 6, 29));

    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
    expect(report.checks.find((entry) => entry.id === "compat.openclaw_ed25519")).toMatchObject({
      required: false,
      status: "warn",
    });
  });

  it("fails closed when the host and Node are not in FIPS mode", () => {
    const nonFipsEvidence = evidence({
      fips: {
        kernelIndicator: "0",
        systemMarkerPresent: false,
        nodeEnabled: false,
      },
    });
    const checks = evaluateRhelFipsChecks(nonFipsEvidence);
    const report = createRhelFipsReport(nonFipsEvidence);

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "runtime.kernel_fips_enabled", status: "fail" }),
        expect.objectContaining({ id: "runtime.node_fips_enabled", status: "fail" }),
      ]),
    );
    expect(report.ok).toBe(false);
  });

  it("uses Node FIPS state when a container cannot read the host kernel indicator", () => {
    const containerEvidence = evidence({
      fips: {
        kernelIndicator: undefined,
        systemMarkerPresent: true,
        nodeEnabled: true,
      },
    });
    const report = createRhelFipsReport(containerEvidence);

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "runtime.kernel_fips_enabled", status: "skip" }),
        expect.objectContaining({ id: "runtime.node_fips_enabled", status: "pass" }),
      ]),
    );
  });

  it("fails when Node is below the supported runtime floor", () => {
    const oldNodeEvidence = evidence({
      node: {
        version: "v24.14.0",
        openSslVersion: "3.5.5",
        sharedOpenSsl: true,
        sqliteAvailable: true,
        sqliteError: "",
      },
    });

    expect(evaluateRhelFipsChecks(oldNodeEvidence)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "runtime.node_supported_version", status: "fail" }),
      ]),
    );
  });

  it("fails when the RHEL release predates the supported profile", () => {
    const oldRhelEvidence = evidence({
      osRelease: {
        ID: "rhel",
        VERSION_ID: "9.6",
        PRETTY_NAME: "Red Hat Enterprise Linux 9.6",
      },
    });

    expect(evaluateRhelFipsChecks(oldRhelEvidence)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "runtime.red_hat_enterprise_linux",
          status: "fail",
        }),
      ]),
    );
  });

  it("does not apply the RHEL 9 AppStream profile to RHEL 10", () => {
    const rhel10Evidence = evidence({
      osRelease: {
        ID: "rhel",
        VERSION_ID: "10.0",
        PRETTY_NAME: "Red Hat Enterprise Linux 10.0",
      },
    });

    expect(evaluateRhelFipsChecks(rhel10Evidence)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "runtime.red_hat_enterprise_linux",
          status: "fail",
        }),
      ]),
    );
  });

  it("keeps machine-readable ids in text output", () => {
    const report = createRhelFipsReport(evidence(), Date.UTC(2026, 6, 29));
    const output = formatRhelFipsReport(report);

    expect(output).toContain("[PASS] runtime.node_shared_openssl");
    expect(output).toContain("[WARN] compat.openclaw_ed25519");
    expect(output).toContain("not a FIPS 140 validation or FedRAMP authorization");
  });
});
