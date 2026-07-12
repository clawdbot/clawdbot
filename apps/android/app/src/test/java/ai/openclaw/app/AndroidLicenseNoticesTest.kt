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
        "AndroidX Room",
        "Bouncy Castle Provider",
        "Coil",
        "CommonMark Java",
        "dnsjava",
        "KaTeX",
        "Kotlin Libraries",
        "Manrope",
        "nibor autolink",
        "OkHttp and Okio",
        "SLF4J API",
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
