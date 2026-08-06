/** Create a boundary checker with cached inventory collection and a CLI-style main function. */
export function createExtensionImportBoundaryChecker(params: unknown): {
  collectInventory: () => Promise<unknown>;
  main: (argv: unknown, io: unknown) => Promise<1 | 0>;
};
