// Bundled runtime sidecar paths that package/build tests expect to exist.

/** Runtime sidecar files shipped with bundled channel plugins. */
export const TEST_BUNDLED_RUNTIME_SIDECAR_PATHS = [
  "dist/extensions/discord/runtime-api.js",
  "dist/extensions/telegram/runtime-api.js",
  "dist/extensions/telegram/thread-bindings-runtime.js",
] as const;
