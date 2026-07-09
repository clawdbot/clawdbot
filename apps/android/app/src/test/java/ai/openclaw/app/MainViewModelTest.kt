package ai.openclaw.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MainViewModelTest {
  @Test
  fun foregroundStartupRequiresForegroundAndCompletedOnboarding() {
    assertFalse(
      shouldStartRuntimeOnForeground(
        foreground = false,
        onboardingCompleted = true,
      ),
    )
    assertFalse(
      shouldStartRuntimeOnForeground(
        foreground = true,
        onboardingCompleted = false,
      ),
    )
    assertFalse(
      shouldStartRuntimeOnForeground(
        foreground = false,
        onboardingCompleted = false,
      ),
    )
    assertTrue(
      shouldStartRuntimeOnForeground(
        foreground = true,
        onboardingCompleted = true,
      ),
    )
  }
}
