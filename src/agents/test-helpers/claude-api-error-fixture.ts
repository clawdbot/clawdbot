const CLAUDE_API_ERROR_MESSAGE =
  "Third-party apps now draw from your extra usage, not your plan limits. We've added a $200 credit to get you started. Claim it at claude.ai/settings/usage and keep going.";

export function createClaudeApiErrorFixture() {
  const apiError = `API Error: 400 ${JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: CLAUDE_API_ERROR_MESSAGE,
    },
    request_id: "req_011CZqHuXhFetYCnr8325DQc",
  })}`;

  return {
    message: CLAUDE_API_ERROR_MESSAGE,
    apiError,
    jsonl: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "session-api-error" }),
      JSON.stringify({
        type: "assistant",
        message: {
          model: "<synthetic>",
          role: "assistant",
          content: [{ type: "text", text: apiError }],
        },
        session_id: "session-api-error",
        error: "unknown",
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: apiError,
        session_id: "session-api-error",
      }),
    ].join("\n"),
  };
}
