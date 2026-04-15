export function defaultToolStreamExtraParams(
  extraParams: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!extraParams) {
    return { tool_stream: true };
  }
  if (extraParams.tool_stream !== undefined) {
    return extraParams;
  }
  return {
    ...extraParams,
    tool_stream: true,
  };
}
