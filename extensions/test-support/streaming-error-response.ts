// Test Support plugin module implements streaming response fixtures.
export type StreamingResponseFixture = {
  response: Response;
  getReadCount: () => number;
  wasCanceled: () => boolean;
};

export function createStreamingResponse(params: {
  status?: number;
  chunkCount: number;
  chunkSize: number;
  byte?: number;
  text?: string;
  headers?: HeadersInit;
}): StreamingResponseFixture {
  let reads = 0;
  let canceled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= params.chunkCount) {
        controller.close();
        return;
      }
      reads += 1;
      const chunk =
        params.text !== undefined
          ? encoder.encode(params.text.repeat(params.chunkSize))
          : new Uint8Array(params.chunkSize).fill(params.byte ?? 120);
      controller.enqueue(chunk);
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, { status: params.status ?? 200, headers: params.headers }),
    getReadCount: () => reads,
    wasCanceled: () => canceled,
  };
}

export function createStreamingErrorResponse(params: {
  status: number;
  chunkCount: number;
  chunkSize: number;
  byte: number;
}): StreamingResponseFixture {
  return createStreamingResponse(params);
}
