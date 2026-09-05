package ai.openclaw.app.ui

import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.NodeRuntime
import android.content.res.Configuration
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.security.MessageDigest

@RunWith(RobolectricTestRunner::class)
class ControlUiWebViewTest {
  @Test
  @Config(sdk = [31])
  fun viewportSizedPagesDoNotUseWrapContentLayout() {
    val mounted = mountControlUiWebView(AppearanceThemeMode.System)
    try {
      assertEquals(ViewGroup.LayoutParams.MATCH_PARENT, mounted.webView.layoutParams.height)
    } finally {
      mounted.close()
    }
  }

  @Test
  @Config(sdk = [31], qualifiers = "notnight")
  fun darkAndSystemAppearancesConfigureWebViewForLightSystem() {
    assertMountedAppearance(AppearanceThemeMode.Dark, dark = true)
    assertMountedAppearance(AppearanceThemeMode.System, dark = false)
  }

  @Test
  @Config(sdk = [31], qualifiers = "night")
  fun lightAndSystemAppearancesConfigureWebViewForDarkSystem() {
    assertMountedAppearance(AppearanceThemeMode.Light, dark = false)
    assertMountedAppearance(AppearanceThemeMode.System, dark = true)
  }

  @Test
  @Config(sdk = [31], qualifiers = "notnight")
  fun appearanceChangeRecreatesWebViewWithUpdatedTheme() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    var mode by mutableStateOf(AppearanceThemeMode.Dark)
    controller.get().setContent {
      OpenClawTheme(themeMode = mode) {
        TestControlUiWebView()
      }
    }
    idleMainLooper()
    val darkWebView = requireNotNull(findWebView(controller.get().window.decorView))
    assertWebViewAppearance(darkWebView, dark = true)

    mode = AppearanceThemeMode.Light
    idleMainLooper()
    val lightWebView = requireNotNull(findWebView(controller.get().window.decorView))
    assertNotSame(darkWebView, lightWebView)
    assertWebViewAppearance(lightWebView, dark = false)

    controller.pause().stop().destroy()
    idleMainLooper()
  }

  @Test
  @Config(sdk = [31])
  fun rendererLossDetachesDeadWebViewAndCreatesReplacement() {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    controller.get().setContent {
      OpenClawTheme(themeMode = AppearanceThemeMode.System) {
        TestControlUiWebView()
      }
    }
    idleMainLooper()
    val deadWebView = requireNotNull(findWebView(controller.get().window.decorView))

    assertTrue(
      deadWebView.webViewClient.onRenderProcessGone(
        deadWebView,
        CrashedRenderProcessDetail,
      ),
    )
    assertNull(deadWebView.parent)
    idleMainLooper()

    val replacement = requireNotNull(findWebView(controller.get().window.decorView))
    assertNotSame(deadWebView, replacement)

    controller.pause().stop().destroy()
    idleMainLooper()
  }

  @Test
  fun pinnedSslError_proceedsOnlyForExactCertificateAtGatewayOrigin() {
    val certificate = "accepted gateway certificate".toByteArray()
    val fingerprint = sha256Hex(certificate)

    assertTrue(
      shouldProceedForPinnedControlUiSslError(
        pageBaseUrl = "https://gateway.example.com:8443/openclaw/",
        expectedFingerprint = fingerprint,
        errorUrl = "https://gateway.example.com:8443/openclaw/assets/app.js",
        encodedCertificate = certificate,
      ),
    )
    assertFalse(
      shouldProceedForPinnedControlUiSslError(
        pageBaseUrl = "https://gateway.example.com:8443/openclaw/",
        expectedFingerprint = "00".repeat(32),
        errorUrl = "https://gateway.example.com:8443/openclaw/assets/app.js",
        encodedCertificate = certificate,
      ),
    )
    assertFalse(
      shouldProceedForPinnedControlUiSslError(
        pageBaseUrl = "https://gateway.example.com:8443/openclaw/",
        expectedFingerprint = fingerprint,
        errorUrl = "https://attacker.example.com:8443/openclaw/assets/app.js",
        encodedCertificate = certificate,
      ),
    )
    assertFalse(
      shouldProceedForPinnedControlUiSslError(
        pageBaseUrl = "https://gateway.example.com:8443/openclaw/",
        expectedFingerprint = null,
        errorUrl = "https://gateway.example.com:8443/openclaw/assets/app.js",
        encodedCertificate = certificate,
      ),
    )
  }

  private fun sha256Hex(bytes: ByteArray): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(bytes)
      .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }

  private fun mountControlUiWebView(themeMode: AppearanceThemeMode): MountedControlUiWebView {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    controller.get().setContent {
      OpenClawTheme(themeMode = themeMode) {
        TestControlUiWebView()
      }
    }
    idleMainLooper()
    return MountedControlUiWebView(
      controller = controller,
      webView = requireNotNull(findWebView(controller.get().window.decorView)),
    )
  }

  private fun assertMountedAppearance(
    themeMode: AppearanceThemeMode,
    dark: Boolean,
  ) {
    val mounted = mountControlUiWebView(themeMode)
    try {
      assertWebViewAppearance(mounted.webView, dark)
    } finally {
      mounted.close()
    }
  }

  private fun assertWebViewAppearance(
    webView: WebView,
    dark: Boolean,
  ) {
    val expectedNightMode = if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
    assertEquals(expectedNightMode, webView.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK)

    val attributes = webView.context.theme.obtainStyledAttributes(intArrayOf(android.R.attr.isLightTheme))
    try {
      assertEquals(!dark, attributes.getBoolean(0, true))
    } finally {
      attributes.recycle()
    }
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view !is ViewGroup) return null
    for (index in 0 until view.childCount) {
      findWebView(view.getChildAt(index))?.let { return it }
    }
    return null
  }

  private fun idleMainLooper() = shadowOf(Looper.getMainLooper()).idle()

  private data class MountedControlUiWebView(
    val controller: org.robolectric.android.controller.ActivityController<ComponentActivity>,
    val webView: WebView,
  ) {
    fun close() {
      controller.pause().stop().destroy()
      shadowOf(Looper.getMainLooper()).idle()
    }
  }
}

@Suppress("DEPRECATION")
private object CrashedRenderProcessDetail : RenderProcessGoneDetail() {
  override fun didCrash(): Boolean = true

  override fun rendererPriorityAtExit(): Int = WebView.RENDERER_PRIORITY_IMPORTANT
}

@androidx.compose.runtime.Composable
private fun TestControlUiWebView() {
  ControlUiWebView(
    page =
      NodeRuntime.GatewayControlPage(
        baseUrl = "http://127.0.0.1",
        token = null,
        password = null,
        tlsFingerprintSha256 = null,
      ),
    url = "about:blank",
  )
}
