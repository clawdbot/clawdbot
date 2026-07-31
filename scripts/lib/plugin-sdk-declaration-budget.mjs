// Raised for meeting-browser origin permissions and current browser-session contracts;
// the cap exists to force a conscious decision on published declaration growth.
export const MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES = 5_250_000;
// Private-only entrypoints reshape chunks reachable from public roots but are never published.
// Bound that topology overhead without counting local-only declarations as package surface.
export const MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES = 5_275_000;
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
