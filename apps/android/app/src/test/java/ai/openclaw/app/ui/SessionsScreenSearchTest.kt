package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionsScreenSearchTest {
  @Test
  fun blankSearchKeepsTheFilterSpecificEmptyState() {
    assertEquals(SessionEmptyMode.Filter, sessionEmptyMode("", loading = false))
    assertEquals(SessionEmptyMode.Filter, sessionEmptyMode("   ", loading = true))
  }

  @Test
  fun nonBlankSearchDistinguishesLoadingFromNoMatches() {
    assertEquals(SessionEmptyMode.SearchLoading, sessionEmptyMode("zzproof", loading = true))
    assertEquals(SessionEmptyMode.SearchNoMatches, sessionEmptyMode("zzproof", loading = false))
  }
}
