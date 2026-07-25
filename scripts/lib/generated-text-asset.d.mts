interface GeneratedTextAssetFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, contents: string, encoding: "utf8"): Promise<unknown>;
}

/** Writes a generated text asset and returns whether its contents changed. */
export function writeGeneratedTextAsset(
  filePath: string,
  contents: string,
  params?: { fs?: GeneratedTextAssetFs },
): Promise<boolean>;
