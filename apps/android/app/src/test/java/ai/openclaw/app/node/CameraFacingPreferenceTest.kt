package ai.openclaw.app.node

import org.junit.Assert.assertEquals
import org.junit.Test

class CameraFacingPreferenceTest {
  @Test
  fun explicitFacingWinsOverPreference() {
    assertEquals("front", resolveCameraFacing(explicitFacing = "front", preferredFacing = "back"))
    assertEquals("back", resolveCameraFacing(explicitFacing = "back", preferredFacing = "front"))
  }

  @Test
  fun preferenceProvidesSafeDefault() {
    assertEquals("back", resolveCameraFacing(explicitFacing = null, preferredFacing = "back"))
    assertEquals("front", resolveCameraFacing(explicitFacing = null, preferredFacing = "side"))
  }
}
