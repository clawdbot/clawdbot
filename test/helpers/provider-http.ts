type MockCallSource = {
  mock: { calls: readonly (readonly unknown[])[] };
};

type TrackedOversizedJsonResponse = {
  response: Response;
  getReadCount: () => number;
  wasCanceled: () => boolean;
};

type FixedOversizedJsonResponse = {
  response: Response;
  state: { canceled: boolean; enqueuedBytes: number };
};

export function oversizedJsonResponse(): FixedOversizedJsonResponse;
export function oversizedJsonResponse(params: {
  chunkCount: number;
  chunkSize: number;
}): TrackedOversizedJsonResponse;
export function oversizedJsonResponse(params?: {
  chunkCount: number;
  chunkSize: number;
}): FixedOversizedJsonResponse | TrackedOversizedJsonResponse {
  if (params) {
    const chunk = new Uint8Array(params.chunkSize);
    let readCount = 0;
    let canceled = false;
    return {
      response: new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (readCount >= params.chunkCount) {
              controller.close();
              return;
            }
            readCount += 1;
            controller.enqueue(chunk);
          },
          cancel() {
            canceled = true;
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
      getReadCount: () => readCount,
      wasCanceled: () => canceled,
    };
  }

  // Cap the advertised stream at 64 MiB so a broken bounded reader fails
  // instead of hanging, while still forcing cancellation past the 16 MiB limit.
  const state = { canceled: false, enqueuedBytes: 0 };
  const chunk = 1024 * 1024;
  const maxChunks = 64;
  let emitted = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (emitted >= maxChunks) {
          controller.close();
          return;
        }
        emitted += 1;
        state.enqueuedBytes += chunk;
        controller.enqueue(new Uint8Array(chunk));
      },
      cancel() {
        state.canceled = true;
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
  return { response, state };
}

export function bufferedOversizedJsonResponse(): Response {
  return new Response(Buffer.alloc(16 * 1024 * 1024 + 1, 0x20), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function streamedJsonResponse(payload: unknown): Response {
  // Keep a real body stream so bounded-reader tests exercise reads and cancellation.
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export function requireFirstPostJsonRequest(mock: MockCallSource, label: string): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call[0];
}

export function requireFirstPostJsonRecordRequest(
  mock: MockCallSource,
  label: string,
): Record<string, unknown> {
  const value = requireFirstPostJsonRequest(mock, label);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}
