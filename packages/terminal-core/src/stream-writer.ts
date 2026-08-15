// Safe terminal stream writer that treats broken pipes as closed output.

/** Hooks for safe stream writes. */
export type SafeStreamWriterOptions = {
  beforeWrite?: () => void;
  onBrokenPipe?: (err: NodeJS.ErrnoException, stream: NodeJS.WriteStream) => void;
};

/** Writer facade that tracks closed/broken-pipe state. */
export type SafeStreamWriter = {
  write: (stream: NodeJS.WriteStream, text: string) => boolean;
  writeLine: (stream: NodeJS.WriteStream, text: string) => boolean;
  reset: () => void;
  isClosed: () => boolean;
};

/** Detect broken pipe style stream errors. */
function isBrokenPipeError(err: unknown): err is NodeJS.ErrnoException {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EPIPE" || code === "EIO";
}

/** Create a stream writer that stops writing after EPIPE/EIO. */
export function createSafeStreamWriter(options: SafeStreamWriterOptions = {}): SafeStreamWriter {
  let closed = false;
  let notified = false;

  const noteBrokenPipe = (err: NodeJS.ErrnoException, stream: NodeJS.WriteStream) => {
    if (notified) {
      return;
    }
    notified = true;
    options.onBrokenPipe?.(err, stream);
  };

  const handleError = (err: unknown, stream: NodeJS.WriteStream): boolean => {
    if (!isBrokenPipeError(err)) {
      throw err;
    }
    closed = true;
    noteBrokenPipe(err, stream);
    return false;
  };

  const write = (stream: NodeJS.WriteStream, text: string): boolean => {
    if (closed) {
      return false;
    }
    try {
      options.beforeWrite?.();
    } catch (err) {
      return handleError(err, process.stderr);
    }
    try {
      stream.write(text);
      return !closed;
    } catch (err) {
      return handleError(err, stream);
    }
  };

  const writeLine = (stream: NodeJS.WriteStream, text: string): boolean =>
    write(stream, `${text}\n`);

  return {
    write,
    writeLine,
    reset: () => {
      closed = false;
      notified = false;
    },
    isClosed: () => closed,
  };
}
