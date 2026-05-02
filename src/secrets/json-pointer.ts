function failOrUndefined(params: { onMissing: "throw" | "undefined"; message: string }): undefined {
  if (params.onMissing === "throw") {
    throw new Error(params.message);
  }
  return undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function encodeJsonPointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function readJsonPointer(
  root: unknown,
  pointer: string,
  options: { onMissing?: "throw" | "undefined" } = {},
): unknown {
  const onMissing = options.onMissing ?? "throw";
  if (!pointer.startsWith("/")) {
    return failOrUndefined({
      onMissing,
      message:
        'File-backed secret ids must be absolute JSON pointers (for example: "/providers/openai/apiKey").',
    });
  }

  const tokens = pointer
    .slice(1)
    .split("/")
    .map((token) => decodeJsonPointerToken(token));

  let current: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(token, 10);
      if (!Number.isFinite(index) || index < 0 || index >= current.length) {
        return failOrUndefined({
          onMissing,
          message: `JSON pointer segment "${token}" is out of bounds.`,
        });
      }
      current = current[index];
      continue;
    }
    if (!isJsonObject(current)) {
      return failOrUndefined({
        onMissing,
        message: `JSON pointer segment "${token}" does not exist.`,
      });
    }
    if (!Object.hasOwn(current, token)) {
      return failOrUndefined({
        onMissing,
        message: `JSON pointer segment "${token}" does not exist.`,
      });
    }
    current = current[token];
  }
  return current;
}
