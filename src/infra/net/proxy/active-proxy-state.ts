export type ActiveManagedProxyUrl = Readonly<URL>;

export type ActiveManagedProxyRegistration = {
  proxyUrl: ActiveManagedProxyUrl;
  stopped: boolean;
};

let activeProxyUrl: ActiveManagedProxyUrl | undefined;
let activeProxyRegistrationCount = 0;

export function registerActiveManagedProxyUrl(proxyUrl: URL): ActiveManagedProxyRegistration {
  const normalizedProxyUrl = new URL(proxyUrl.href);
  if (activeProxyUrl !== undefined) {
    if (activeProxyUrl.href !== normalizedProxyUrl.href) {
      throw new Error(
        "proxy: cannot activate a managed proxy while another proxy is active; " +
          "stop the current proxy before changing proxy.proxyUrl.",
      );
    }
    activeProxyRegistrationCount += 1;
    return { proxyUrl: activeProxyUrl, stopped: false };
  }

  activeProxyUrl = normalizedProxyUrl;
  activeProxyRegistrationCount = 1;
  return { proxyUrl: activeProxyUrl, stopped: false };
}

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
  }
}

export function getActiveManagedProxyUrl(): ActiveManagedProxyUrl | undefined {
  return activeProxyUrl;
}

export function _resetActiveManagedProxyStateForTests(): void {
  activeProxyUrl = undefined;
  activeProxyRegistrationCount = 0;
}
