type Varint = {
  nextOffset: number;
  value: number;
};

const utf8Decoder = new TextDecoder();

function readVarint(buf: Uint8Array, start: number): Varint | null {
  let offset = start;
  let value = 0;
  let shift = 0;

  while (offset < buf.length && shift <= 28) {
    const byte = buf[offset];
    offset += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { nextOffset: offset, value };
    }
    shift += 7;
  }

  return null;
}

export function tryStripImessageLengthPrefixedUtf8Buffer(buf: Uint8Array): Uint8Array | null {
  const key = readVarint(buf, 0);
  if (!key || key.nextOffset >= buf.length) {
    return null;
  }

  if (key.value !== 0x0a) {
    return null;
  }

  const length = readVarint(buf, key.nextOffset);
  if (!length || length.value === 0) {
    return null;
  }

  if (length.nextOffset + length.value !== buf.length) {
    return null;
  }

  return buf.subarray(length.nextOffset, buf.length);
}

export function stripImessageLengthPrefixedUtf8Text(text: string): string {
  if (!text) {
    return text;
  }

  const stripped = tryStripImessageLengthPrefixedUtf8Buffer(Buffer.from(text, "utf8"));
  if (!stripped) {
    return text;
  }

  const inner = utf8Decoder.decode(stripped);
  return inner.length > 0 ? inner : text;
}
