import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { ensureSecretEgressProxyCa, generateLocalProxyLeaf } from "./ca.js";

const openssl = resolveSystemBin("openssl");
const run = promisify(execFile);
const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

async function verifyLeaf(params: {
  certDir: string;
  ca: { certPath: string; keyPath: string };
}): Promise<void> {
  const leaf = await generateLocalProxyLeaf({
    certDir: params.certDir,
    ca: params.ca,
    hostname: "api.example.com",
  });
  const leafPath = path.join(params.certDir, "verify-leaf.pem");
  await fs.writeFile(leafPath, leaf.cert, { mode: 0o600 });
  const result = await run(
    openssl!,
    ["verify", "-x509_strict", "-CAfile", params.ca.certPath, leafPath],
    { timeout: 10_000 },
  );
  expect(result.stdout).toContain(": OK");
}

describe.runIf(openssl)("local proxy certificate OpenSSL compatibility", () => {
  it("generates a chain accepted by strict verification", async () => {
    const certDir = await tempDirs.make("openclaw-proxy-ca-strict-");
    const ca = await ensureSecretEgressProxyCa(certDir);

    await verifyLeaf({ certDir, ca });
  });

  it("signs a leaf when a retained issuer has no subject key identifier", async () => {
    const certDir = await tempDirs.make("openclaw-proxy-ca-legacy-");
    const ca = {
      certPath: path.join(certDir, "root-ca.pem"),
      keyPath: path.join(certDir, "root-ca-key.pem"),
    };
    const requestPath = path.join(certDir, "legacy-ca.csr");
    const extensionsPath = path.join(certDir, "legacy-ca.ext");
    const opensslVersion = await run(openssl!, ["version"]);
    await fs.writeFile(
      extensionsPath,
      [
        "basicConstraints=critical,CA:TRUE",
        "keyUsage=critical,keyCertSign,cRLSign",
        // OpenSSL 3.2+ adds SKI by default for `x509 -req`; `none` explicitly
        // suppresses it. LibreSSL does not accept `none` and does not add SKI here.
        ...(opensslVersion.stdout.startsWith("OpenSSL ") ? ["subjectKeyIdentifier=none"] : []),
        "",
      ].join("\n"),
    );
    await run(openssl!, [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=Retained Test Proxy",
      "-keyout",
      ca.keyPath,
      "-out",
      requestPath,
    ]);
    await run(openssl!, [
      "x509",
      "-req",
      "-in",
      requestPath,
      "-signkey",
      ca.keyPath,
      "-days",
      "1",
      "-sha256",
      "-extfile",
      extensionsPath,
      "-out",
      ca.certPath,
    ]);
    const issuer = await run(openssl!, ["x509", "-in", ca.certPath, "-noout", "-text"]);
    expect(issuer.stdout).not.toContain("Subject Key Identifier");

    const leaf = await generateLocalProxyLeaf({ certDir, ca, hostname: "api.example.com" });
    const leafPath = path.join(certDir, "legacy-leaf.pem");
    await fs.writeFile(leafPath, leaf.cert, { mode: 0o600 });
    const result = await run(openssl!, ["x509", "-in", leafPath, "-noout", "-text"]);

    expect(result.stdout).toContain("Authority Key Identifier");
  });
});
