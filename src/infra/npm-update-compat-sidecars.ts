export const NPM_UPDATE_COMPAT_SIDECARS = [
  {
    path: "dist/extensions/qa-channel/runtime-api.js",
    content:
      "// Compatibility stub for older OpenClaw updaters. The QA channel implementation is not packaged.\nexport {};\n",
  },
] as const;

export const NPM_UPDATE_COMPAT_SIDECAR_PATHS = new Set<string>(
  NPM_UPDATE_COMPAT_SIDECARS.map((entry) => entry.path),
);

export const NPM_UPDATE_OMITTED_BUNDLED_PLUGIN_ROOTS = new Set<string>([
  "dist/extensions/qa-lab",
  "dist/extensions/qa-matrix",
]);
