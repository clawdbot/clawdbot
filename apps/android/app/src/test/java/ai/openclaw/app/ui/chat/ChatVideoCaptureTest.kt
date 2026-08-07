package ai.openclaw.app.ui.chat

import android.app.Activity
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatVideoCaptureTest {
  @Test
  fun captureContractMapsResultCodes() {
    val contract = CaptureVideoToUri()
    assertTrue(contract.parseResult(Activity.RESULT_OK, null))
    assertFalse(contract.parseResult(Activity.RESULT_CANCELED, null))
    assertFalse(contract.parseResult(Activity.RESULT_FIRST_USER, null))
  }
}
