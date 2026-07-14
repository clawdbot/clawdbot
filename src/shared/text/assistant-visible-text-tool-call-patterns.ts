// Shared regex/token constants for recognizing plain-text tool-call markup.

/**
 * Matches an opening or closing tag of a plain-text tool-call dialect, including
 * the namespaced `antml:`/`mm:` invoke/parameter forms models sometimes emit.
 */
export const TOOL_CALL_QUICK_RE =
  /<\s*\/?\s*(?:antml:|mm:)?(?:tool_call|tool_result|function_calls?|function_response|function|tool_calls|invoke|parameter)\b/i;

/** Tag names treated as tool-call markup for the stateful strip pass. */
export const TOOL_CALL_TAG_NAMES = new Set([
  "tool_call",
  "tool_result",
  "function_call",
  "function_calls",
  "function_response",
  "function",
  "tool_calls",
  "antml:invoke",
  "antml:parameter",
  "mm:invoke",
  "mm:parameter",
]);

export const TOOL_CALL_JSON_PAYLOAD_START_RE =
  /^(?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))*\s*(?:\r?\n\s*)?[[{]/;

export const TOOL_CALL_XML_PAYLOAD_START_RE =
  /^\s*(?:\r?\n\s*)?<(?:antml:|mm:)?(?:function_call|tool_call|function|invoke|parameters?|arguments?)\b/i;

export const NESTED_JSON_TOOL_CALL_PAYLOAD_START_RE =
  /^\s*(?:\r?\n\s*)?<(?:function_call|tool_call)\b/i;
