type McpConnectTransport = {
  close?(): Promise<void> | void;
};

const MCP_TIMEOUT_CLOSE_GRACE_MS = 5_000;

export async function connectMcpWithTimeout<TTransport extends McpConnectTransport>(
  client: { connect(transport: TTransport): Promise<void> },
  transport: TTransport,
  timeoutMs: number,
): Promise<void> {
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(new Error(`MCP stdio connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    await Promise.race([client.connect(transport), timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      await closeTimedOutTransport(transport);
    }
    throw error;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function closeTimedOutTransport(transport: McpConnectTransport): Promise<void> {
  if (!transport.close) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve(transport.close()).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, MCP_TIMEOUT_CLOSE_GRACE_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
