import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import type { Server as HttpsServer } from "node:https";
import { ensureSecretEgressProxyCa, generateLocalProxyLeaf } from "../../proxy-capture/ca.js";

const LEAF_RENEWAL_MARGIN_MS = 60 * 60_000;
const CA_WARNING_MARGIN_MS = 7 * 24 * 60 * 60_000;
const CERTIFICATE_RETRY_MESSAGE =
  "Secret egress proxy could not prepare a TLS certificate. Check Gateway logs, OpenSSL availability, and the system clock, then retry the request.";
const CA_RESTART_MESSAGE =
  "Secret egress proxy CA is expired or not yet valid. Check the system clock, then restart the Gateway to create a new process trust chain.";

export class SecretEgressCertificateError extends Error {}

type CertificateValidity = { notBefore: number; notAfter: number };
export type SecretEgressCertificateStatus = {
  state: "ready" | "degraded";
  caExpiresAt: string;
  failedCertificates: number;
  message?: string;
};
export type SecretEgressTlsContext = {
  get: () => Promise<HttpsServer | undefined>;
  close: () => void;
};

function readValidity(pem: string | Buffer): CertificateValidity {
  const certificate = new X509Certificate(pem);
  return {
    notBefore: certificate.validFromDate.getTime(),
    notAfter: certificate.validToDate.getTime(),
  };
}

function validAt(validity: CertificateValidity, now: number): boolean {
  return validity.notBefore <= now && now < validity.notAfter;
}

/** Owns one process trust chain and the certificate work using its private key. */
export async function createSecretEgressCertificates(certDir: string) {
  const ca = await ensureSecretEgressProxyCa(certDir);
  const caPem = fs.readFileSync(ca.certPath, "utf8");
  const caValidity = readValidity(caPem);
  const caExpiresAt = new Date(caValidity.notAfter).toISOString();
  const preparations = new Set<Promise<HttpsServer | undefined>>();
  let failedCertificates = 0;

  const assertCaValid = () => {
    if (!validAt(caValidity, Date.now())) {
      throw new SecretEgressCertificateError(CA_RESTART_MESSAGE);
    }
  };

  return {
    caCertPath: ca.certPath,
    caPem,
    getStatus: (): SecretEgressCertificateStatus => {
      const now = Date.now();
      const message = !validAt(caValidity, now)
        ? CA_RESTART_MESSAGE
        : failedCertificates > 0
          ? CERTIFICATE_RETRY_MESSAGE
          : caValidity.notAfter - now <= CA_WARNING_MARGIN_MS
            ? "Secret egress proxy CA expires within seven days. Restart the Gateway before expiry to create a new process trust chain."
            : undefined;
      return {
        state: message ? "degraded" : "ready",
        caExpiresAt,
        failedCertificates,
        ...(message ? { message } : {}),
      };
    },
    createContext: (params: {
      hostname: string;
      isActive: () => boolean;
      createServer: (leaf: { cert: Buffer; key: Buffer }) => HttpsServer;
    }): SecretEgressTlsContext => {
      let ready: { server: HttpsServer; validity: CertificateValidity } | undefined;
      let preparation: Promise<HttpsServer | undefined> | undefined;
      let failed = false;
      const setFailed = (value: boolean) => {
        failedCertificates += Number(value) - Number(failed);
        failed = value;
      };
      return {
        get: async () => {
          if (!params.isActive()) {
            return undefined;
          }
          assertCaValid();
          if (preparation) {
            return preparation;
          }
          const now = Date.now();
          if (
            ready &&
            validAt(ready.validity, now) &&
            ready.validity.notAfter - now > LEAF_RENEWAL_MARGIN_MS
          ) {
            return ready.server;
          }
          const pending = generateLocalProxyLeaf({ certDir, ca, hostname: params.hostname })
            .then((leaf) => {
              // Revoked/replaced runs cannot publish a new context after awaited
              // OpenSSL work. Check the clock again too: sleep may span issuance.
              if (!params.isActive()) {
                return undefined;
              }
              assertCaValid();
              const validity = readValidity(leaf.cert);
              if (!validAt(validity, Date.now())) {
                throw new SecretEgressCertificateError(CERTIFICATE_RETRY_MESSAGE);
              }
              if (ready) {
                // Only new handshakes use the replacement; active TLS streams
                // and the registration-bound HTTP listener retain their owner.
                ready.server.setSecureContext(leaf);
                ready.validity = validity;
              } else {
                ready = { server: params.createServer(leaf), validity };
              }
              setFailed(false);
              return ready.server;
            })
            .catch(() => {
              if (!params.isActive()) {
                return undefined;
              }
              setFailed(true);
              // Never expose OpenSSL output, paths, or key material to clients.
              assertCaValid();
              throw new SecretEgressCertificateError(CERTIFICATE_RETRY_MESSAGE);
            });
          preparation = pending;
          preparations.add(pending);
          try {
            return await pending;
          } finally {
            // A failed attempt is not a permanently cached rejection. The next
            // request may retry, without a retry loop or stale-certificate fallback.
            preparation = undefined;
            preparations.delete(pending);
          }
        },
        close: () => {
          setFailed(false);
          ready?.server.close();
        },
      };
    },
    waitForPreparations: () => Promise.allSettled(preparations),
  };
}
