package ai.openclaw.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderModelStatusTest {
  @Test
  fun staticProviderStatusIsReady() {
    assertTrue(modelProviderReady("static"))
  }

  @Test
  fun missingProviderStatusIsNotReady() {
    assertFalse(modelProviderReady("missing"))
  }
}
