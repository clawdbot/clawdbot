package ai.openclaw.app.ui

import android.graphics.Rect
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.LayoutDirection
import androidx.window.layout.FoldingFeature
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class WindowLayoutTest {
  private val host = IntRect(0, 0, 1000, 800)

  @Test
  fun absentOutsideAndNonSeparatingFeaturesPreserveTheWholeHost() {
    for (features in listOf(
      emptyList(),
      listOf(testFold(Rect(1100, 0, 1120, 800))),
      listOf(testFold(Rect(0, 900, 1000, 920))),
      listOf(testFold(Rect(1000, 0, 1000, 800))),
      listOf(testFold(Rect(500, 0, 500, 800), separating = false, state = FoldingFeature.State.FLAT)),
    )) {
      assertEquals(host, foldSafeRegion(host, features, LayoutDirection.Ltr))
    }
  }

  @Test
  fun hingeBoundsDetermineTheLargestRegionIncludingFlatAndZeroThicknessSeparators() {
    val cases =
      listOf(
        testFold(Rect(490, 0, 510, 800)) to IntRect(0, 0, 490, 800),
        testFold(Rect(0, 390, 1000, 410)) to IntRect(0, 0, 1000, 390),
        testFold(Rect(200, 0, 220, 800)) to IntRect(220, 0, 1000, 800),
        testFold(Rect(0, 200, 1000, 230)) to IntRect(0, 230, 1000, 800),
        testFold(Rect(500, 0, 500, 800)) to IntRect(0, 0, 500, 800),
        testFold(Rect(0, 400, 1000, 400)) to IntRect(0, 0, 1000, 400),
        testFold(Rect(490, 0, 510, 800), state = FoldingFeature.State.FLAT) to IntRect(0, 0, 490, 800),
        testFold(Rect(200, 0, 230, 800), separating = false, occlusion = FoldingFeature.OcclusionType.FULL) to IntRect(230, 0, 1000, 800),
      )
    for ((fold, expected) in cases) {
      assertEquals("Feature ${fold.bounds}", expected, foldSafeRegion(host, listOf(fold), LayoutDirection.Ltr))
    }
  }

  @Test
  fun tiesPreferTopThenLogicalStartWithoutMirroringPhysicalBounds() {
    val vertical = listOf(testFold(Rect(490, 0, 510, 800)))
    assertEquals(IntRect(510, 0, 1000, 800), foldSafeRegion(host, vertical, LayoutDirection.Rtl))
    val horizontal = listOf(testFold(Rect(0, 390, 1000, 410)))
    assertEquals(IntRect(0, 0, 1000, 390), foldSafeRegion(host, horizontal, LayoutDirection.Rtl))
  }

  @Test
  fun translatedHostsIntersectActualFeatureBoundsIncludingPartialEnds() {
    val translated = IntRect(100, 200, 1100, 1000)
    assertEquals(
      IntRect(620, 200, 1100, 1000),
      foldSafeRegion(translated, listOf(testFold(Rect(580, 0, 620, 1200))), LayoutDirection.Rtl),
    )
    assertEquals(
      IntRect(100, 300, 1100, 1000),
      foldSafeRegion(translated, listOf(testFold(Rect(580, 0, 620, 300))), LayoutDirection.Ltr),
    )
    assertEquals(
      translated,
      foldSafeRegion(translated, listOf(testFold(Rect(580, 0, 620, 190))), LayoutDirection.Ltr),
    )
  }

  @Test
  fun laterSeparatorsCanMakeTheInitiallySmallerRegionWin() {
    val folds =
      listOf(
        testFold(Rect(400, 0, 420, 800)),
        testFold(Rect(650, 0, 670, 800)),
        testFold(Rect(800, 0, 820, 800)),
      )
    for (order in listOf(folds, folds.reversed(), listOf(folds[1], folds[0], folds[2]))) {
      assertEquals(IntRect(0, 0, 400, 800), foldSafeRegion(host, order, LayoutDirection.Ltr))
    }
    val cross = listOf(testFold(Rect(490, 0, 510, 800)), testFold(Rect(0, 300, 1000, 320)))
    assertEquals(IntRect(0, 320, 490, 800), foldSafeRegion(host, cross, LayoutDirection.Ltr))
    assertEquals(IntRect(510, 320, 1000, 800), foldSafeRegion(host, cross.reversed(), LayoutDirection.Rtl))
  }
}

internal fun testFold(
  bounds: Rect,
  separating: Boolean = true,
  occlusion: FoldingFeature.OcclusionType = FoldingFeature.OcclusionType.NONE,
  state: FoldingFeature.State = FoldingFeature.State.HALF_OPENED,
): FoldingFeature =
  object : FoldingFeature {
    override val bounds = Rect(bounds)
    override val isSeparating = separating
    override val occlusionType = occlusion
    override val state = state
    override val orientation =
      if (bounds.width() > bounds.height()) FoldingFeature.Orientation.HORIZONTAL else FoldingFeature.Orientation.VERTICAL
  }
