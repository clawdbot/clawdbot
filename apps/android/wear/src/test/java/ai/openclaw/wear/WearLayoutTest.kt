package ai.openclaw.wear

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test

class WearLayoutTest {
  @Test
  fun voiceLayoutFitsSmallAndLargeRoundScreens() {
    assertEquals(
      WearVoiceLayout(
        horizontalPadding = 6.dp,
        orbSize = 80.dp,
        contentHeight = 144.dp,
      ),
      wearVoiceLayout(maxWidth = 192.dp, fontScale = 1f),
    )
    assertEquals(
      WearVoiceLayout(
        horizontalPadding = 6.dp,
        orbSize = 92.dp,
        contentHeight = 156.dp,
      ),
      wearVoiceLayout(maxWidth = 227.dp, fontScale = 1f),
    )
  }

  @Test
  fun voiceLayoutMakesRoomForLargeTextOnSmallRoundScreens() {
    assertEquals(
      WearVoiceLayout(
        horizontalPadding = 4.dp,
        orbSize = 68.dp,
        contentHeight = 132.dp,
      ),
      wearVoiceLayout(maxWidth = 192.dp, fontScale = 1.2f),
    )
  }
}
