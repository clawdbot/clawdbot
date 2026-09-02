/**
 * Lazy boundary for the extension relay (pulls in the ws server dependency).
 */
let modPromise: Promise<typeof import("./extension-relay/relay-lifecycle.js")> | null = null;

/** Load the extension relay lifecycle module on demand. */
export function getExtensionRelayModule(): Promise<
  typeof import("./extension-relay/relay-lifecycle.js")
> {
  modPromise ??= import("./extension-relay/relay-lifecycle.js");
  return modPromise;
}
