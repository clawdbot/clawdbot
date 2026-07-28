export function createJsonlRequestTailer<T = unknown>(
  filePath: string,
  options?: { historyLimit?: number; maxReadBytes?: number; tailLineLimit?: number },
): {
  read(): T[];
};
