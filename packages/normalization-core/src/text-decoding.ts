export type DecodeTextPrefixOptions = {
  encoding?: string;
  truncated?: boolean;
};

/** Decodes a byte prefix without inventing a replacement character for a cut trailing sequence. */
export function decodeTextPrefix(bytes: Uint8Array, options: DecodeTextPrefixOptions = {}): string {
  const decoder = new TextDecoder(options.encoding);
  // Streaming mode retains an incomplete tail; discarding this one-shot decoder
  // drops only that cut sequence while complete bodies still flush normally.
  return decoder.decode(bytes, options.truncated ? { stream: true } : undefined);
}
