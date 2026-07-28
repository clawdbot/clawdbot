/** Read response text while enforcing max bytes before and during streaming. */
export function readBoundedResponseText(
  response: unknown,
  label: unknown,
  maxBytes: unknown,
  options?: Record<string, unknown>,
): Promise<string>;
