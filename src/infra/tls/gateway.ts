// Public certificate inspection is read-only; server startup alone provisions TLS material.
import { X509Certificate } from "node:crypto";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeTlsFingerprint } from "../../../packages/gateway-client/src/client-address-utils.js";
import type { GatewayTlsConfig } from "../../config/types.gateway.js";
import { runExec } from "../../process/exec.js";
import { CONFIG_DIR, resolveUserPath, shortenHomeInString } from "../../utils.js";
import { ensureDurableDirectory, publishFileNoClobber } from "../directory-durability.js";
import { sameFileIdentity } from "../fs-safe-advanced.js";
import { canonicalPathFromExistingAncestor, pathExists } from "../fs-safe.js";
import { resolveSystemBin } from "../resolve-system-bin.js";

const GATEWAY_TLS_CERT_GENERATION_TIMEOUT_MS = 30_000;

type GatewayTlsLog = {
  info?: (message: string) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
};

type GatewayTlsDegradation = {
  event: "gateway.tls.degraded";
  ownerKind: "gateway";
  ownerId: "tls";
  reason: "atomic hard-link publication unavailable" | "directory durability unavailable";
  state: "best-effort";
};

function gatewayTlsDegradation(reason: GatewayTlsDegradation["reason"]): GatewayTlsDegradation {
  return {
    event: "gateway.tls.degraded",
    ownerKind: "gateway",
    ownerId: "tls",
    reason,
    state: "best-effort",
  };
}

type PublishedGeneratedTlsOutput = {
  degradationReasons: GatewayTlsDegradation["reason"][];
  identity: Stats;
};

async function publishGeneratedTlsOutput(
  stagedPath: string,
  finalPath: string,
): Promise<PublishedGeneratedTlsOutput> {
  const degradationReasons: GatewayTlsDegradation["reason"][] = [];
  const stagedHandle = await fs.open(stagedPath, "r+");
  let stagedIdentity: Stats;
  try {
    await stagedHandle.sync();
    stagedIdentity = await stagedHandle.stat();
  } finally {
    await stagedHandle.close();
  }
  const publication = await publishFileNoClobber(stagedPath, finalPath, {
    strategy: "link-or-copy",
    durability: "degrade",
  });
  if (publication.method === "exclusive-copy") {
    degradationReasons.push("atomic hard-link publication unavailable");
  }
  if (publication.durability === "degraded") {
    degradationReasons.push("directory durability unavailable");
  }
  const [currentStagedIdentity, currentPublishedIdentity] = await Promise.all([
    fs.lstat(stagedPath),
    fs.lstat(finalPath),
  ]);
  const hardlinkChanged =
    publication.method === "hardlink" && !sameFileIdentity(stagedIdentity, publication.identity);
  if (
    !currentStagedIdentity.isFile() ||
    !currentPublishedIdentity.isFile() ||
    !sameFileIdentity(stagedIdentity, currentStagedIdentity) ||
    !sameFileIdentity(publication.identity, currentPublishedIdentity) ||
    hardlinkChanged
  ) {
    throw new Error(`Generated TLS output changed during publication: ${finalPath}`);
  }
  return { degradationReasons, identity: publication.identity };
}

// Gateway TLS runtime carries loaded cert material plus the normalized SHA-256
// fingerprint advertised to clients.
export type GatewayTlsRuntime = {
  enabled: boolean;
  required: boolean;
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  fingerprintSha256?: string;
  tlsOptions?: tls.TlsOptions;
  error?: string;
};

async function generateSelfSignedCert(params: {
  certPath: string;
  keyPath: string;
  log?: GatewayTlsLog;
}): Promise<void> {
  const certDir = await canonicalPathFromExistingAncestor(path.dirname(params.certPath));
  const keyDir = await canonicalPathFromExistingAncestor(path.dirname(params.keyPath));
  const certDirectory = await ensureDurableDirectory({ directoryPath: certDir });
  const keyDirectory =
    keyDir === certDir ? certDirectory : await ensureDurableDirectory({ directoryPath: keyDir });
  const opensslBin = resolveSystemBin("openssl");
  if (!opensslBin) {
    throw new Error(
      "openssl not found in trusted system directories. Install it in an OS-managed location.",
    );
  }
  const certStageDir = await fs.mkdtemp(path.join(certDir, ".openclaw-gateway-tls-cert-"));
  const stagedCertPath = path.join(certStageDir, "cert.pem");
  let keyStageDir: string | undefined;
  try {
    keyStageDir = await fs.mkdtemp(path.join(keyDir, ".openclaw-gateway-tls-key-"));
    const stagedKeyPath = path.join(keyStageDir, "key.pem");
    await Promise.all([fs.chmod(certStageDir, 0o700), fs.chmod(keyStageDir, 0o700)]);
    // OpenSSL never sees the configured final paths, so timeout and generation
    // failures cannot strand a half-written certificate pair there.
    await runExec(
      opensslBin,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-days",
        "3650",
        "-nodes",
        "-keyout",
        stagedKeyPath,
        "-out",
        stagedCertPath,
        "-subj",
        "/CN=openclaw-gateway",
      ],
      {
        logOutput: false,
        timeoutMs: GATEWAY_TLS_CERT_GENERATION_TIMEOUT_MS,
      },
    );
    await Promise.all([fs.chmod(stagedKeyPath, 0o600), fs.chmod(stagedCertPath, 0o600)]);
    const [cert, key] = await Promise.all([
      fs.readFile(stagedCertPath, "utf8"),
      fs.readFile(stagedKeyPath, "utf8"),
    ]);
    tls.createSecureContext({ cert, key, minVersion: "TLSv1.3" });
    const degradationReasons = new Set<GatewayTlsDegradation["reason"]>();
    if (
      certDirectory.parentSync.status === "unsupported" ||
      keyDirectory.parentSync.status === "unsupported"
    ) {
      degradationReasons.add("directory durability unavailable");
    }
    const certPublication = await publishGeneratedTlsOutput(
      stagedCertPath,
      path.join(certDirectory.path, path.basename(params.certPath)),
    );
    certPublication.degradationReasons.forEach((reason) => degradationReasons.add(reason));
    // Preserve the published certificate on key failure: conditional pathname removal is not atomic.
    const keyPublication = await publishGeneratedTlsOutput(
      stagedKeyPath,
      path.join(keyDirectory.path, path.basename(params.keyPath)),
    );
    keyPublication.degradationReasons.forEach((reason) => degradationReasons.add(reason));
    for (const reason of degradationReasons) {
      const degradation = gatewayTlsDegradation(reason);
      params.log?.warn?.(
        `[GATEWAY_TLS_DEGRADED] best-effort gateway:tls: ${degradation.reason}.`,
        degradation,
      );
    }
    params.log?.info?.(
      `gateway tls: generated self-signed cert at ${shortenHomeInString(params.certPath)}`,
    );
  } finally {
    await Promise.allSettled(
      [certStageDir, keyStageDir]
        .filter((dir): dir is string => Boolean(dir))
        .map((dir) => fs.rm(dir, { force: true, recursive: true })),
    );
  }
}

function resolveGatewayTlsCertPath(certPath: string | undefined): string {
  // Blank paths use the default; resolveUserPath owns trimming and home expansion.
  return resolveUserPath(
    typeof certPath === "string" && certPath.trim()
      ? certPath
      : path.join(CONFIG_DIR, "gateway", "tls", "gateway-cert.pem"),
  );
}

/** Read only public certificate bytes. Inspection never provisions or requires server secrets. */
export async function inspectGatewayTlsCertificate(
  cfg: Pick<GatewayTlsConfig, "enabled" | "certPath"> | undefined,
): Promise<Result<{ cert: string; fingerprintSha256: string }, string>> {
  if (cfg?.enabled !== true) {
    return err("gateway tls is disabled");
  }
  try {
    const cert = await fs.readFile(resolveGatewayTlsCertPath(cfg.certPath), "utf8");
    const fingerprintSha256 = normalizeTlsFingerprint(new X509Certificate(cert).fingerprint256);
    return fingerprintSha256
      ? ok({ cert, fingerprintSha256 })
      : err("gateway tls: unable to compute certificate fingerprint");
  } catch (error) {
    return err(`gateway tls: failed to load cert (${String(error)})`);
  }
}

/** Server startup only: load or provision TLS material and return listener options. */
export async function loadGatewayTlsServerRuntime(
  cfg: GatewayTlsConfig | undefined,
  log?: GatewayTlsLog,
): Promise<GatewayTlsRuntime> {
  if (!cfg || cfg.enabled !== true) {
    return { enabled: false, required: false };
  }

  const autoGenerate = cfg.autoGenerate !== false;
  const baseDir = path.join(CONFIG_DIR, "gateway", "tls");
  // Only blank/whitespace values fall back to the default. Any non-empty path is
  // passed through verbatim so resolveUserPath owns all normalization (it trims
  // and expands ~); trimming here would duplicate it and silently rewrite paths
  // that contain leading/trailing spaces.
  const certPath = resolveGatewayTlsCertPath(cfg.certPath);
  const keyPath = resolveUserPath(
    typeof cfg.keyPath === "string" && cfg.keyPath.trim()
      ? cfg.keyPath
      : path.join(baseDir, "gateway-key.pem"),
  );
  const caPath = cfg.caPath ? resolveUserPath(cfg.caPath) : undefined;

  const hasCert = await pathExists(certPath);
  const hasKey = await pathExists(keyPath);

  if (!hasCert && !hasKey && autoGenerate) {
    try {
      await generateSelfSignedCert({ certPath, keyPath, log });
    } catch (error) {
      return {
        enabled: false,
        required: true,
        certPath,
        keyPath,
        error: `gateway tls: failed to generate cert (${String(error)})`,
      };
    }
  }

  if (!(await pathExists(certPath)) || !(await pathExists(keyPath))) {
    return {
      enabled: false,
      required: true,
      certPath,
      keyPath,
      error: "gateway tls: cert/key missing",
    };
  }

  try {
    const cert = await fs.readFile(certPath, "utf8");
    const key = await fs.readFile(keyPath, "utf8");
    const ca = caPath ? await fs.readFile(caPath, "utf8") : undefined;
    const x509 = new X509Certificate(cert);
    const fingerprintSha256 = normalizeTlsFingerprint(x509.fingerprint256 ?? "");

    if (!fingerprintSha256) {
      return {
        enabled: false,
        required: true,
        certPath,
        keyPath,
        caPath,
        error: "gateway tls: unable to compute certificate fingerprint",
      };
    }

    return {
      enabled: true,
      required: true,
      certPath,
      keyPath,
      caPath,
      fingerprintSha256,
      tlsOptions: {
        cert,
        key,
        ca,
        minVersion: "TLSv1.3",
      },
    };
  } catch (error) {
    return {
      enabled: false,
      required: true,
      certPath,
      keyPath,
      caPath,
      error: `gateway tls: failed to load cert (${String(error)})`,
    };
  }
}
