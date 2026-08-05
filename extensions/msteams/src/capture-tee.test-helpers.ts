// Msteams helper module supports capture tee behavior.

/**
 * Builds a response whose body is one branch of a live tee, the way the debug
 * proxy leaves every captured response.
 *
 * `installDebugProxyFetchPatch` clones each http(s) response and reads the
 * clone, so the caller-facing body is one branch of a `Response.clone()` tee.
 * Cancelling such a branch settles only once both branches cancel or the source
 * reaches EOF, so awaiting it on an error or cleanup path stalls the caller.
 */
export function createCaptureTeedResponse(init?: ResponseInit): {
  response: Response;
  cancellationSettled: () => boolean;
  releaseCaptureBranch: () => void;
} {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("stalled body prefix"));
      },
    }),
    init,
  );
  // clone() tees the body: `response` keeps one branch and the clone owns the
  // other, standing in for the capture reader that never reaches EOF.
  const captureBranch = response.clone();
  const captureReader = captureBranch.body?.getReader();
  void captureReader?.read();
  const body = response.body;
  if (!body) {
    throw new Error("expected a readable capture-teed body");
  }
  let settled = false;
  const markSettled = <T>(pending: Promise<T>): Promise<T> =>
    pending.finally(() => {
      settled = true;
    });
  // Callers reach the branch either directly or through a reader, and
  // `reader.cancel()` does not route through `stream.cancel()`. Instrument both
  // so the assertion holds wherever the release path lives.
  const cancelBranch = body.cancel.bind(body);
  body.cancel = (reason?: unknown) => markSettled(cancelBranch(reason));
  const getBranchReader = body.getReader.bind(body);
  body.getReader = ((...args: Parameters<typeof getBranchReader>) => {
    const reader = getBranchReader(...args);
    const cancelReader = reader.cancel.bind(reader);
    reader.cancel = (reason?: unknown) => markSettled(cancelReader(reason));
    return reader;
  }) as typeof body.getReader;
  return {
    response,
    cancellationSettled: () => settled,
    releaseCaptureBranch: () => {
      void captureReader?.cancel().catch(() => undefined);
    },
  };
}

/**
 * Rejects instead of hanging when `operation` never settles, so a regression
 * that restores the awaited cancellation fails fast rather than timing out.
 */
export async function expectSettled<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
