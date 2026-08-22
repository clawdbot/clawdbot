package ai.openclaw.app.voice

import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

private const val tag = "RealtimeCapture"

/** The only capture encoding this endpoint can produce for `talk.session.appendAudio`. */
internal const val REALTIME_WIRE_AUDIO_ENCODING_PCM16 = "pcm16"

/**
 * The wire rate assumed when `talk.session.create` declares no audio contract at all.
 *
 * The field is optional in the shared schema (`TalkSessionCreateResultSchema.audio`), so an older
 * Gateway peer can omit it, and the iOS relay client resolves that same absence to PCM16 at this
 * rate (`RealtimeTalkRelaySession.configureAudioContract`). A contract that is present but says
 * something else is never resolved here -- absence is the only case this default covers.
 */
internal const val REALTIME_LEGACY_WIRE_SAMPLE_RATE_HZ = 24_000

/** Highest capture-to-wire ratio the anti-alias filter is built for; 192 kHz down to 24 kHz. */
private const val MAX_CAPTURE_DECIMATION = 8

/** Filter length per decimation step. Longer than the minimum, and still trivial per frame. */
private const val CAPTURE_FILTER_TAPS_PER_STEP = 16

/** The audio format Android must hand to the Gateway, as the Gateway declared it. */
internal sealed interface RealtimeWireAudioContract {
  /** Usable: little-endian PCM16 mono at [sampleRateHz]. */
  data class Pcm16(
    val sampleRateHz: Int,
  ) : RealtimeWireAudioContract

  /** Declared, but not something this endpoint can produce. The session must fail closed. */
  data class Unsupported(
    val detail: String,
  ) : RealtimeWireAudioContract
}

/**
 * Reads the wire audio contract out of a `talk.session.create` result.
 *
 * An absent `audio` field is the legacy relay format (see [REALTIME_LEGACY_WIRE_SAMPLE_RATE_HZ]).
 * A field that is present is taken literally: anything this endpoint cannot produce becomes
 * [RealtimeWireAudioContract.Unsupported] rather than quietly falling back, because falling back
 * would mean sending PCM at a clock the Gateway never asked for.
 */
internal fun parseRealtimeWireAudioContract(
  root: JsonObject?,
  playbackSampleRateHz: Int,
): RealtimeWireAudioContract {
  val declared = root?.get("audio")
  // An explicit null is absence, not a declaration -- the same reading the iOS relay client takes.
  if (declared == null || declared is JsonNull) {
    return RealtimeWireAudioContract.Pcm16(REALTIME_LEGACY_WIRE_SAMPLE_RATE_HZ)
  }
  val audio = declared as? JsonObject ?: return RealtimeWireAudioContract.Unsupported("audio is not an object")
  val encoding = (audio["inputEncoding"] as? JsonPrimitive)?.takeIf { it.isString }?.content
  if (encoding != REALTIME_WIRE_AUDIO_ENCODING_PCM16) {
    return RealtimeWireAudioContract.Unsupported("inputEncoding=$encoding")
  }
  // A JSON string is not an integer. The schema declares this field as one, and accepting a
  // quoted rate here while rejecting a quoted encoding above would be an accident, not a policy.
  val sampleRateHz = (audio["inputSampleRateHz"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toIntOrNull()
  if (sampleRateHz == null || sampleRateHz <= 0) {
    return RealtimeWireAudioContract.Unsupported("inputSampleRateHz=${audio["inputSampleRateHz"]}")
  }
  // Playback plays the declared downlink verbatim at a fixed rate. This phase does not make that
  // rate dynamic, so a contract whose downlink half this endpoint cannot honor is rejected rather
  // than accepted and then played at the wrong clock.
  val outputEncoding = (audio["outputEncoding"] as? JsonPrimitive)?.takeIf { it.isString }?.content
  if (outputEncoding != null && outputEncoding != REALTIME_WIRE_AUDIO_ENCODING_PCM16) {
    return RealtimeWireAudioContract.Unsupported("outputEncoding=$outputEncoding")
  }
  val outputSampleRateHz = (audio["outputSampleRateHz"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toIntOrNull()
  if (outputSampleRateHz != null && outputSampleRateHz != playbackSampleRateHz) {
    return RealtimeWireAudioContract.Unsupported("outputSampleRateHz=$outputSampleRateHz")
  }
  return RealtimeWireAudioContract.Pcm16(sampleRateHz)
}

/**
 * The rates to try opening the microphone at, in order.
 *
 * The preferred rate comes first because it is the one the hardware is most likely to deliver
 * unprocessed; the wire rate is the compatibility fallback, and needs no conversion when the
 * recorder actually grants it. A device that only supports one of the two is served by the other.
 */
internal fun realtimeCaptureCandidateRatesHz(
  preferredRateHz: Int,
  wireRateHz: Int,
): List<Int> = listOf(preferredRateHz, wireRateHz).distinct()

/** What a capture candidate has to expose to be judged, plus the way to release it. */
internal interface RealtimeCaptureCandidate : AutoCloseable {
  /** The rate the recorder negotiated. It need not be the rate that was requested. */
  val actualSampleRateHz: Int
}

/** One opened capture session, together with the converter its negotiated rate resolved to. */
internal class RealtimeCaptureSelection<T : RealtimeCaptureCandidate>(
  val candidate: T,
  val resampler: RealtimeCaptureResampler,
  val requestedSampleRateHz: Int,
  val captureSampleRateHz: Int,
)

/**
 * Opens the first candidate rate this device can both deliver and convert to [wireRateHz].
 *
 * A candidate is judged on the rate the recorder *negotiated*, never on the rate that was asked
 * for: a recorder that opens at a different but convertible rate is a working microphone, and
 * rejecting it would cost Talk a route the device can still serve. A candidate that opens but
 * cannot be converted is closed before the next one is tried, so no recorder outlives its
 * rejection. Throws when no candidate is usable, rather than letting capture run at a clock the
 * Gateway did not ask for.
 */
internal fun <T : RealtimeCaptureCandidate> selectRealtimeCaptureSession(
  candidateRatesHz: List<Int>,
  wireRateHz: Int,
  open: (sampleRateHz: Int) -> T,
): RealtimeCaptureSelection<T> {
  // Whether a rate is convertible is knowable before the microphone is touched, and opening a
  // recorder is not free: it claims the process-wide communication route, which on Bluetooth is an
  // audible toggle. Skip the rates that provably cannot work -- unless that leaves nothing, in
  // which case a recorder may still negotiate something usable and is worth asking.
  val convertible = candidateRatesHz.filter { resolveRealtimeCaptureResampler(it, wireRateHz) != null }
  var lastFailure: Throwable? = null
  for (requestedRateHz in convertible.ifEmpty { candidateRatesHz }) {
    val candidate =
      try {
        open(requestedRateHz)
      } catch (err: CancellationException) {
        throw err
      } catch (err: RuntimeException) {
        Log.w(tag, "capture candidate ${requestedRateHz}Hz did not open: ${err.message ?: err::class.simpleName}")
        lastFailure = err
        continue
      }
    val captureSampleRateHz = candidate.actualSampleRateHz
    val resampler = resolveRealtimeCaptureResampler(captureSampleRateHz, wireRateHz)
    if (resampler != null) {
      if (captureSampleRateHz != requestedRateHz) {
        Log.d(tag, "capture negotiated ${captureSampleRateHz}Hz for a ${requestedRateHz}Hz request")
      }
      return RealtimeCaptureSelection(
        candidate = candidate,
        resampler = resampler,
        requestedSampleRateHz = requestedRateHz,
        captureSampleRateHz = captureSampleRateHz,
      )
    }
    Log.w(tag, "capture at ${captureSampleRateHz}Hz cannot be converted to the ${wireRateHz}Hz wire rate")
    runCatching { candidate.close() }
    lastFailure = IllegalStateException("microphone audio cannot be converted to this session's format")
  }
  throw lastFailure ?: IllegalStateException("no usable microphone capture rate")
}

/**
 * Resolves the converter for [captureRateHz] -> [wireRateHz], or null when this endpoint cannot
 * do it.
 *
 * Only exact integer downsampling is supported, which covers the two rates capture actually asks
 * for -- the portable preferred rate and the wire rate itself -- plus any whole multiple of the
 * wire rate a recorder might negotiate instead. Anything else (a fractional ratio such as 44.1 kHz
 * to 24 kHz, or a rate below the wire rate) is deliberately not converted here: the caller has a
 * second candidate to fall back on, and a wrong-clock or upsampled stream would be worse than
 * using it.
 */
internal fun resolveRealtimeCaptureResampler(
  captureRateHz: Int,
  wireRateHz: Int,
): RealtimeCaptureResampler? {
  if (captureRateHz <= 0 || wireRateHz <= 0) return null
  if (captureRateHz % wireRateHz != 0) return null
  val decimation = captureRateHz / wireRateHz
  if (decimation > MAX_CAPTURE_DECIMATION) return null
  return RealtimeCaptureResampler(decimation)
}

/**
 * Converts one capture session's little-endian PCM16 mono stream to the Gateway wire rate.
 *
 * Sits downstream of everything Android does to the captured signal: it consumes exactly what
 * `AudioRecord.read` returns, so any platform capture processing has already been applied and
 * nothing has to move when that processing changes.
 *
 * All state -- filter history, decimation phase, and a carried odd byte -- belongs to one capture
 * session. A new session gets a new instance, so nothing survives a restart.
 */
internal class RealtimeCaptureResampler(
  private val decimation: Int,
) {
  private val taps: FloatArray = if (decimation <= 1) FloatArray(0) else antiAliasTaps(decimation)
  private val history = FloatArray((taps.size - 1).coerceAtLeast(0))
  private var phase = 0
  private var carriedByte: Byte = 0
  private var hasCarriedByte = false

  /**
   * Consumes the first [length] bytes of [input] and returns wire-rate PCM16.
   *
   * Callers hand this every captured frame, including frames the forwarding policy will drop, so
   * the filter sees one continuous stream rather than one with holes punched in it.
   */
  fun convert(
    input: ByteArray,
    length: Int,
  ): ByteArray {
    val samples = takeSamples(input, length.coerceIn(0, input.size))
    if (samples.isEmpty()) return EMPTY_AUDIO
    if (decimation == 1) return encodeSamples(samples, samples.size)

    val historyLength = history.size
    val window = FloatArray(historyLength + samples.size)
    history.copyInto(window)
    for (index in samples.indices) window[historyLength + index] = samples[index].toFloat()

    val output = ShortArray((phase + samples.size) / decimation)
    var produced = 0
    var nextPhase = phase
    for (index in samples.indices) {
      nextPhase += 1
      if (nextPhase < decimation) continue
      nextPhase = 0
      val newest = historyLength + index
      var accumulator = 0f
      for (tap in taps.indices) accumulator += taps[tap] * window[newest - tap]
      output[produced] = clampToPcm16(accumulator)
      produced += 1
    }
    phase = nextPhase
    window.copyInto(history, destinationOffset = 0, startIndex = samples.size, endIndex = samples.size + historyLength)
    return encodeSamples(output, produced)
  }

  /**
   * Decodes complete little-endian samples, carrying a trailing odd byte into the next call.
   *
   * `AudioRecord.read` returns a byte count, not a frame count. Dropping a straggling byte would
   * shift every later sample by one byte and turn the whole stream into noise, so it is kept.
   */
  private fun takeSamples(
    input: ByteArray,
    length: Int,
  ): ShortArray {
    val prefix = if (hasCarriedByte) 1 else 0
    val total = prefix + length
    val sampleCount = total / 2
    hasCarriedByte = total % 2 == 1
    val samples = ShortArray(sampleCount)
    for (index in 0 until sampleCount) {
      val low: Int
      val high: Int
      val base = index * 2 - prefix
      if (base < 0) {
        low = carriedByte.toInt() and 0xff
        high = input[0].toInt()
      } else {
        low = input[base].toInt() and 0xff
        high = input[base + 1].toInt()
      }
      samples[index] = (low or (high shl 8)).toShort()
    }
    // A zero-length read leaves an outstanding carry exactly as it was; there is no new last byte.
    if (hasCarriedByte && length > 0) carriedByte = input[length - 1]
    return samples
  }

  private companion object {
    val EMPTY_AUDIO = ByteArray(0)

    /**
     * Windowed-sinc lowpass at the decimated Nyquist, normalized to unity gain at DC.
     *
     * Decimating without it folds everything above the new Nyquist back into the speech band; the
     * Hamming window keeps that fold far enough down that it does not survive as audible content.
     */
    fun antiAliasTaps(decimation: Int): FloatArray {
      val tapCount = CAPTURE_FILTER_TAPS_PER_STEP * decimation + 1
      val center = (tapCount - 1) / 2.0
      // Below the decimated Nyquist rather than exactly on it, so the window's transition band
      // lands inside the stopband instead of straddling the fold point.
      val cutoff = 0.45 / decimation
      val raw = DoubleArray(tapCount)
      var gain = 0.0
      for (index in 0 until tapCount) {
        val offset = index - center
        val ideal = if (offset == 0.0) 2.0 * cutoff else sin(2.0 * PI * cutoff * offset) / (PI * offset)
        val window = 0.54 - 0.46 * cos(2.0 * PI * index / (tapCount - 1))
        raw[index] = ideal * window
        gain += raw[index]
      }
      return FloatArray(tapCount) { (raw[it] / gain).toFloat() }
    }

    fun clampToPcm16(value: Float): Short = value.roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()

    fun encodeSamples(
      samples: ShortArray,
      count: Int,
    ): ByteArray {
      val bytes = ByteArray(count * 2)
      for (index in 0 until count) {
        val sample = samples[index].toInt()
        bytes[index * 2] = (sample and 0xff).toByte()
        bytes[index * 2 + 1] = ((sample shr 8) and 0xff).toByte()
      }
      return bytes
    }
  }
}
