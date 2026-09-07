import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { startSecretEgressProxyServer, type SecretEgressProxyHandle } from "./proxy-server.js";
import { clearSecretEgressProxy, publishSecretEgressProxy } from "./registry.js";

const log = createSubsystemLogger("secrets/egress-proxy");
const SECRET_EGRESS_PROXY_DIR_MODE = 0o700;

function removeProxyDirBestEffort(proxyDir: string): void {
  try {
    fs.rmSync(proxyDir, { recursive: true, force: true });
    fs.rmdirSync(path.dirname(proxyDir));
  } catch {
    // The Gateway-owned CA is already unusable after token and socket teardown.
  }
}

function removeStaleProxyDirs(parentDir: string): void {
  for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith("gateway-")) {
      fs.rmSync(path.join(parentDir, entry.name), { recursive: true, force: true });
    }
  }
}

/** Starts the process-local proxy and registers it as the current Gateway owner. */
export async function startGatewaySecretEgressProxy(params: {
  allowedHosts?: readonly string[];
  bypassHosts?: readonly string[];
}): Promise<SecretEgressProxyHandle> {
  const parentDir = path.join(resolveStateDir(), "secret-egress-proxy");
  fs.mkdirSync(parentDir, { recursive: true, mode: SECRET_EGRESS_PROXY_DIR_MODE });
  fs.chmodSync(parentDir, SECRET_EGRESS_PROXY_DIR_MODE);
  removeStaleProxyDirs(parentDir);
  const proxyDir = fs.mkdtempSync(path.join(parentDir, "gateway-"));
  fs.chmodSync(proxyDir, SECRET_EGRESS_PROXY_DIR_MODE);
  let proxy: SecretEgressProxyHandle | undefined;
  try {
    proxy = await startSecretEgressProxyServer({
      caDir: proxyDir,
      ...(params.allowedHosts !== undefined ? { allowedHosts: params.allowedHosts } : {}),
      ...(params.bypassHosts ? { bypassHosts: params.bypassHosts } : {}),
      onAudit: (event) => {
        if (event.reason === "certificate-error") {
          log.warn(
            "secret egress TLS certificate unavailable; check OpenSSL and the system clock, then retry",
            event,
          );
        } else {
          log.info("secret egress request", event);
        }
      },
    });
    const ownedProxy = proxy;
    const cleanupOnProcessExit = () => removeProxyDirBestEffort(proxyDir);
    process.once("exit", cleanupOnProcessExit);
    const handle: SecretEgressProxyHandle = {
      ...ownedProxy,
      stop: async () => {
        clearSecretEgressProxy(handle);
        process.off("exit", cleanupOnProcessExit);
        try {
          await ownedProxy.stop();
        } finally {
          removeProxyDirBestEffort(proxyDir);
        }
      },
    };
    publishSecretEgressProxy(handle);
    return handle;
  } catch (error) {
    await proxy?.stop().catch(() => undefined);
    removeProxyDirBestEffort(proxyDir);
    throw error;
  }
}
