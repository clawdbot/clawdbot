// Runtime facades with no activation-owned plugin manifest. Every entry must
// ship a matching dist/extensions/<id>/runtime-api.js sidecar.
export const ALWAYS_ALLOWED_RUNTIME_DIR_NAMES = [
  "image-generation-core",
  "media-understanding-core",
] as const;
