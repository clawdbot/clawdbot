export function parseReportCliArgs(argv: string[]): {
  rootDir: string;
  jsonPath: string | null;
  markdownPath: string | null;
};
/**
 * Writes an optional report artifact, creating its parent directory first.
 */
export function writeReportArtifact(filePath: string | null, content: string): Promise<void>;
