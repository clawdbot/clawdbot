export function mapWithConcurrency<Item, Result>(
  items: Item[],
  concurrency: number,
  mapper: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]>;

export function collectSourceFileContents(params: {
  repoRoot: string;
  scanRoots: string[];
  scanExtensions: Set<string>;
  ignoredDirNames: Set<string>;
  maxConcurrentReads?: number;
  maxFileBytes?: number;
  readFile?: (filePath: string) => Promise<string>;
}): Promise<Array<{ absoluteFile: string; content: string; relativeFile: string }>>;
