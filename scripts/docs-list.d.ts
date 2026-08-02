export function materializePluginReferenceDocs(
  docsDir?: string,
  options?: { regenerate?: boolean },
): boolean;
export function renderDocsHeadingMap(
  docsDir?: string,
  options?: { relativePath?: (base: string, fullPath: string) => string },
): string;
