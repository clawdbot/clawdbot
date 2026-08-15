// Provider owners record lifecycle facts here so short-lived CLI teardown can
// avoid loading heavyweight provider modules when they never created resources.
let managedProviderLocalServicesActive = false;
let providerTransportDispatcherPoolActive = false;

export function setManagedProviderLocalServicesActive(active: boolean): void {
  managedProviderLocalServicesActive = active;
}

export function hasManagedProviderLocalServices(): boolean {
  return managedProviderLocalServicesActive;
}

export function setProviderTransportDispatcherPoolActive(active: boolean): void {
  providerTransportDispatcherPoolActive = active;
}

export function hasProviderTransportDispatcherPool(): boolean {
  return providerTransportDispatcherPoolActive;
}
