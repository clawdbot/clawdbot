import { AsyncLocalStorage } from "node:async_hooks";

const publicationEnabled = new AsyncLocalStorage<boolean>();

export function withoutRuntimeExternalAuthProfilePublication<T>(run: () => T): T {
  return publicationEnabled.run(false, run);
}

export function shouldPublishRuntimeExternalAuthProfiles(): boolean {
  return publicationEnabled.getStore() !== false;
}
