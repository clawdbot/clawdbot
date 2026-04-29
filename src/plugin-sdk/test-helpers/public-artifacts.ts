import {
  assertUniqueValues,
  BUNDLED_RUNTIME_SIDECAR_PATHS,
} from "../../plugins/runtime-sidecar-paths.js";

export function getPublicArtifactBasename(relativePath: string): string {
  return relativePath.split("/").at(-1) ?? relativePath;
}

const EXTRA_GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES = assertUniqueValues(
  [
    "action-runtime.runtime.js",
    "action-runtime-api.js",
    "allow-from.js",
    "api.js",
    "auth-presence.js",
    "channel-config-api.js",
    "index.js",
    "login-qr-api.js",
    "onboard.js",
    "openai-codex-catalog.js",
    "provider-catalog.js",
    "session-key-api.js",
    "setup-api.js",
    "setup-entry.js",
    "timeouts.js",
    "x-search.js",
  ] as const,
  "extra guarded extension public surface basename",
);

export const BUNDLED_RUNTIME_SIDECAR_BASENAMES = assertUniqueValues(
  [...new Set(BUNDLED_RUNTIME_SIDECAR_PATHS.map(getPublicArtifactBasename))],
  "bundled runtime sidecar basename",
);

export const GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES = assertUniqueValues(
  [...BUNDLED_RUNTIME_SIDECAR_BASENAMES, ...EXTRA_GUARDED_EXTENSION_PUBLIC_SURFACE_BASENAMES],
  "guarded extension public surface basename",
);
