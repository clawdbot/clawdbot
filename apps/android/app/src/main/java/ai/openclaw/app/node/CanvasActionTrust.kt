package ai.openclaw.app.node

import java.net.URI

object CanvasActionTrust {
  const val scaffoldAssetUrl: String = "file:///android_asset/CanvasScaffold/scaffold.html"

  fun isTrustedCanvasActionUrl(
    rawUrl: String?,
    trustedA2uiUrls: List<String>,
  ): Boolean {
    val candidate = rawUrl?.trim().orEmpty()
    if (candidate.isEmpty()) return false
    if (candidate == scaffoldAssetUrl) return true

    val candidateUri = parseUri(candidate) ?: return false
    if (candidateUri.scheme.equals("file", ignoreCase = true)) {
      return false
    }
    val normalizedCandidate = normalizeTrustedRemoteA2uiUri(candidateUri) ?: return false

    return trustedA2uiUrls.any { trusted ->
      matchesTrustedRemoteA2uiUrlExact(normalizedCandidate, trusted)
    }
  }

  private fun matchesTrustedRemoteA2uiUrlExact(
    candidateUri: URI,
    trustedUrl: String,
  ): Boolean {
    val trustedUri = parseUri(trustedUrl) ?: return false
    val normalizedTrusted = normalizeTrustedRemoteA2uiUri(trustedUri) ?: return false
    return candidateUri == normalizedTrusted
  }

  private fun normalizeTrustedRemoteA2uiUri(uri: URI): URI? {
    // Keep Android trust normalization aligned with iOS ScreenController:
    // exact remote URL match, scheme/host normalized, fragment ignored.
    val scheme = uri.scheme?.lowercase() ?: return null
    if (scheme != "http" && scheme != "https") return null

    val host =
      uri.host
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
        ?.lowercase() ?: return null

    return try {
      URI(scheme, uri.userInfo, host, uri.port, uri.rawPath, uri.rawQuery, null)
    } catch (_: Throwable) {
      null
    }
  }

  private fun parseUri(raw: String): URI? =
    try {
      URI(raw)
    } catch (_: Throwable) {
      null
    }
}
