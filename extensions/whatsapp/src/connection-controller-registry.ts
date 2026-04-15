import type { ActiveWebListener } from "./inbound/types.js";

export type WhatsAppConnectionControllerHandle = {
  getActiveListener(): ActiveWebListener | null;
};

type ConnectionRegistryState = {
  controllers: Map<string, WhatsAppConnectionControllerHandle>;
};

const CONNECTION_REGISTRY_KEY = Symbol.for("openclaw.whatsapp.connectionControllerRegistry");

function getConnectionRegistryState(): ConnectionRegistryState {
  const globalState = globalThis as typeof globalThis & {
    [CONNECTION_REGISTRY_KEY]?: ConnectionRegistryState;
  };
  const existing = globalState[CONNECTION_REGISTRY_KEY];
  if (existing) {
    return existing;
  }
  const created: ConnectionRegistryState = {
    controllers: new Map<string, WhatsAppConnectionControllerHandle>(),
  };
  globalState[CONNECTION_REGISTRY_KEY] = created;
  return created;
}

export function getRegisteredWhatsAppConnectionController(
  accountId: string,
): WhatsAppConnectionControllerHandle | null {
  return getConnectionRegistryState().controllers.get(accountId) ?? null;
}

export function registerWhatsAppConnectionController(
  accountId: string,
  controller: WhatsAppConnectionControllerHandle,
): void {
  getConnectionRegistryState().controllers.set(accountId, controller);
}

export function unregisterWhatsAppConnectionController(
  accountId: string,
  controller: WhatsAppConnectionControllerHandle,
): void {
  const controllers = getConnectionRegistryState().controllers;
  if (controllers.get(accountId) === controller) {
    controllers.delete(accountId);
  }
}
