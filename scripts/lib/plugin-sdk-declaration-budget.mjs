// Raised from 5_000_000 for the plugins.uninstall + catalog install-action protocol surface;
// raised again for the continuation tool and session contract surface.
// the cap exists to force a conscious decision on published declaration growth.
export const MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES = 5_090_000;
// Private-only entrypoints reshape chunks reachable from public roots but are never published.
// Bound that topology overhead without counting local-only declarations as package surface.
export const MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES = 5_115_000;

export function isPrivateQaPluginSdkBuild(env) {
  return env.OPENCLAW_BUILD_PRIVATE_QA === "1";
}

export function evaluatePluginSdkDeclarationBudget({ declarationBytes, buildPrivateQa }) {
  const budgetBytes = buildPrivateQa
    ? MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES
    : MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES;
  return {
    budgetBytes,
    budgetKind: buildPrivateQa ? "private-qa-public-entry" : "public",
    shouldFail: declarationBytes > budgetBytes,
  };
}
