// Covers gateway TLS loading, fingerprint reporting, generated certificate
// paths, and error handling for missing or invalid material.
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { normalizeFingerprint } from "./fingerprint.js";

const { resolveSystemBinMock, runExecMock } = vi.hoisted(() => ({
  resolveSystemBinMock: vi.fn(() => "/usr/bin/openssl"),
  runExecMock: vi.fn(),
}));

vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runExec: runExecMock,
}));

vi.mock("../resolve-system-bin.js", () => ({ resolveSystemBin: resolveSystemBinMock }));

import { loadGatewayTlsRuntime } from "./gateway.js";

const tempDirs = createTrackedTempDirs();
const createTempDir = () => tempDirs.make("openclaw-gateway-tls-test-");

function resolveOpenSslOutput(args: string[], flag: "-keyout" | "-out"): string {
  const outputPath = args.at(args.indexOf(flag) + 1);
  if (!outputPath) {
    throw new Error(`missing ${flag} output path`);
  }
  return outputPath;
}

async function writeGeneratedTlsPair(args: string[]): Promise<void> {
  await Promise.all([
    fs.writeFile(resolveOpenSslOutput(args, "-out"), CERT_PEM, "utf8"),
    fs.writeFile(resolveOpenSslOutput(args, "-keyout"), KEY_PEM, "utf8"),
  ]);
}

const KEY_PEM = [
  "-----BEGIN PRIVATE KEY-----", // pragma: allowlist secret
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDrur5CWp4psMMb",
  "DTPY1aN46HPDxRchGgh8XedNkrlc4z1KFiyLUsXpVIhuyoXq1fflpTDz7++pGEDJ",
  "Q5pEdChn3fuWgi7gC+pvd5VQ1eAX/7qVE72fhx14NxhaiZU3hCzXjG2SflTEEExk",
  "UkQTm0rdHSjgLVMhTM3Pqm6Kzfdgtm9ZyXwlAsorE/pvgbUxG3Q4xKNBGzbirZ+1",
  "EzPDwsjf3fitNtakZJkymu6Kg5lsUihQVXOP0U7f989FmevoTMvJmkvJzsoTRd7s",
  "XNSOjzOwJr8da8C4HkXi21md1yEccyW0iSh7tWvDrpWDAgW6RMuMHC0tW4bkpDGr",
  "FpbQOgzVAgMBAAECggEAIMhwf8Ve9CDVTWyNXpU9fgnj2aDOCeg3MGaVzaO/XCPt",
  "KOHDEaAyDnRXYgMP0zwtFNafo3klnSBWmDbq3CTEXseQHtsdfkKh+J0KmrqXxval",
  "YeikKSyvBEIzRJoYMqeS3eo1bddcXgT/Pr9zIL/qzivpPJ4JDttBzyTeaTbiNaR9",
  "KphGNueo+MTQMLreMqw5VAyJ44gy7Z/2TMiMEc/d95wfubcOSsrIfpOKnMvWd/rl",
  "vxIS33s95L7CjREkixskj5Yo5Wpt3Yf5b0Zi70YiEsCfAZUDrPW7YzMlylzmhMzm",
  "MARZKfN1Tmo74SGpxUrBury+iPwf1sYcRnsHR+zO8QKBgQD6ISQHRzPboZ3J/60+",
  "fRLETtrBa9WkvaH9c+woF7l47D4DIlvlv9D3N1KGkUmhMnp2jNKLIlalBNDxBdB+",
  "iwZP1kikGz4629Ch3/KF/VYscLTlAQNPE42jOo7Hj7VrdQx9zQrK9ZBLteXmSvOh",
  "bB3aXwXPF3HoTMt9gQ9thhXZJQKBgQDxQxUnQSw43dRlqYOHzPUEwnJkGkuW/qxn",
  "aRc8eopP5zUaebiDFmqhY36x2Wd+HnXrzufy2o4jkXkWTau8Ns+OLhnIG3PIU9L/",
  "LYzJMckGb75QYiK1YKMUUSQzlNCS8+TFVCTAvG2u2zCCk7oTIe8aT516BQNjWDjK",
  "gWo2f87N8QKBgHoVANO4kfwJxszXyMPuIeHEpwquyijNEap2EPaEldcKXz4CYB4j",
  "4Cc5TkM12F0gGRuRohWcnfOPBTgOYXPSATOoX+4RCe+KaCsJ9gIl4xBvtirrsqS+",
  "42ue4h9O6fpXt9AS6sii0FnTnzEmtgC8l1mE9X3dcJA0I0HPYytOvY0tAoGAAYJj",
  "7Xzw4+IvY/ttgTn9BmyY/ptTgbxSI8t6g7xYhStzH5lHWDqZrCzNLBuqFBXosvL2",
  "bISFgx9z3Hnb6y+EmOUc8C2LyeMMXOBSEygmk827KRGUGgJiwsvHKDN0Ipc4BSwD",
  "ltkW7pMceJSoA1qg/k8lMxA49zQkFtA8c97U0mECgYEAk2DDN78sRQI8RpSECJWy",
  "l1O1ikVUAYVeh5HdZkpt++ddfpo695Op9OeD2Eq27Y5EVj8Xl58GFxNk0egLUnYq",
  "YzSbjcNkR2SbVvuLaV1zlQKm6M5rfvhj4//YrzrrPUQda7Q4eR0as/3q91uzAO2O",
  "++pfnSCVCyp/TxSkhEDEawU=",
  "-----END PRIVATE KEY-----",
].join("\n");

const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUel0Lv05cjrViyI/H3tABBJxM7NgwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDEyMDEyMjEzMloXDTI2MDEy
MTEyMjEzMlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA67q+QlqeKbDDGw0z2NWjeOhzw8UXIRoIfF3nTZK5XOM9
ShYsi1LF6VSIbsqF6tX35aUw8+/vqRhAyUOaRHQoZ937loIu4Avqb3eVUNXgF/+6
lRO9n4cdeDcYWomVN4Qs14xtkn5UxBBMZFJEE5tK3R0o4C1TIUzNz6puis33YLZv
Wcl8JQLKKxP6b4G1MRt0OMSjQRs24q2ftRMzw8LI3934rTbWpGSZMpruioOZbFIo
UFVzj9FO3/fPRZnr6EzLyZpLyc7KE0Xe7FzUjo8zsCa/HWvAuB5F4ttZndchHHMl
tIkoe7Vrw66VgwIFukTLjBwtLVuG5KQxqxaW0DoM1QIDAQABo1MwUTAdBgNVHQ4E
FgQUwNdNkEQtd0n/aofzN7/EeYPPPbIwHwYDVR0jBBgwFoAUwNdNkEQtd0n/aofz
N7/EeYPPPbIwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAnOnw
o8Az/bL0A6bGHTYra3L9ArIIljMajT6KDHxylR4LhliuVNAznnhP3UkcZbUdjqjp
MNOM0lej2pNioondtQdXUskZtqWy6+dLbTm1RYQh1lbCCZQ26o7o/oENzjPksLAb
jRM47DYxRweTyRWQ5t9wvg/xL0Yi1tWq4u4FCNZlBMgdwAEnXNwVWTzRR9RHwy20
lmUzM8uQ/p42bk4EvPEV4PI1h5G0khQ6x9CtkadCTDs/ZqoUaJMwZBIDSrdJJSLw
4Vh8Lqzia1CFB4um9J4S1Gm/VZMBjjeGGBJk7VSYn4ZmhPlbPM+6z39lpQGEG0x4
r1USnb+wUdA7Zoj/mQ==
-----END CERTIFICATE-----`;

afterEach(async () => {
  resolveSystemBinMock.mockClear();
  runExecMock.mockReset();
  await tempDirs.cleanup();
});

describe("loadGatewayTlsRuntime", () => {
  it("disables tls when config is absent or disabled", async () => {
    await expect(loadGatewayTlsRuntime(undefined)).resolves.toEqual({
      enabled: false,
      required: false,
    });
    await expect(loadGatewayTlsRuntime({ enabled: false })).resolves.toEqual({
      enabled: false,
      required: false,
    });
  });

  it("loads existing cert, key, and optional ca files", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    const caPath = path.join(dir, "gateway-ca.pem");
    await fs.writeFile(certPath, CERT_PEM, "utf8");
    await fs.writeFile(keyPath, KEY_PEM, "utf8");
    await fs.writeFile(caPath, CERT_PEM, "utf8");

    const result = await loadGatewayTlsRuntime({
      enabled: true,
      certPath,
      keyPath,
      caPath,
      autoGenerate: false,
    });

    expect(result.enabled).toBe(true);
    expect(result.required).toBe(true);
    expect(result.certPath).toBe(certPath);
    expect(result.keyPath).toBe(keyPath);
    expect(result.caPath).toBe(caPath);
    expect(result.fingerprintSha256).toBe(
      normalizeFingerprint(new X509Certificate(CERT_PEM).fingerprint256 ?? ""),
    );
    expect(result.tlsOptions?.cert).toBe(CERT_PEM);
    expect(result.tlsOptions?.key).toBe(KEY_PEM);
    expect(result.tlsOptions?.ca).toBe(CERT_PEM);
    expect(result.tlsOptions?.minVersion).toBe("TLSv1.3");
    expect(result.error).toBeUndefined();
  });

  it("fails closed when cert/key are missing and auto generation is disabled", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "missing-cert.pem");
    const keyPath = path.join(dir, "missing-key.pem");

    const result = await loadGatewayTlsRuntime({
      enabled: true,
      certPath,
      keyPath,
      autoGenerate: false,
    });

    expect(result.enabled).toBe(false);
    expect(result.required).toBe(true);
    expect(result.certPath).toBe(certPath);
    expect(result.keyPath).toBe(keyPath);
    expect(result.error).toBe("gateway tls: cert/key missing");
  });

  it.each(["key", "cert"] as const)(
    "bounds generation and cleans a partial staged %s",
    async (partialOutput) => {
      const dir = await createTempDir();
      const certPath = path.join(dir, "gateway-cert.pem");
      const keyPath = path.join(dir, "gateway-key.pem");
      runExecMock.mockImplementationOnce(async (_command: string, args: string[]) => {
        const outputPath = resolveOpenSslOutput(args, partialOutput === "key" ? "-keyout" : "-out");
        await fs.writeFile(outputPath, partialOutput === "key" ? KEY_PEM : CERT_PEM, "utf8");
        throw new Error("openssl timed out");
      });

      const result = await loadGatewayTlsRuntime({ enabled: true, certPath, keyPath });

      expect(runExecMock).toHaveBeenCalledOnce();
      const [command, args, options] = runExecMock.mock.calls[0] as [
        string,
        string[],
        { logOutput: boolean; timeoutMs: number },
      ];
      expect(command).toBe("/usr/bin/openssl");
      expect(resolveOpenSslOutput(args, "-keyout")).not.toBe(keyPath);
      expect(resolveOpenSslOutput(args, "-out")).not.toBe(certPath);
      expect(options).toEqual({ logOutput: false, timeoutMs: 30_000 });
      expect(result).toMatchObject({ enabled: false, required: true, certPath, keyPath });
      expect(result.error).toContain("openssl timed out");
      await expect(fs.access(certPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readdir(dir)).resolves.toEqual([]);
    },
  );

  it("validates and publishes a generated pair with private modes", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });

    const result = await loadGatewayTlsRuntime({ enabled: true, certPath, keyPath });

    expect(result.enabled).toBe(true);
    await expect(fs.readFile(certPath, "utf8")).resolves.toBe(CERT_PEM);
    await expect(fs.readFile(keyPath, "utf8")).resolves.toBe(KEY_PEM);
    await expect(fs.readdir(dir).then((entries) => entries.toSorted())).resolves.toEqual([
      "gateway-cert.pem",
      "gateway-key.pem",
    ]);
    if (process.platform !== "win32") {
      expect((await fs.stat(certPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("publishes best-effort and warns once when hard links are unavailable", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    const warn = vi.fn();
    runExecMock.mockImplementation(async (_command: string, args: string[]) => {
      await writeGeneratedTlsPair(args);
    });
    const linkSpy = vi
      .spyOn(fs, "link")
      .mockRejectedValue(Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }));

    let result: Awaited<ReturnType<typeof loadGatewayTlsRuntime>> | undefined;
    try {
      result = await loadGatewayTlsRuntime({ enabled: true, certPath, keyPath }, { warn });
    } finally {
      linkSpy.mockRestore();
    }

    expect(result?.enabled).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[GATEWAY_TLS_DEGRADED]"), {
      event: "gateway.tls.degraded",
      ownerKind: "gateway",
      ownerId: "tls",
      reason: "atomic hard-link publication unavailable",
      state: "best-effort",
    });
    await expect(fs.readFile(certPath, "utf8")).resolves.toBe(CERT_PEM);
    await expect(fs.readFile(keyPath, "utf8")).resolves.toBe(KEY_PEM);
    await expect(fs.readdir(dir).then((entries) => entries.toSorted())).resolves.toEqual([
      "gateway-cert.pem",
      "gateway-key.pem",
    ]);
    if (process.platform !== "win32") {
      expect((await fs.stat(certPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("reports load failures for invalid pem files", async () => {
    const dir = await createTempDir();
    const certPath = path.join(dir, "gateway-cert.pem");
    const keyPath = path.join(dir, "gateway-key.pem");
    await fs.writeFile(certPath, "not a certificate\n", "utf8");
    await fs.writeFile(keyPath, KEY_PEM, "utf8");

    const result = await loadGatewayTlsRuntime({
      enabled: true,
      certPath,
      keyPath,
      autoGenerate: false,
    });

    expect(result.enabled).toBe(false);
    expect(result.required).toBe(true);
    expect(result.certPath).toBe(certPath);
    expect(result.keyPath).toBe(keyPath);
    expect(result.error).toContain("gateway tls: failed to load cert");
  });

  it("falls back to default paths when certPath and keyPath are empty strings", async () => {
    const result = await loadGatewayTlsRuntime({
      enabled: true,
      certPath: "",
      keyPath: "",
      autoGenerate: false,
    });

    // Empty paths must not reach downstream — they must be replaced with defaults.
    expect(result.certPath).toBeTruthy();
    expect(result.certPath).not.toBe("");
    expect(result.keyPath).toBeTruthy();
    expect(result.keyPath).not.toBe("");
  });

  it("falls back to default paths when certPath and keyPath are whitespace-only", async () => {
    const result = await loadGatewayTlsRuntime({
      enabled: true,
      certPath: "   ",
      keyPath: "\t",
      autoGenerate: false,
    });

    expect(result.certPath).toBeTruthy();
    expect(result.certPath).not.toBe("   ");
    expect(result.keyPath).toBeTruthy();
    expect(result.keyPath).not.toBe("\t");
  });

  it("does not fall back for non-empty paths with leading/trailing spaces", async () => {
    const result = await loadGatewayTlsRuntime({
      enabled: true,
      certPath: "  /etc/ssl/cert.pem  ",
      keyPath: "  /etc/ssl/private/server.key  ",
      autoGenerate: false,
    });

    // Non-empty paths are passed through verbatim; resolveUserPath owns
    // normalization (it trims), so they must not fall back to default names.
    expect(result.certPath).not.toContain("gateway-cert.pem");
    expect(result.keyPath).not.toContain("gateway-key.pem");
  });
});
