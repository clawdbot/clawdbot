// Strict unified tsdown build measurement for public plugin-sdk declaration graph.
export const MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES = 4_933_415;
// Strict unified tsdown build measurement when private-QA entrypoints join the graph.
export const MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES = 4_809_119;
// Rolldown can repartition equivalent declaration chunks between clean builds; measured spread is
// about 29 KiB across hosts. Keep one 64 KiB scheduling window above the intentional size ratchet.
export const PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES = 64 * 1024;

export function isPrivateQaPluginSdkBuild(env) {
  return env.OPENCLAW_BUILD_PRIVATE_QA === "1";
}

export function evaluatePluginSdkDeclarationBudget({ declarationBytes, buildPrivateQa }) {
  const ratchetBytes = buildPrivateQa
    ? MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES
    : MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES;
  const budgetBytes = ratchetBytes + PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES;
  return {
    budgetBytes,
    budgetKind: buildPrivateQa ? "private-qa-public-entry" : "public",
    ratchetBytes,
    shouldFail: declarationBytes > budgetBytes,
    varianceBytes: PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES,
  };
}
