import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { SecretEgressProxyHandle, SecretEgressSentinelBinding } from "./proxy-server.js";

type SecretEgressProxyRegistryState = { activeProxy?: SecretEgressProxyHandle };
const SECRET_EGRESS_PROXY_REGISTRY_KEY = Symbol.for("openclaw.secretEgressProxy.registry");

function getSecretEgressProxyRegistry(): SecretEgressProxyRegistryState {
  return resolveGlobalSingleton<SecretEgressProxyRegistryState>(
    SECRET_EGRESS_PROXY_REGISTRY_KEY,
    () => ({}),
  );
}

export function publishSecretEgressProxy(proxy: SecretEgressProxyHandle): void {
  const registry = getSecretEgressProxyRegistry();
  if (registry.activeProxy) {
    throw new Error("Secret egress proxy is already active in this process");
  }
  registry.activeProxy = proxy;
}

export function clearSecretEgressProxy(proxy: SecretEgressProxyHandle): void {
  const registry = getSecretEgressProxyRegistry();
  if (registry.activeProxy === proxy) {
    registry.activeProxy = undefined;
  }
}

export function isSecretEgressProxyActive(): boolean {
  return getSecretEgressProxyRegistry().activeProxy !== undefined;
}

/** Reads current certificate health without reloading trust files or starting a proxy. */
export function getSecretEgressCertificateStatus() {
  return getSecretEgressProxyRegistry().activeProxy?.getCertificateStatus();
}

/** Returns the trusted subprocess environment for one exact admitted agent run. */
export function registerSecretEgressProxyRun(
  run: Readonly<{ instanceId: string; runId: string }>,
  bindings: readonly SecretEgressSentinelBinding[],
): Record<string, string> {
  const proxy = getSecretEgressProxyRegistry().activeProxy;
  if (!proxy) {
    throw new Error("Secret egress proxy is not active in this Gateway process");
  }
  return proxy.registerRun(run, bindings);
}
