import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";
import type { ManagedProxyTlsOptions } from "./proxy-tls.js";

export type ActiveManagedProxyUrl = Readonly<URL>;

/** Managed proxy loopback behavior shared by gateway and child-process fetch paths. */
export type ActiveManagedProxyLoopbackMode = NonNullable<NonNullable<ProxyConfig>["loopbackMode"]>;

/** Ref-counted active proxy handle; callers must stop it when their proxy scope ends. */
export type ActiveManagedProxyRegistration = {
  proxyUrl: ActiveManagedProxyUrl;
  loopbackMode: ActiveManagedProxyLoopbackMode;
  proxyTls?: ManagedProxyTlsOptions;
  stopped: boolean;
};

/** Registration metadata for managed proxy URLs and their TLS trust material. */
export type RegisterActiveManagedProxyOptions = {
  loopbackMode?: ActiveManagedProxyLoopbackMode;
  proxyTls?: ManagedProxyTlsOptions;
};

let activeProxyUrl: ActiveManagedProxyUrl | undefined;
let activeProxyLoopbackMode: ActiveManagedProxyLoopbackMode | undefined;
let activeProxyTlsOptions: ManagedProxyTlsOptions | undefined;
let activeProxyRegistrationCount = 0;

function parseActiveManagedProxyLoopbackMode(
  value: string | undefined,
): ActiveManagedProxyLoopbackMode | undefined {
  if (value === "gateway-only" || value === "proxy" || value === "block") {
    return value;
  }
  return undefined;
}

function readInheritedActiveManagedProxyLoopbackMode(): ActiveManagedProxyLoopbackMode | undefined {
  if (process.env["OPENCLAW_PROXY_ACTIVE"] !== "1") {
    return undefined;
  }
  // Child processes inherit loopback policy through env even when they do not
  // own the in-process proxy registration.
  return (
    parseActiveManagedProxyLoopbackMode(process.env["OPENCLAW_PROXY_LOOPBACK_MODE"]) ??
    "gateway-only"
  );
}

/** Registers the active managed proxy, sharing identical nested registrations. */
export function registerActiveManagedProxyUrl(
  proxyUrl: URL,
  options: ActiveManagedProxyLoopbackMode | RegisterActiveManagedProxyOptions = "gateway-only",
): ActiveManagedProxyRegistration {
  const normalizedProxyUrl = new URL(proxyUrl.href);
  const loopbackMode =
    typeof options === "string" ? options : (options.loopbackMode ?? "gateway-only");
  const proxyTls = typeof options === "string" ? undefined : options.proxyTls;
  if (activeProxyUrl !== undefined) {
    if (activeProxyUrl.href !== normalizedProxyUrl.href) {
      throw new Error(
        "proxy: cannot activate a managed proxy while another proxy is active; " +
          "stop the current proxy before changing proxy.proxyUrl.",
      );
    }
    if (activeProxyLoopbackMode !== loopbackMode) {
      throw new Error(
        "proxy: cannot activate a managed proxy with a different proxy.loopbackMode while another proxy is active; " +
          "stop the current proxy before changing proxy.loopbackMode.",
      );
    }
    if (!areProxyTlsOptionsEqual(activeProxyTlsOptions, proxyTls)) {
      throw new Error(
        "proxy: cannot activate a managed proxy with different proxy TLS options while another proxy is active; " +
          "stop the current proxy before changing proxy.tls.",
      );
    }
    // Identical registrations are nested scopes; keep proxy state alive until
    // every owner stops its returned handle.
    activeProxyRegistrationCount += 1;
    return {
      proxyUrl: activeProxyUrl,
      loopbackMode,
      proxyTls: activeProxyTlsOptions,
      stopped: false,
    };
  }

  activeProxyUrl = normalizedProxyUrl;
  activeProxyLoopbackMode = loopbackMode;
  activeProxyTlsOptions = proxyTls;
  activeProxyRegistrationCount = 1;
  return { proxyUrl: activeProxyUrl, loopbackMode, proxyTls, stopped: false };
}

function areProxyTlsOptionsEqual(
  left: ManagedProxyTlsOptions | undefined,
  right: ManagedProxyTlsOptions | undefined,
): boolean {
  return left?.ca === right?.ca;
}

/** Stops one registration scope and clears active proxy state after the last owner. */
export function stopActiveManagedProxyRegistration(
  registration: ActiveManagedProxyRegistration,
): void {
  if (registration.stopped) {
    return;
  }
  registration.stopped = true;
  if (activeProxyUrl?.href !== registration.proxyUrl.href) {
    return;
  }
  activeProxyRegistrationCount = Math.max(0, activeProxyRegistrationCount - 1);
  if (activeProxyRegistrationCount === 0) {
    activeProxyUrl = undefined;
    activeProxyLoopbackMode = undefined;
    activeProxyTlsOptions = undefined;
  }
}

/** Returns local loopback policy from in-process state or inherited proxy env. */
export function getActiveManagedProxyLoopbackMode(): ActiveManagedProxyLoopbackMode | undefined {
  return activeProxyLoopbackMode ?? readInheritedActiveManagedProxyLoopbackMode();
}

/** Returns the in-process managed proxy URL, if this process owns the proxy. */
export function getActiveManagedProxyUrl(): ActiveManagedProxyUrl | undefined {
  return activeProxyUrl;
}

/** Returns the active managed proxy TLS options used by undici/proxyline dispatchers. */
export function getActiveManagedProxyTlsOptions(): ManagedProxyTlsOptions | undefined {
  return activeProxyTlsOptions;
}

/** Clears process-local proxy state for tests that share a worker process. */
export function resetActiveManagedProxyStateForTests(): void {
  activeProxyUrl = undefined;
  activeProxyLoopbackMode = undefined;
  activeProxyTlsOptions = undefined;
  activeProxyRegistrationCount = 0;
}
