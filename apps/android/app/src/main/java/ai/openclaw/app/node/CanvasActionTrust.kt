package ai.openclaw.app.node

import java.net.URI

/**
 * Trust helper for WebView-originated canvas/A2UI actions.
 */
object CanvasActionTrust {
  /** Local canvas scaffold is the only trusted file URL. */
  const val scaffoldAssetUrl: String = "file:///android_asset/CanvasScaffold/scaffold.html"

  /** Accepts local scaffold or exact remote A2UI URLs advertised by the gateway. */
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
    // Gateway-advertised URLs are capabilities. Treat malformed entries as
    // absent instead of broadening trust to same-origin or prefix matches.
    val trustedUri = parseUri(trustedUrl) ?: return false
    val normalizedTrusted = normalizeTrustedRemoteA2uiUri(trustedUri) ?: return false
    return candidateUri == normalizedTrusted
  }

  /** Normalizes only the URL parts allowed to vary across trusted remote A2UI URLs. */
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

  /** Parses untrusted WebView/gateway URL text without throwing into UI event handlers. */
  private fun parseUri(raw: String): URI? =
    try {
      URI(raw)
    } catch (_: Throwable) {
      null
    }
}
