package ai.openclaw.app.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatWidgetExportTest {
  @Test
  fun sanitizesWidgetTitleForPngFileName() {
    assertEquals("Quarterly report 2026.png", widgetExportFileName("  Quarterly/report:*2026?  "))
    assertEquals("Résumé 📈.png", widgetExportFileName("Résumé 📈"))
  }

  @Test
  fun fallsBackWhenWidgetTitleHasNoSafeCharacters() {
    assertEquals("widget.png", widgetExportFileName(null))
    assertEquals("widget.png", widgetExportFileName(" .. /:*? "))
  }

  @Test
  fun boundsWidgetTitleToCodePointAndUtf8ByteLimits() {
    val fileName = widgetExportFileName("📈".repeat(100))
    val stem = fileName.removeSuffix(".png")

    assertEquals(30, stem.codePointCount(0, stem.length))
    assertTrue(fileName.toByteArray(Charsets.UTF_8).size <= 255)
    assertTrue(!Character.isHighSurrogate(stem.last()))
    assertTrue(fileName.endsWith(".png"))
  }

  @Test
  fun keepsAsciiFileNameBehaviorWithinTheUtf8Budget() {
    assertEquals("a".repeat(80) + ".png", widgetExportFileName("a".repeat(100)))
  }

  @Test
  fun requiresACompleteGlobalVisibleRectForPixelCopy() {
    assertTrue(
      canCaptureWithPixelCopy(
        hasGlobalVisibleRect = true,
        visibleWidth = 320,
        visibleHeight = 180,
        viewWidth = 320,
        viewHeight = 180,
      ),
    )
    assertTrue(
      !canCaptureWithPixelCopy(
        hasGlobalVisibleRect = true,
        visibleWidth = 319,
        visibleHeight = 180,
        viewWidth = 320,
        viewHeight = 180,
      ),
    )
    assertTrue(
      !canCaptureWithPixelCopy(
        hasGlobalVisibleRect = true,
        visibleWidth = 320,
        visibleHeight = 179,
        viewWidth = 320,
        viewHeight = 180,
      ),
    )
    assertTrue(
      !canCaptureWithPixelCopy(
        hasGlobalVisibleRect = false,
        visibleWidth = 320,
        visibleHeight = 180,
        viewWidth = 320,
        viewHeight = 180,
      ),
    )
  }

  @Test
  fun prunesOnlyExpiredExportsOlderThanTheNewestExport() {
    val nowMillis = 2 * 24 * 60 * 60 * 1000L
    val expiredMillis = nowMillis - 24 * 60 * 60 * 1000L - 1
    val newestMillis = nowMillis - 60 * 60 * 1000L

    assertTrue(shouldPruneWidgetExportDirectory(expiredMillis, newestMillis, nowMillis))
    assertTrue(!shouldPruneWidgetExportDirectory(newestMillis, newestMillis, nowMillis))
    assertTrue(!shouldPruneWidgetExportDirectory(expiredMillis, expiredMillis, nowMillis))
    assertTrue(!shouldPruneWidgetExportDirectory(nowMillis - 24 * 60 * 60 * 1000L, nowMillis, nowMillis))
  }
}
