import { describe, expect, it } from "vitest";
import {
  collectFipsEvidence,
  createFipsReport,
  evaluateFipsChecks,
  formatFipsReport,
} from "../../scripts/security/fips-check.mjs";

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    platform: "linux",
    arch: "x64",
    hostname: "gateway",
    node: {
      version: "v24.18.0",
      openSslVersion: "3.5.5",
      fipsEnabled: true,
    },
    activation: {
      enableFipsFlag: false,
      forceFipsFlag: true,
      opensslConfig: true,
      opensslModules: true,
    },
    kernelIndicator: "1",
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
        { name: "sha384", ok: true },
        { name: "sha512", ok: true },
        { name: "hmac-sha256", ok: true },
        { name: "aes-256-gcm", ok: true },
        { name: "ecdh-prime256v1", ok: true },
        { name: "ecdh-secp384r1", ok: true },
        { name: "random-bytes", ok: true },
      ],
      tls13: { name: "tls13", ok: true },
      md4Available: false,
      ed25519: { name: "ed25519", ok: false, error: "unsupported" },
    },
    ...overrides,
  };
}

describe("fips-check", () => {
  it("passes required checks when Node FIPS mode is active", () => {
    const report = createFipsReport(evidence(), Date.UTC(2026, 6, 30));

    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
    expect(report.kind).toBe("openclaw-fips-runtime-report");
  });

  it.each([
    {
      label: "NODE_OPTIONS equals syntax",
      env: { NODE_OPTIONS: "--openssl-config=/approved/node.cnf" },
      execArgv: [],
    },
    {
      label: "NODE_OPTIONS split syntax",
      env: { NODE_OPTIONS: "--openssl-config /approved/node.cnf" },
      execArgv: [],
    },
    {
      label: "NODE_OPTIONS underscore syntax",
      env: { NODE_OPTIONS: "--openssl_config=/approved/node.cnf" },
      execArgv: [],
    },
    {
      label: "execArgv equals syntax",
      env: {},
      execArgv: ["--openssl-config=/approved/node.cnf"],
    },
    {
      label: "execArgv split syntax",
      env: {},
      execArgv: ["--openssl-config", "/approved/node.cnf"],
    },
    {
      label: "execArgv underscore syntax",
      env: {},
      execArgv: ["--openssl_config=/approved/node.cnf"],
    },
  ])("records OpenSSL config supplied through $label", ({ env, execArgv }) => {
    const collected = collectFipsEvidence({
      env,
      execArgv,
      fsImpl: {
        readFileSync() {
          throw new Error("not available");
        },
      },
      execFileSyncImpl: () => "OpenSSL 3.5.5",
      hostname: "gateway",
    });

    expect(collected.activation.opensslConfig).toBe(true);
  });

  it("does not match an OpenSSL option inside another quoted NODE_OPTIONS value", () => {
    const collected = collectFipsEvidence({
      env: {
        NODE_OPTIONS: '--title="gateway --openssl-config=/approved/node.cnf"',
      },
      execArgv: [],
      fsImpl: {
        readFileSync() {
          throw new Error("not available");
        },
      },
      execFileSyncImpl: () => "OpenSSL 3.5.5",
      hostname: "gateway",
    });

    expect(collected.activation.opensslConfig).toBe(false);
  });

  it("fails closed when Node is not in FIPS mode", () => {
    const report = createFipsReport(
      evidence({
        node: {
          version: "v24.18.0",
          openSslVersion: "3.5.5",
          fipsEnabled: false,
        },
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "runtime.node_fips_enabled", status: "fail" }),
        expect.objectContaining({ id: "runtime.fips_activation", status: "warn" }),
      ]),
    );
  });

  it("does not require a host kernel indicator inside containers", () => {
    const report = createFipsReport(evidence({ kernelIndicator: null }));

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "runtime.kernel_fips_indicator",
          required: false,
          status: "skip",
        }),
      ]),
    );
  });

  it("fails when Node is below the supported runtime floor", () => {
    const checks = evaluateFipsChecks(
      evidence({
        node: {
          version: "v24.14.0",
          openSslVersion: "3.5.5",
          fipsEnabled: true,
        },
      }),
    );

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "runtime.node_supported_version", status: "fail" }),
      ]),
    );
  });

  it("fails when an enumerated primitive cannot be executed", () => {
    const checks = evaluateFipsChecks(
      evidence({
        crypto: {
          ...evidence().crypto,
          primitiveProbes: evidence().crypto.primitiveProbes.map((entry) =>
            entry.name === "ecdh-secp384r1"
              ? {
                  name: "ecdh-secp384r1",
                  ok: false,
                  error: "provider rejected operation",
                }
              : entry,
          ),
        },
      }),
    );

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "crypto.required_primitives",
          status: "fail",
          detail: "missing or failed: ecdh-secp384r1",
        }),
      ]),
    );
  });

  it("treats legacy and outside-boundary algorithms as inventory warnings", () => {
    const report = createFipsReport(
      evidence({
        crypto: {
          ...evidence().crypto,
          md4Available: true,
          ed25519: { name: "ed25519", ok: true },
        },
      }),
    );

    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "crypto.legacy_md4_unavailable", status: "warn" }),
        expect.objectContaining({ id: "inventory.ed25519", status: "warn" }),
      ]),
    );
  });

  it("keeps stable machine-readable ids in text output", () => {
    const output = formatFipsReport(createFipsReport(evidence(), Date.UTC(2026, 6, 30)));

    expect(output).toContain("[PASS] runtime.node_fips_enabled");
    expect(output).toContain("[PASS] crypto.tls13_secure_context");
    expect(output).toContain("not a FIPS validation or certification");
  });
});
