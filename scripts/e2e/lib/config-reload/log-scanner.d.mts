export function createConfigReloadLogScanner(
  logPath: string,
  options?: { maxReadBytes?: number; tailLineLimit?: number },
): {
  scan(): { reloadLines: string[]; restartLines: string[]; tailLines: string[] };
};
