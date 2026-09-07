export type PackageDistImport = { importerPath: string; importedPath: string };

export function collectPackageDistImportErrors(
  params: { files: readonly string[] } & (
    | {
        readText: (relativePath: string) => string;
        imports?: readonly PackageDistImport[];
      }
    | {
        imports: readonly PackageDistImport[];
        readText?: (relativePath: string) => string;
      }
  ),
): string[];

export function collectPackageDistImports(params: {
  files: readonly string[];
  readText: (relativePath: string) => string;
}): PackageDistImport[];
