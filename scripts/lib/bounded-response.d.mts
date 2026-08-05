export type BoundedResponseOptions = {
  createTooLargeError?: (message: string) => Error;
  formatTooLargeMessage?: (label: string, maxBytes: number) => string;
  signal?: AbortSignal;
  timeoutPromise?: Promise<never>;
};

export function createBoundedResponseTooLargeError(message: string): Error & { code: "ETOOBIG" };
export function readBoundedResponseBytes(
  response: Response,
  label: string,
  maxBytes: number,
  options?: BoundedResponseOptions,
): Promise<Buffer>;
export function readBoundedResponseText(
  response: Response,
  label: string,
  maxBytes: number,
  options?: BoundedResponseOptions,
): Promise<string>;
