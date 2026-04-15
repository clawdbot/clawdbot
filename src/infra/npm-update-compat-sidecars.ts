export const NPM_UPDATE_COMPAT_SIDECARS = [
  {
    path: "dist/extensions/qa-channel/runtime-api.js",
    content:
      "// Compatibility stub for older OpenClaw updaters. The QA channel implementation is not packaged.\nexport {};\n",
  },
  {
    path: "dist/extensions/qa-lab/runtime-api.js",
    content:
      "// Compatibility stub for older OpenClaw updaters. The QA lab implementation is not packaged.\nexport {};\n",
  },
] as const;

export const NPM_UPDATE_COMPAT_SIDECAR_PATHS = new Set<string>(
  NPM_UPDATE_COMPAT_SIDECARS.map((entry) => entry.path),
);
