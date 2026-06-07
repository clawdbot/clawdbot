package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsScreensTest {
  @Test
  fun androidDistributionChannelUsesBuildFlavorLabels() {
    assertEquals("Play", androidDistributionChannel("play"))
    assertEquals("Third-party", androidDistributionChannel("thirdParty"))
    assertEquals("Unknown", androidDistributionChannel(""))
  }
}
