package ai.openclaw.wear.shared

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream

@Serializable
data class WearRealtimeTalkSnapshot(
  val attemptId: String? = null,
  val active: Boolean = false,
  val listening: Boolean = false,
  val speaking: Boolean = false,
  val status: WearRealtimeTalkStatus = WearRealtimeTalkStatus.OFF,
  val statusText: String = "Off",
  val conversation: List<WearRealtimeTalkEntry> = emptyList(),
)

@Serializable
data class WearRealtimeTalkEntry(
  val id: String,
  val role: WearRealtimeTalkRole,
  val text: String,
  val streaming: Boolean = false,
)

@Serializable
enum class WearRealtimeTalkRole { USER, ASSISTANT }

@Serializable
enum class WearRealtimeTalkStatus { OFF, CONNECTING, LISTENING, THINKING, SPEAKING, ERROR }

object WearRealtimeTalkCodec {
  private val json =
    Json {
      encodeDefaults = true
      explicitNulls = false
      ignoreUnknownKeys = true
    }

  fun encode(snapshot: WearRealtimeTalkSnapshot): JsonElement = json.encodeToJsonElement(WearRealtimeTalkSnapshot.serializer(), snapshot)

  fun decode(payload: JsonElement): WearRealtimeTalkSnapshot = json.decodeFromJsonElement(WearRealtimeTalkSnapshot.serializer(), payload)
}

enum class WearRealtimeAudioFrameType(
  val wireValue: Int,
) {
  INPUT_PCM(1),
  OUTPUT_PCM(2),
  CLEAR_OUTPUT(3),
  ;

  companion object {
    fun fromWireValue(value: Int): WearRealtimeAudioFrameType? = entries.firstOrNull { it.wireValue == value }
  }
}

data class WearRealtimeAudioFrame(
  val type: WearRealtimeAudioFrameType,
  val payload: ByteArray,
)

object WearRealtimeAudioFraming {
  fun write(
    output: OutputStream,
    type: WearRealtimeAudioFrameType,
    payload: ByteArray,
  ) {
    requireValid(type, payload)
    DataOutputStream(output).apply {
      writeByte(type.wireValue)
      writeInt(payload.size)
      write(payload)
      flush()
    }
  }

  fun read(input: InputStream): WearRealtimeAudioFrame? {
    val stream = DataInputStream(input)
    val typeValue = stream.read()
    if (typeValue < 0) return null
    val type =
      WearRealtimeAudioFrameType.fromWireValue(typeValue)
        ?: throw IllegalArgumentException("Unknown Wear realtime audio frame type")
    val size =
      try {
        stream.readInt()
      } catch (err: EOFException) {
        throw IllegalArgumentException("Truncated Wear realtime audio frame", err)
      }
    if (size < 0 || size > WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES) {
      throw IllegalArgumentException("Invalid Wear realtime audio frame size")
    }
    val payload = ByteArray(size)
    try {
      stream.readFully(payload)
    } catch (err: EOFException) {
      throw IllegalArgumentException("Truncated Wear realtime audio payload", err)
    }
    requireValid(type, payload)
    return WearRealtimeAudioFrame(type, payload)
  }

  private fun requireValid(
    type: WearRealtimeAudioFrameType,
    payload: ByteArray,
  ) {
    require(payload.size <= WearProtocol.MAX_REALTIME_AUDIO_FRAME_BYTES)
    when (type) {
      WearRealtimeAudioFrameType.INPUT_PCM,
      WearRealtimeAudioFrameType.OUTPUT_PCM,
      -> require(payload.isNotEmpty() && payload.size % 2 == 0)
      WearRealtimeAudioFrameType.CLEAR_OUTPUT -> require(payload.isEmpty())
    }
  }
}
