export type BundledExtensionSourceClassification = {
  normalizedPath: string;
  isCodeFile: boolean;
  isRuntimeApiBarrel: boolean;
  isPublicApiBarrel: boolean;
  isTestLike: boolean;
  isInfraArtifact: boolean;
  isProductionSource: boolean;
};

export function classifyBundledExtensionSourcePath(
  filePath: string,
): BundledExtensionSourceClassification;
