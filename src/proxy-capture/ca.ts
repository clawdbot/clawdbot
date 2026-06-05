// Proxy capture CA helpers create and inspect local capture CA certificates.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";

const execFileAsync = promisify(execFile);

// Ensure a short-lived root CA for local MITM debug proxy runs. Existing certs
// are reused within the cert dir so repeated starts do not prompt regeneration.
export async function ensureDebugProxyCa(certDir: string): Promise<{
  certPath: string;
  keyPath: string;
}> {
  fs.mkdirSync(certDir, { recursive: true });
  const certPath = path.join(certDir, "root-ca.pem");
  const keyPath = path.join(certDir, "root-ca-key.pem");
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { certPath, keyPath };
  }
  const openssl = resolveSystemBin("openssl");
  if (!openssl) {
    throw new Error("openssl is required to generate debug proxy certificates");
  }
  await execFileAsync(openssl, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    "7",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=OpenClaw Debug Proxy",
  ]);
  return { certPath, keyPath };
}
