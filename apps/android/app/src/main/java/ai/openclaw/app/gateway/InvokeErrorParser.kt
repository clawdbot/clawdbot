package ai.openclaw.app.gateway

data class ParsedInvokeError(
  val code: String,
  val message: String,
  val hadExplicitCode: Boolean,
) {
  /** Gateway-facing form expected by UI and retry copy. */
  val prefixedMessage: String
    get() = "$code: $message"
}

/**
 * Parses gateway invoke errors encoded as CODE: message while preserving legacy
 * plain-text errors as UNAVAILABLE.
 */
fun parseInvokeErrorMessage(raw: String): ParsedInvokeError {
  val trimmed = raw.trim()
  if (trimmed.isEmpty()) {
    return ParsedInvokeError(code = "UNAVAILABLE", message = "error", hadExplicitCode = false)
  }

  val parts = trimmed.split(":", limit = 2)
  if (parts.size == 2) {
    val code = parts[0].trim()
    val rest = parts[1].trim()
    if (code.isNotEmpty() && code.all { it.isUpperCase() || it == '_' }) {
      return ParsedInvokeError(
        code = code,
        message = rest.ifEmpty { trimmed },
        hadExplicitCode = true,
      )
    }
  }
  return ParsedInvokeError(code = "UNAVAILABLE", message = trimmed, hadExplicitCode = false)
}

/** Extracts an invoke error from a throwable without exposing blank messages. */
fun parseInvokeErrorFromThrowable(
  err: Throwable,
  fallbackMessage: String = "error",
): ParsedInvokeError {
  val raw = err.message?.trim().takeIf { !it.isNullOrEmpty() } ?: fallbackMessage
  return parseInvokeErrorMessage(raw)
}
