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
        "Abseil",
        "AndroidX Compose",
        "AndroidX Media3",
        "AndroidX Room",
        "AndroidX Wear",
        "Bouncy Castle Provider",
        "Coil",
        "CommonMark Java",
        "dnsjava",
        "KaTeX",
        "Kotlin Libraries",
        "Manrope",
        "nibor autolink",
        "Oboe",
        "OkHttp and Okio",
        "Ooura FFT",
        "PFFFT",
        "RNNoise",
        "SLF4J API",
        "spl_sqrt_floor",
        "WebRTC Audio Processing",
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
    // The native engine compiles these into `libopenclaw_media.so`, so their
    // notices ship with the app rather than only WebRTC's top-level one.
    assertTrue(licenses.any { license -> license.title == "PFFFT" && license.text.contains("Julien Pommier") })
    assertTrue(licenses.any { license -> license.title == "RNNoise" && license.text.contains("Xiph.Org") })
    assertTrue(licenses.any { license -> license.title == "Ooura FFT" && license.text.contains("Takuya OOURA") })
    assertTrue(
      licenses.any { license -> license.title == "spl_sqrt_floor" && license.text.contains("Wilco Dijkstra") },
    )
  }
}
