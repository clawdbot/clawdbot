package ai.openclaw.app

/** Normalizes blank gateway session keys to the legacy main session alias. */
internal fun normalizeMainKey(raw: String?): String {
  val trimmed = raw?.trim()
  return if (!trimmed.isNullOrEmpty()) trimmed else "main"
}

/** Accepts only gateway session keys that can represent the main chat stream. */
internal fun isCanonicalMainSessionKey(raw: String?): Boolean {
  val trimmed = raw?.trim().orEmpty()
  if (trimmed.isEmpty()) return false
  if (trimmed == "global") return true
  return trimmed.startsWith("agent:")
}

/** Extracts the agent id from canonical agent-scoped main session keys. */
internal fun resolveAgentIdFromMainSessionKey(raw: String?): String? {
  val trimmed = raw?.trim().orEmpty()
  if (!trimmed.startsWith("agent:")) return null
  return trimmed
    .removePrefix("agent:")
    .substringBefore(':')
    .trim()
    .ifEmpty { null }
}

/** Builds the node session key shape consumed by gateway chat and presence APIs. */
internal fun buildNodeMainSessionKey(
  deviceId: String,
  agentId: String?,
): String {
  val resolvedAgentId = agentId?.trim().orEmpty().ifEmpty { "main" }
  return "agent:$resolvedAgentId:node-${deviceId.take(12)}"
}
