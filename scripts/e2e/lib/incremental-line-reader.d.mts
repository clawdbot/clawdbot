export function resolvePositiveInteger(value: unknown, fallback: number): number;
export function createIncrementalLineReader(
  filePath: string,
  options?: { maxReadBytes?: number },
): {
  readLines(): {
    lines: string[];
    reset: boolean;
  };
};
