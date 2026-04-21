export function createStreamingErrorResponse(params: {
  status: number;
  chunkCount: number;
  chunkSize: number;
  byte: number;
}): { response: Response; getReadCount: () => number } {
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads >= params.chunkCount) {
        controller.close();
        return;
      }
      reads += 1;
      controller.enqueue(new Uint8Array(params.chunkSize).fill(params.byte));
    },
  });
  return {
    response: new Response(stream, { status: params.status }),
    getReadCount: () => reads,
  };
}
