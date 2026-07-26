import { randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

const INSTALLATION_NAMESPACE = "discussion-installation";
const INSTALLATION_KEY = "current";

/** Returns the durable installation namespace used in server-visible ownership refs. */
export function getClickClackDiscussionInstallationId(runtime: PluginRuntime): string {
  const store = runtime.state.openSyncKeyedStore<{ id: string }>({
    namespace: INSTALLATION_NAMESPACE,
    maxEntries: 1,
    overflowPolicy: "reject-new",
  });
  const existing = store.lookup(INSTALLATION_KEY)?.id;
  if (existing) {
    return existing;
  }
  const id = randomUUID();
  store.registerIfAbsent(INSTALLATION_KEY, { id });
  return store.lookup(INSTALLATION_KEY)?.id ?? id;
}
