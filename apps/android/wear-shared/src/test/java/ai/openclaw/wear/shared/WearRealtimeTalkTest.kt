package ai.openclaw.wear.shared

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream

class WearRealtimeTalkTest {
  @Test
  fun audioFramesRoundTripAndPreserveBoundaries() {
    val output = ByteArrayOutputStream()
    WearRealtimeAudioFraming.write(output, WearRealtimeAudioFrameType.INPUT_PCM, byteArrayOf(1, 2, 3, 4))
    WearRealtimeAudioFraming.write(output, WearRealtimeAudioFrameType.CLEAR_OUTPUT, byteArrayOf())
    val input = ByteArrayInputStream(output.toByteArray())

    val audio = WearRealtimeAudioFraming.read(input)!!
    assertEquals(WearRealtimeAudioFrameType.INPUT_PCM, audio.type)
    assertArrayEquals(byteArrayOf(1, 2, 3, 4), audio.payload)
    assertEquals(WearRealtimeAudioFrameType.CLEAR_OUTPUT, WearRealtimeAudioFraming.read(input)!!.type)
    assertNull(WearRealtimeAudioFraming.read(input))
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsOversizedFrameBeforeAllocatingPayload() {
    val output = ByteArrayOutputStream()
    DataOutputStream(output).apply {
      writeByte(WearRealtimeAudioFrameType.INPUT_PCM.wireValue)
      writeInt(WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES + 1)
    }
    WearRealtimeAudioFraming.read(ByteArrayInputStream(output.toByteArray()))
  }
}
