export function readBoundedResponseText(
  response: unknown,
  label: unknown,
  byteLimit: unknown,
  timeoutPromise?: Promise<never>,
): Promise<string>;
