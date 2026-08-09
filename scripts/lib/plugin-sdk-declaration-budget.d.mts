export function isPrivateQaPluginSdkBuild(env: unknown): boolean;
export function evaluatePluginSdkDeclarationBudget({
  declarationBytes,
  buildPrivateQa,
}: {
  declarationBytes: unknown;
  buildPrivateQa: unknown;
}): {
  budgetBytes: number;
  budgetKind: string;
  ratchetBytes: number;
  shouldFail: boolean;
  varianceBytes: number;
};
export const MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES: 5200000;
export const MAX_PRIVATE_QA_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES: 5225000;
export const PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES: 65536;
