package ai.openclaw.app.node

/**
 * Trust helper for WebView-originated canvas/A2UI actions.
 */
object CanvasActionTrust {
  /** Local canvas scaffold is the only trusted file URL. */
  const val scaffoldAssetUrl: String = "file:///android_asset/CanvasScaffold/scaffold.html"

  /** Local bundled A2UI is the only action-capable A2UI host. */
  const val localA2uiAssetUrl: String = "file:///android_asset/CanvasA2UI/index.html"

  /** Accepts only app-owned bundled pages. Remote WebView content is render-only. */
  fun isTrustedCanvasActionUrl(rawUrl: String?): Boolean {
    val candidate = rawUrl?.trim().orEmpty()
    if (candidate.isEmpty()) return false
    if (candidate == scaffoldAssetUrl) return true
    if (candidate == localA2uiAssetUrl) return true
    return false
  }
}
