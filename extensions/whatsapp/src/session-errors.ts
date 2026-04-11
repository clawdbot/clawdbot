function safeStringify(value: unknown, limit = 800): string {
  try {
    const seen = new WeakSet();
    const raw = JSON.stringify(
      value,
      (_key, v) => {
        if (typeof v === "bigint") {
          return v.toString();
        }
        if (typeof v === "function") {
          const maybeName = (v as { name?: unknown }).name;
          const name =
            typeof maybeName === "string" && maybeName.length > 0 ? maybeName : "anonymous";
          return `[Function ${name}]`;
        }
        if (typeof v === "object" && v) {
          if (seen.has(v)) {
            return "[Circular]";
          }
          seen.add(v);
        }
        return v;
      },
      2,
    );
    if (!raw) {
      return String(value);
    }
    return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
  } catch {
    return String(value);
  }
}

function extractBoomDetails(err: unknown): {
  statusCode?: number;
  error?: string;
  message?: string;
} | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const output = (err as { output?: unknown })?.output as
    | { statusCode?: unknown; payload?: unknown }
    | undefined;
  if (!output || typeof output !== "object") {
    return null;
  }
  const payload = (output as { payload?: unknown }).payload as
    | { error?: unknown; message?: unknown; statusCode?: unknown }
    | undefined;
  const statusCode =
    typeof (output as { statusCode?: unknown }).statusCode === "number"
      ? ((output as { statusCode?: unknown }).statusCode as number)
      : typeof payload?.statusCode === "number"
        ? payload.statusCode
        : undefined;
  const error = typeof payload?.error === "string" ? payload.error : undefined;
  const message = typeof payload?.message === "string" ? payload.message : undefined;
  if (!statusCode && !error && !message) {
    return null;
  }
  return { statusCode, error, message };
}

export function getStatusCode(err: unknown) {
  return (
    (err as { output?: { statusCode?: number } })?.output?.statusCode ??
    (err as { status?: number })?.status ??
    (err as { error?: { output?: { statusCode?: number } } })?.error?.output?.statusCode
  );
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (!err || typeof err !== "object") {
    return String(err);
  }

  const boom =
    extractBoomDetails(err) ??
    extractBoomDetails((err as { error?: unknown })?.error) ??
    extractBoomDetails((err as { lastDisconnect?: { error?: unknown } })?.lastDisconnect?.error);

  const status = boom?.statusCode ?? getStatusCode(err);
  const code = (err as { code?: unknown })?.code;
  const codeText = typeof code === "string" || typeof code === "number" ? String(code) : undefined;

  const messageCandidates = [
    boom?.message,
    typeof (err as { message?: unknown })?.message === "string"
      ? ((err as { message?: unknown }).message as string)
      : undefined,
    typeof (err as { error?: { message?: unknown } })?.error?.message === "string"
      ? ((err as { error?: { message?: unknown } }).error?.message as string)
      : undefined,
  ];
  const message = messageCandidates.find((value): value is string =>
    Boolean(value && value.trim().length > 0),
  );

  const pieces: string[] = [];
  if (typeof status === "number") {
    pieces.push(`status=${status}`);
  }
  if (boom?.error) {
    pieces.push(boom.error);
  }
  if (message) {
    pieces.push(message);
  }
  if (codeText) {
    pieces.push(`code=${codeText}`);
  }

  if (pieces.length > 0) {
    return pieces.join(" ");
  }
  return safeStringify(err);
}
