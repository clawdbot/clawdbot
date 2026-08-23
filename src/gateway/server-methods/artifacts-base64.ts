export type ArtifactBase64Payload = {
  data?: string;
  sizeBytes: number;
};

export function mimeFromDataUrl(value: string): string | undefined {
  const match = /^data:([^;,]+)(?:;[^,]*)?,/i.exec(value.trim());
  return match?.[1]?.toLowerCase();
}

export function base64FromDataUrl(value: string): string | undefined {
  const trimmed = value.trim();
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex < 0 || trimmed.slice(0, 5).toLowerCase() !== "data:") {
    return undefined;
  }
  const metadata = trimmed.slice(0, commaIndex).toLowerCase();
  if (!metadata.includes(";base64")) {
    return undefined;
  }
  return trimmed.slice(commaIndex + 1);
}

function isBase64Whitespace(value: string): boolean {
  return value === " " || value === "\n" || value === "\r" || value === "\t";
}

function isArtifactBase64DataChar(value: string): boolean {
  const code = value.charCodeAt(0);
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    value === "+" ||
    value === "/" ||
    value === "-" ||
    value === "_"
  );
}

function normalizeArtifactBase64Char(value: string): string {
  if (value === "-") {
    return "+";
  }
  if (value === "_") {
    return "/";
  }
  return value;
}

export function readArtifactBase64Payload(
  value: string | undefined,
  opts: { includeData: boolean },
): ArtifactBase64Payload | undefined {
  if (value === undefined) {
    return undefined;
  }
  let encodedLength = 0;
  let padding = 0;
  let sawPadding = false;
  let data = opts.includeData ? "" : undefined;
  for (const char of value) {
    if (isBase64Whitespace(char)) {
      continue;
    }
    if (char === "=") {
      padding += 1;
      if (padding > 2) {
        return undefined;
      }
      sawPadding = true;
      encodedLength += 1;
      if (data !== undefined) {
        data += char;
      }
      continue;
    }
    if (sawPadding || !isArtifactBase64DataChar(char)) {
      return undefined;
    }
    encodedLength += 1;
    if (data !== undefined) {
      data += normalizeArtifactBase64Char(char);
    }
  }
  const remainder = encodedLength % 4;
  if ((padding > 0 && remainder !== 0) || remainder === 1) {
    return undefined;
  }
  if (data !== undefined && padding === 0 && remainder > 0) {
    data += "=".repeat(4 - remainder);
  }
  return {
    ...(data !== undefined ? { data } : {}),
    sizeBytes: Math.max(0, Math.floor((encodedLength * 3) / 4) - padding),
  };
}
