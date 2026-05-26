import deprecatedPublicPluginSdkSubpaths from "./plugin-sdk-deprecated-public-subpaths.json" with { type: "json" };

const DEPRECATED_PLUGIN_SDK_EXTRA_SPECIFIERS = [
  "openclaw/plugin-sdk",
  "openclaw/plugin-sdk/agent-dir-compat",
  "openclaw/plugin-sdk/test-utils",
];

export function buildDeprecatedPluginSdkModuleSpecifiers(
  deprecatedSubpaths = deprecatedPublicPluginSdkSubpaths,
) {
  return [
    ...new Set([
      ...DEPRECATED_PLUGIN_SDK_EXTRA_SPECIFIERS,
      ...deprecatedSubpaths.map((subpath) => `openclaw/plugin-sdk/${subpath}`),
    ]),
  ].toSorted();
}
