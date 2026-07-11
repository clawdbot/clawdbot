export function createJsonlRequestTailer(
  filePath: string,
  options?: { historyLimit?: number; maxReadBytes?: number; tailLineLimit?: number },
): {
  read(): unknown[];
};
