export function isExplicitExtraMarkdownFilePath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    filePath.endsWith(".md") || (platform === "win32" && filePath.toLowerCase().endsWith(".md"))
  );
}
