// Proxy capture CA helpers create and inspect local capture CA certificates.
import { createPrivateKey, X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type FileLockOptions, withFileLock } from "../infra/file-lock.js";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { runExec } from "../process/exec.js";

const DEBUG_PROXY_CA_GENERATION_TIMEOUT_MS = 30_000;
const DEBUG_PROXY_CA_OPENSSL_CONFIG = [
  "[req]",
  "distinguished_name = subject",
  "prompt = no",
  "",
  "[subject]",
  "CN = OpenClaw Debug Proxy",
  "",
  "[v3_ca]",
  "basicConstraints = critical, CA:TRUE",
  "keyUsage = critical, keyCertSign, cRLSign",
  "",
].join("\n");
const DEBUG_PROXY_CA_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    // About 36s of minimum backoff covers one full 30s OpenSSL deadline.
    retries: 80,
    factor: 1.3,
    minTimeout: 25,
    maxTimeout: 500,
    randomize: true,
  },
  stale: 60_000,
  staleRecovery: "remove-if-unchanged",
};
const debugProxyCaGenerationQueue = new KeyedAsyncQueue();

function isValidDebugProxyCaPair(certPath: string, keyPath: string): boolean {
  try {
    const certStat = fs.lstatSync(certPath);
    const keyStat = fs.lstatSync(keyPath);
    if (!certStat.isFile() || !keyStat.isFile() || certStat.size === 0 || keyStat.size === 0) {
      return false;
    }
    const cert = new X509Certificate(fs.readFileSync(certPath));
    const key = createPrivateKey(fs.readFileSync(keyPath));
    return cert.ca && cert.checkPrivateKey(key);
  } catch {
    return false;
  }
}

function removeStagingDirBestEffort(stagingDir: string): void {
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    // Cleanup failure must not replace a successful publication result.
  }
}

// Ensure a short-lived root CA for local MITM debug proxy runs. Existing certs
// are reused within the cert dir so repeated starts do not prompt regeneration.
export async function ensureDebugProxyCa(certDir: string): Promise<{
  certPath: string;
  keyPath: string;
}> {
  fs.mkdirSync(certDir, { recursive: true });
  const certPath = path.join(certDir, "root-ca.pem");
  const keyPath = path.join(certDir, "root-ca-key.pem");
  const canonicalKeyPath = path.join(fs.realpathSync(certDir), "root-ca-key.pem");
  return await debugProxyCaGenerationQueue.enqueue(canonicalKeyPath, async () =>
    withFileLock(canonicalKeyPath, DEBUG_PROXY_CA_LOCK_OPTIONS, async () => {
      if (isValidDebugProxyCaPair(certPath, keyPath)) {
        return { certPath, keyPath };
      }
      const openssl = resolveSystemBin("openssl");
      if (!openssl) {
        throw new Error("openssl is required to generate debug proxy certificates");
      }
      const stagingDir = fs.mkdtempSync(path.join(certDir, ".root-ca-"));
      const stagedConfigPath = path.join(stagingDir, "openssl.cnf");
      const stagedCertPath = path.join(stagingDir, "root-ca.pem");
      const stagedKeyPath = path.join(stagingDir, "root-ca-key.pem");
      try {
        fs.writeFileSync(stagedConfigPath, DEBUG_PROXY_CA_OPENSSL_CONFIG, { mode: 0o600 });
        await runExec(
          openssl,
          [
            "req",
            "-config",
            stagedConfigPath,
            "-extensions",
            "v3_ca",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-sha256",
            "-days",
            "7",
            "-nodes",
            "-keyout",
            stagedKeyPath,
            "-out",
            stagedCertPath,
          ],
          { logOutput: false, timeoutMs: DEBUG_PROXY_CA_GENERATION_TIMEOUT_MS },
        );
        if (!isValidDebugProxyCaPair(stagedCertPath, stagedKeyPath)) {
          throw new Error("openssl generated invalid debug proxy certificate material");
        }
        fs.chmodSync(stagedKeyPath, 0o600);
        fs.chmodSync(stagedCertPath, 0o644);
        // All OpenClaw writers hold this lock. Same-directory renames replace each
        // file atomically; validation repairs a pair interrupted between renames.
        fs.renameSync(stagedKeyPath, keyPath);
        fs.renameSync(stagedCertPath, certPath);
        return { certPath, keyPath };
      } finally {
        removeStagingDirBestEffort(stagingDir);
      }
    }),
  );
}
