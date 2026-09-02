package ai.openclaw.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class AndroidLicenseNoticesTest {
  @Test
  fun isAndroidLicenseFileName_acceptsTxtOnly() {
    assertTrue(isAndroidLicenseFileName("MANROPE_OFL.txt"))
    assertTrue(isAndroidLicenseFileName("notice.TXT"))
    assertEquals(false, isAndroidLicenseFileName("notice.md"))
    assertEquals(false, isAndroidLicenseFileName("notice"))
  }

  @Test
  fun androidLicenseTitleFromFileName_usesExactFileNameStem() {
    assertEquals("Manrope", androidLicenseTitleFromFileName("Manrope.txt"))
    assertEquals("OkHttp and Okio", androidLicenseTitleFromFileName("OkHttp and Okio.txt"))
    assertEquals("SLF4J API", androidLicenseTitleFromFileName("SLF4J API.TXT"))
  }

  @Test
  fun androidLicenseTitleFromFileName_fallsBackForBlankStem() {
    assertEquals("License", androidLicenseTitleFromFileName(".txt"))
  }

  @Test
  fun loadAndroidLicenseNotices_readsPackagedTxtAssets() {
    val context = RuntimeEnvironment.getApplication()
    val licenses = loadAndroidLicenseNotices(context.assets)

    assertEquals(
      listOf(
        "Accompanist Drawable Painter",
        "AndroidSVG",
        "AndroidX CameraX",
        "AndroidX Compose",
        "AndroidX Media3",
        "AndroidX Room",
        "AndroidX SQLite",
        "AndroidX Wear",
        "Bouncy Castle Provider",
        "Coil",
        "CommonMark Java",
        "cose-base",
        "cytoscape",
        "cytoscape-cose-bilkent",
        "cytoscape-fcose",
        "d3",
        "d3-array",
        "d3-axis",
        "d3-brush",
        "d3-chord",
        "d3-color",
        "d3-contour",
        "d3-delaunay",
        "d3-dispatch",
        "d3-drag",
        "d3-dsv",
        "d3-ease",
        "d3-fetch",
        "d3-force",
        "d3-format",
        "d3-geo",
        "d3-hierarchy",
        "d3-interpolate",
        "d3-path",
        "d3-polygon",
        "d3-quadtree",
        "d3-random",
        "d3-sankey",
        "d3-scale",
        "d3-scale-chromatic",
        "d3-selection",
        "d3-shape",
        "d3-time",
        "d3-time-format",
        "d3-timer",
        "d3-transition",
        "d3-zoom",
        "dagre-d3-es",
        "dayjs",
        "dnsjava",
        "DOMPurify",
        "es-toolkit",
        "fastdom",
        "hachure-fill",
        "Iconify Utils",
        "internmap",
        "JamaJS",
        "js-yaml",
        "KaTeX",
        "khroma",
        "Kotlin Libraries",
        "layout-base",
        "lodash-es",
        "Manrope",
        "Markdown",
        "Marked",
        "Mermaid",
        "nibor autolink",
        "OkHttp and Okio",
        "path-data-parser",
        "points-on-curve",
        "points-on-path",
        "roughjs",
        "sanitize-url",
        "SLF4J API",
        "stylis",
        "ts-dedent",
        "uuid",
        "venn.js",
      ),
      licenses.map { license -> license.title },
    )
    assertEquals(false, licenses.any { license -> license.text.startsWith("Title:") })
    assertTrue(licenses.any { license -> license.text.contains("SIL Open Font License") })
    assertTrue(licenses.any { license -> license.text.contains("Apache License") })
    assertTrue(licenses.any { license -> license.text.contains("BSD 2-Clause") })
    assertTrue(licenses.any { license -> license.text.contains("BSD 3-Clause") })
    assertTrue(licenses.any { license -> license.text.contains("MIT License") })
    assertTrue(licenses.any { license -> license.text.contains("Bouncy Castle Licence") })
    assertTrue(licenses.any { license -> license.title == "Coil" && license.text.contains("Coil Contributors") })
  }
}
