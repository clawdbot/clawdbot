package ai.openclaw.app

internal fun normalizeMainKey(raw: String?): String {
  val trimmed = raw?.trim()
  return if (!trimmed.isNullOrEmpty()) trimmed else "main"
}

internal fun isCanonicalMainSessionKey(raw: String?): Boolean {
  val trimmed = raw?.trim().orEmpty()
  if (trimmed.isEmpty()) return false
  if (trimmed == "global") return true
  return trimmed.startsWith("agent:")
}

internal fun resolveAgentIdFromMainSessionKey(raw: String?): String? {
  val trimmed = raw?.trim().orEmpty()
  if (!trimmed.startsWith("agent:")) return null
  return trimmed
    .removePrefix("agent:")
    .substringBefore(':')
    .trim()
    .ifEmpty { null }
}

internal fun buildNodeMainSessionKey(
  deviceId: String,
  agentId: String?,
): String {
  val resolvedAgentId = agentId?.trim().orEmpty().ifEmpty { "main" }
  return "agent:$resolvedAgentId:node-${deviceId.take(12)}"
}
