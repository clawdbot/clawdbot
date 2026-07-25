package ai.openclaw.app.node

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class CanvasControllerPresentationTest {
  @Test
  fun presentationStateKeepsTheHostUnmountedUntilFirstShow() {
    val controller = CanvasController()

    controller.hide()
    assertEquals(CanvasController.PresentationState.Unmounted, controller.presentationState.value)

    controller.show()
    assertEquals(CanvasController.PresentationState.Visible, controller.presentationState.value)

    controller.hide()
    assertEquals(CanvasController.PresentationState.Hidden, controller.presentationState.value)

    controller.show()
    assertEquals(CanvasController.PresentationState.Visible, controller.presentationState.value)

    controller.releaseHost()
    assertEquals(CanvasController.PresentationState.Unmounted, controller.presentationState.value)
  }

  @Test
  fun failedHostHandoffRestoresThePreviousPresentationState() =
    runTest {
      val controller = CanvasController()

      assertFalse(controller.showAndAwaitHost())

      assertEquals(CanvasController.PresentationState.Unmounted, controller.presentationState.value)
    }
}
