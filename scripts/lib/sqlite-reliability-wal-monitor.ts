import fs from "node:fs";

const DEFAULT_POLL_INTERVAL_MS = 25;

function fileSize(pathname: string): number {
  try {
    return fs.statSync(pathname).size;
  } catch {
    return 0;
  }
}

export async function monitorSqliteWalDuring<T>(params: {
  maxWalBytes: number;
  onLimitExceeded: () => void;
  operation: () => Promise<T>;
  pollIntervalMs?: number;
  walPath: string;
}): Promise<{ peakWalBytes: number; result: T }> {
  let peakWalBytes = fileSize(params.walPath);
  let limitExceeded = false;
  const sample = () => {
    const currentWalBytes = fileSize(params.walPath);
    peakWalBytes = Math.max(peakWalBytes, currentWalBytes);
    if (!limitExceeded && currentWalBytes > params.maxWalBytes) {
      limitExceeded = true;
      params.onLimitExceeded();
    }
  };
  const timer = setInterval(sample, params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  try {
    const result = await params.operation();
    sample();
    if (limitExceeded) {
      throw new Error(
        `SQLite reliability WAL exceeded the ${params.maxWalBytes}-byte profile limit: ${peakWalBytes} bytes`,
      );
    }
    return { peakWalBytes, result };
  } finally {
    clearInterval(timer);
  }
}
