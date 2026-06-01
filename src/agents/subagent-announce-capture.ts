export async function readLatestSubagentOutputWithRetryUsing<Outcome = unknown>(params: {
  sessionKey: string;
  maxWaitMs: number;
  retryIntervalMs: number;
  outcome?: Outcome;
  readSubagentOutput: (sessionKey: string, outcome?: Outcome) => Promise<string | undefined>;
}): Promise<string | undefined> {
  const maxWaitMs = Math.max(0, Math.min(params.maxWaitMs, 15_000));
  let waitedMs = 0;
  let result: string | undefined;
  while (waitedMs < maxWaitMs) {
    result = await params.readSubagentOutput(params.sessionKey, params.outcome);
    if (result?.trim()) {
      return result;
    }
    const remainingMs = maxWaitMs - waitedMs;
    if (remainingMs <= 0) {
      break;
    }
    const sleepMs = Math.min(params.retryIntervalMs, remainingMs);
    await new Promise((resolve) => {
      setTimeout(resolve, sleepMs);
    });
    waitedMs += sleepMs;
  }
  return result;
}

export async function captureSubagentCompletionReplyUsing(params: {
  sessionKey: string;
  waitForReply?: boolean;
  maxWaitMs: number;
  retryIntervalMs: number;
  readSubagentOutput: (sessionKey: string) => Promise<string | undefined>;
}): Promise<string | undefined> {
  const immediate = await params.readSubagentOutput(params.sessionKey);
  if (immediate?.trim()) {
    return immediate;
  }
  if (params.waitForReply === false) {
    return undefined;
  }
  return await readLatestSubagentOutputWithRetryUsing({
    sessionKey: params.sessionKey,
    maxWaitMs: params.maxWaitMs,
    retryIntervalMs: params.retryIntervalMs,
    readSubagentOutput: params.readSubagentOutput,
  });
}
