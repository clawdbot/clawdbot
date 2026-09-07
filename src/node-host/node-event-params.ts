/** Build node.event params, shared by the invoke dispatcher and the runtime. */
export function buildNodeEventParams(
  event: string,
  payload: unknown,
): { event: string; payloadJSON: string | null } {
  const payloadJSON = payload === undefined ? undefined : JSON.stringify(payload);
  return {
    event,
    payloadJSON: typeof payloadJSON === "string" ? payloadJSON : null,
  };
}
