// Builds the list of deprecated public plugin SDK specifiers guarded by scripts.
import deprecatedPublicPluginSdkSubpaths from "./plugin-sdk-deprecated-public-subpaths.json" with { type: "json" };

const DEPRECATED_PLUGIN_SDK_EXTRA_SPECIFIERS = [
  "openclaw/plugin-sdk",
  "openclaw/plugin-sdk/agent-dir-compat",
  "openclaw/plugin-sdk/test-utils",
];

/** Build fully qualified deprecated plugin SDK module specifiers from subpath metadata. */
export function buildDeprecatedPluginSdkModuleSpecifiers(
  deprecatedSubpaths = deprecatedPublicPluginSdkSubpaths,
) {
  const unscoped = [
    ...DEPRECATED_PLUGIN_SDK_EXTRA_SPECIFIERS,
    ...deprecatedSubpaths.map((subpath) => `openclaw/plugin-sdk/${subpath}`),
  ];
  // tsconfig aliases the scoped @openclaw/plugin-sdk package to the same
  // src/plugin-sdk modules, so ban both spellings of every deprecated specifier.
  return [...new Set(unscoped.flatMap((specifier) => [specifier, `@${specifier}`]))].toSorted();
}

/**
 * Deprecated facade modules that stay exported for third-party plugins until the
 * documented break train, but must have zero internal importers (src/**,
 * extensions/**) via package specifier or relative path. Table-driven and
 * additive: future facade collapses (e.g. config-schema) append rows here.
 * `modulePath` is the extension-less repo path; `allowedImporters` lists the
 * compat re-export chain that keeps the public subpath alive.
 */
export const BANNED_INTERNAL_PLUGIN_SDK_FACADE_MODULES = [
  // Reply facades: canonical seams are openclaw/plugin-sdk/channel-inbound and
  // openclaw/plugin-sdk/channel-outbound (defineChannelMessageAdapter family).
  {
    modulePath: "src/plugin-sdk/channel-envelope",
    canonical: "openclaw/plugin-sdk/channel-inbound",
  },
  {
    modulePath: "src/plugin-sdk/channel-message",
    canonical: "openclaw/plugin-sdk/channel-outbound",
  },
  {
    modulePath: "src/plugin-sdk/channel-message-runtime",
    canonical: "openclaw/plugin-sdk/channel-outbound",
  },
  {
    modulePath: "src/plugin-sdk/channel-reply-pipeline",
    canonical: "openclaw/plugin-sdk/channel-outbound",
  },
  {
    modulePath: "src/plugin-sdk/inbound-reply-dispatch",
    canonical: "openclaw/plugin-sdk/channel-inbound",
  },
  {
    modulePath: "src/plugin-sdk/inbound-envelope",
    canonical: "openclaw/plugin-sdk/channel-inbound",
  },
  // Shared dispatch bridge backing the facades above; only the SDK seams may
  // consume it directly so channel code stays on channel-inbound/channel-outbound.
  {
    modulePath: "src/channels/message/inbound-reply-dispatch",
    canonical: "openclaw/plugin-sdk/channel-inbound",
    allowedImporters: [
      "src/plugin-sdk/channel-inbound.ts",
      "src/plugin-sdk/inbound-reply-dispatch.ts",
    ],
  },
];
