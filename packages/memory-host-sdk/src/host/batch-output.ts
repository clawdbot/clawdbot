// Parses provider batch output lines into the custom-id embedding map.

const DEFAULT_BATCH_OUTPUT_RECORD_MAX_BYTES = 4 * 1024 * 1024;
const INITIAL_BATCH_OUTPUT_RECORD_BYTES = 64 * 1024;

type ReadEmbeddingBatchJsonlOptions<T> = {
  label: string;
  maxRecords: number;
  maxRecordBytes?: number;
  onRecord: (record: T) => boolean;
};

/** Stream bounded JSONL records without buffering the provider output file. */
export async function readEmbeddingBatchJsonl<T>(
  response: Response,
  options: ReadEmbeddingBatchJsonlOptions<T>,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }

  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_BATCH_OUTPUT_RECORD_MAX_BYTES;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let recordCount = 0;
  let recordBytes = 0;
  let recordBuffer: Uint8Array | undefined;

  const appendRecordPart = (part: Uint8Array) => {
    if (part.byteLength === 0) {
      return;
    }
    const nextRecordBytes = recordBytes + part.byteLength;
    if (nextRecordBytes > maxRecordBytes) {
      throw new Error(`${options.label}: JSONL record exceeds ${maxRecordBytes} bytes`);
    }
    if (!recordBuffer || recordBuffer.byteLength < nextRecordBytes) {
      const nextCapacity = Math.min(
        maxRecordBytes,
        Math.max(
          nextRecordBytes,
          recordBuffer
            ? recordBuffer.byteLength * 2
            : Math.min(INITIAL_BATCH_OUTPUT_RECORD_BYTES, maxRecordBytes),
        ),
      );
      const nextBuffer = new Uint8Array(nextCapacity);
      if (recordBuffer) {
        nextBuffer.set(recordBuffer.subarray(0, recordBytes));
      }
      recordBuffer = nextBuffer;
    }
    recordBuffer.set(part, recordBytes);
    recordBytes = nextRecordBytes;
  };

  const emitRecord = (): boolean => {
    // Count physical rows before trimming so blank rows cannot bypass the
    // provider's one-output-row-per-input budget.
    recordCount += 1;
    if (recordCount > options.maxRecords) {
      throw new Error(`${options.label}: JSONL output exceeds ${options.maxRecords} records`);
    }
    let text: string;
    try {
      text = decoder.decode(recordBuffer?.subarray(0, recordBytes)).trim();
    } catch {
      recordBytes = 0;
      throw new Error(`${options.label}: malformed JSONL record`);
    }
    recordBytes = 0;
    if (!text) {
      return true;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${options.label}: malformed JSONL record`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${options.label}: malformed JSONL record`);
    }
    return options.onRecord(parsed as T);
  };

  const cancel = async () => {
    await reader.cancel().catch(() => {});
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      // Frame raw bytes so split UTF-8 sequences cannot evade the byte cap.
      let offset = 0;
      for (let index = 0; index < value.byteLength; index += 1) {
        if (value[index] !== 0x0a) {
          continue;
        }
        appendRecordPart(value.subarray(offset, index));
        if (!emitRecord()) {
          await cancel();
          return;
        }
        offset = index + 1;
      }
      appendRecordPart(value.subarray(offset));
    }
    if (recordBytes > 0) {
      emitRecord();
    }
  } catch (error) {
    await cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Minimal OpenAI-compatible embedding batch output line. */
export type EmbeddingBatchOutputLine = {
  custom_id?: string;
  error?: { message?: string } | null;
  response?: {
    status_code?: number;
    message?: string;
    body?:
      | {
          data?: Array<{
            embedding?: number[];
          }>;
          error?: { message?: string };
        }
      | string;
  };
};

/** Apply one output line, collecting errors and successful embeddings by custom id. */
export function applyEmbeddingBatchOutputLine(params: {
  line: EmbeddingBatchOutputLine;
  remaining: Set<string>;
  errors: string[];
  byCustomId: Map<string, number[]>;
}) {
  const customId = params.line.custom_id;
  if (!customId) {
    return;
  }
  params.remaining.delete(customId);

  const errorMessage = params.line.error?.message;
  if (errorMessage) {
    params.errors.push(`${customId}: ${errorMessage}`);
    return;
  }

  const response = params.line.response;
  const statusCode = response?.status_code ?? 0;
  if (statusCode >= 400) {
    const messageFromObject =
      response?.body && typeof response.body === "object"
        ? (response.body as { error?: { message?: string } }).error?.message
        : undefined;
    const messageFromString = typeof response?.body === "string" ? response.body : undefined;
    params.errors.push(
      `${customId}: ${messageFromObject || messageFromString || response?.message || "unknown error"}`,
    );
    return;
  }

  const data =
    response?.body && typeof response.body === "object" ? (response.body.data ?? []) : [];
  const embedding = data[0]?.embedding ?? [];
  if (embedding.length === 0) {
    params.errors.push(`${customId}: empty embedding`);
    return;
  }
  params.byCustomId.set(customId, embedding);
}
