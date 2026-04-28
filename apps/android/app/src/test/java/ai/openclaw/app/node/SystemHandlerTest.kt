package ai.openclaw.app.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SystemHandlerTest {
  @Test
  fun handleSystemNotify_rejectsUnauthorized() {
    val handler = SystemHandler.forTesting(poster = FakePoster(authorized = false))

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"hi"}""")

    assertFalse(result.ok)
    assertEquals("NOT_AUTHORIZED", result.error?.code)
  }

  @Test
  fun handleSystemNotify_rejectsEmptyNotification() {
    val handler = SystemHandler.forTesting(poster = FakePoster(authorized = true))

    val result = handler.handleSystemNotify("""{"title":"   ","body":"  "}""")

    assertFalse(result.ok)
    assertEquals("INVALID_REQUEST", result.error?.code)
  }

  @Test
  fun handleSystemNotify_rejectsInvalidRequestObject() {
    val handler = SystemHandler.forTesting(poster = FakePoster(authorized = true))

    val result = handler.handleSystemNotify("""{"title":"OpenClaw"}""")

    assertFalse(result.ok)
    assertEquals("INVALID_REQUEST", result.error?.code)
  }

  @Test
  fun handleSystemNotify_postsNotification() {
    val poster = FakePoster(authorized = true)
    val handler = SystemHandler.forTesting(poster = poster)

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"done","priority":"active"}""")

    assertTrue(result.ok)
    assertEquals(1, poster.posts)
  }

  @Test
  fun handleSystemNotify_trimsAndPassesOptionalFields() {
    val poster = FakePoster(authorized = true)
    val handler = SystemHandler.forTesting(poster = poster)

    val result =
      handler.handleSystemNotify(
        """{"title":" OpenClaw ","body":" done ","priority":" passive ","sound":" silent "}""",
      )

    assertTrue(result.ok)
    assertEquals("OpenClaw", poster.lastRequest?.title)
    assertEquals("done", poster.lastRequest?.body)
    assertEquals("passive", poster.lastRequest?.priority)
    assertEquals("silent", poster.lastRequest?.sound)
  }

  @Test
  fun handleSystemNotify_returnsUnauthorizedWhenPostFailsPermission() {
    val handler = SystemHandler.forTesting(poster = ThrowingPoster(authorized = true, error = SecurityException("denied")))

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"done"}""")

    assertFalse(result.ok)
    assertEquals("NOT_AUTHORIZED", result.error?.code)
  }

  @Test
  fun handleSystemNotify_returnsUnavailableWhenPostFailsUnexpectedly() {
    val handler = SystemHandler.forTesting(poster = ThrowingPoster(authorized = true, error = IllegalStateException("boom")))

    val result = handler.handleSystemNotify("""{"title":"OpenClaw","body":"done"}""")

    assertFalse(result.ok)
    assertEquals("UNAVAILABLE", result.error?.code)
    assertEquals("NOTIFICATION_FAILED: boom", result.error?.message)
  }
}

private class FakePoster(
  private val authorized: Boolean,
) : SystemNotificationPoster {
  var posts: Int = 0
    private set
  var lastRequest: SystemNotifyRequest? = null
    private set

  override fun isAuthorized(): Boolean = authorized

  override fun post(request: SystemNotifyRequest) {
    posts += 1
    lastRequest = request
  }
}

private class ThrowingPoster(
  private val authorized: Boolean,
  private val error: Throwable,
) : SystemNotificationPoster {
  override fun isAuthorized(): Boolean = authorized

  override fun post(request: SystemNotifyRequest): Unit = throw error
}
