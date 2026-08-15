package ai.openclaw.app.gateway

/**
 * Canonical device-auth payload builder shared with gateway verification rules.
 */
internal object DeviceAuthPayload {
  /** Builds the canonical v3 auth string signed by device registration flows. */
  fun buildV3(
    deviceId: String,
    clientId: String,
    clientMode: String,
    role: String,
    scopes: List<String>,
    signedAtMs: Long,
    token: String?,
    nonce: String,
    platform: String?,
    deviceFamily: String?,
  ): String {
    val scopeString = scopes.joinToString(",")
    val authToken = token.orEmpty()
    val platformNorm = normalizeMetadataField(platform)
    val deviceFamilyNorm = normalizeMetadataField(deviceFamily)
    return listOf(
      "v3",
      deviceId,
      clientId,
      clientMode,
      role,
      scopeString,
      signedAtMs.toString(),
      authToken,
      nonce,
      platformNorm,
      deviceFamilyNorm,
    ).joinToString("|")
  }

  /** Normalizes signed metadata fields without locale-sensitive lowercasing. */
  internal fun normalizeMetadataField(value: String?): String {
    val trimmed = value?.trim().orEmpty()
    if (trimmed.isEmpty()) {
      return ""
    }
    // Keep cross-runtime normalization deterministic (TS/Swift/Kotlin):
    // lowercase ASCII A-Z only for auth payload metadata fields.
    val out = StringBuilder(trimmed.length)
    for (ch in trimmed) {
      if (ch in 'A'..'Z') {
        out.append((ch.code + 32).toChar())
      } else {
        out.append(ch)
      }
    }
    return out.toString()
  }
}
