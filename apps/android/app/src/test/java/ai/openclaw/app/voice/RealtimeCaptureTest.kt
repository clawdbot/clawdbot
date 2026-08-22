package ai.openclaw.app.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream
import kotlin.math.PI
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Covers the capture-rate contract: the rate the Gateway declares, the rate the microphone is
 * asked for, and the rate it actually negotiates are three separate things, and only the last one
 * may decide how captured audio is converted.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RealtimeCaptureTest {
  // ---- wire contract ----------------------------------------------------------------------

  @Test
  fun anAbsentAudioContractResolvesToTheLegacyRelayFormat() {
    val contract = parseRealtimeWireAudioContract(jsonObject("""{"relaySessionId":"relay-1"}"""), playbackSampleRateHz = 24_000)

    assertEquals(RealtimeWireAudioContract.Pcm16(REALTIME_LEGACY_WIRE_SAMPLE_RATE_HZ), contract)
    assertEquals(24_000, REALTIME_LEGACY_WIRE_SAMPLE_RATE_HZ)
  }

  @Test
  fun aDeclaredContractIsTakenExactlyAsDeclared() {
    val contract =
      parseRealtimeWireAudioContract(
        jsonObject(
          """
          {"relaySessionId":"relay-1","audio":{"inputEncoding":"pcm16","inputSampleRateHz":24000,
           "outputEncoding":"pcm16","outputSampleRateHz":24000}}
          """.trimIndent(),
        ),
        playbackSampleRateHz = 24_000,
      )

    assertEquals(RealtimeWireAudioContract.Pcm16(24_000), contract)
  }

  @Test
  fun anExplicitNullAudioFieldIsAbsenceRatherThanAMalformedContract() {
    // A peer that serializes optional fields as explicit null must not be treated as declaring
    // something unsupported; the iOS relay client reads it the same way.
    val contract =
      parseRealtimeWireAudioContract(
        jsonObject("""{"relaySessionId":"relay-1","audio":null}"""),
        playbackSampleRateHz = 24_000,
      )

    assertEquals(RealtimeWireAudioContract.Pcm16(REALTIME_LEGACY_WIRE_SAMPLE_RATE_HZ), contract)
  }

  @Test
  fun aDeclaredRateOtherThanTheLegacyOneIsHonoredRatherThanAssumed() {
    val contract =
      parseRealtimeWireAudioContract(
        jsonObject("""{"audio":{"inputEncoding":"pcm16","inputSampleRateHz":16000}}"""),
        playbackSampleRateHz = 24_000,
      )

    assertEquals(RealtimeWireAudioContract.Pcm16(16_000), contract)
  }

  @Test
  fun aContractThisEndpointCannotProduceFailsClosedInsteadOfFallingBack() {
    // Each of these is present, so the legacy default must not rescue it: producing PCM16 anyway
    // would put audio on the wire at a clock or in a format the Gateway never asked for.
    val rejected =
      listOf(
        """{"audio":{"inputEncoding":"g711_ulaw","inputSampleRateHz":8000}}""",
        """{"audio":{"inputEncoding":"pcm16"}}""",
        """{"audio":{"inputEncoding":"pcm16","inputSampleRateHz":0}}""",
        """{"audio":{"inputEncoding":"pcm16","inputSampleRateHz":"not-a-number"}}""",
        """{"audio":{"inputSampleRateHz":24000}}""",
        """{"audio":"pcm16"}""",
        """{"audio":{"inputEncoding":"pcm16","inputSampleRateHz":"24000"}}""",
        """{"audio":{"inputEncoding":"pcm16","inputSampleRateHz":24000,"outputEncoding":"g711_ulaw"}}""",
        """{"audio":{"inputEncoding":"pcm16","inputSampleRateHz":24000,"outputSampleRateHz":8000}}""",
      )

    for (payload in rejected) {
      val contract = parseRealtimeWireAudioContract(jsonObject(payload), playbackSampleRateHz = 24_000)
      assertTrue("$payload resolved to $contract", contract is RealtimeWireAudioContract.Unsupported)
    }
  }

  // ---- candidate selection ----------------------------------------------------------------

  @Test
  fun thePreferredRateIsTriedFirstAndTheWireRateIsTheFallback() {
    assertEquals(listOf(48_000, 24_000), realtimeCaptureCandidateRatesHz(48_000, 24_000))
  }

  @Test
  fun aPreferredRateEqualToTheWireRateIsAttemptedOnce() {
    assertEquals(listOf(24_000), realtimeCaptureCandidateRatesHz(24_000, 24_000))

    val opener = FakeCaptureOpener { requested -> requested }
    val selection = selectRealtimeCaptureSession(realtimeCaptureCandidateRatesHz(24_000, 24_000), 24_000, opener::open)

    assertEquals(listOf(24_000), opener.requestedRates)
    assertEquals(24_000, selection.captureSampleRateHz)
  }

  @Test
  fun thePreferredRateIsUsedWhenTheRecorderGrantsIt() {
    val opener = FakeCaptureOpener { requested -> requested }

    val selection = selectRealtimeCaptureSession(listOf(48_000, 24_000), 24_000, opener::open)

    assertEquals(listOf(48_000), opener.requestedRates)
    assertEquals(48_000, selection.requestedSampleRateHz)
    assertEquals(48_000, selection.captureSampleRateHz)
    assertEquals(2_400 * 2, selection.resampler.convert(pcm16Bytes(ShortArray(4_800)), 9_600).size)
  }

  @Test
  fun aRecorderThatNegotiatesADifferentButConvertibleRateIsAccepted() {
    // The #124083 P1 regression, in both directions the recorder can move: down onto the wire rate
    // itself, and up onto a whole multiple of it. Neither is a broken microphone, and asserting
    // requested == actual is what previously turned each of them into a dead Talk session.
    for (negotiated in listOf(24_000, 96_000)) {
      val opener = FakeCaptureOpener { _ -> negotiated }

      val selection = selectRealtimeCaptureSession(listOf(48_000, 24_000), 24_000, opener::open)

      assertEquals(listOf(48_000), opener.requestedRates)
      assertEquals(48_000, selection.requestedSampleRateHz)
      assertEquals(negotiated, selection.captureSampleRateHz)
      assertEquals(0, opener.opened.single().closeCalls)
      // The converter came from the negotiated rate: 100 ms in is 100 ms out at the wire rate.
      val input = pcm16Bytes(ShortArray(negotiated / 10))
      assertEquals(2_400 * 2, selection.resampler.convert(input, input.size).size)
    }
  }

  @Test
  fun aRateThatCannotPossiblyConvertIsNotOpenedAtAll() {
    // Opening claims the process-wide communication route, which on Bluetooth is audible. A rate
    // that cannot convert is knowable without touching the microphone, so it must not be asked for.
    val opener = FakeCaptureOpener { requested -> requested }

    val selection = selectRealtimeCaptureSession(listOf(44_100, 48_000, 24_000), 24_000, opener::open)

    assertEquals(listOf(48_000), opener.requestedRates)
    assertEquals(48_000, selection.captureSampleRateHz)
  }

  @Test
  fun everyCandidateBeingUnconvertibleStillAsksTheRecorderInCaseItNegotiatesSomethingElse() {
    // With nothing left to pre-filter to, the recorder is still worth asking: the rate it grants
    // is the one that decides, and it need not be the one that was requested.
    val opener = FakeCaptureOpener { _ -> 24_000 }

    val selection = selectRealtimeCaptureSession(listOf(44_100, 22_050), 24_000, opener::open)

    assertEquals(listOf(44_100), opener.requestedRates)
    assertEquals(24_000, selection.captureSampleRateHz)
  }

  @Test
  fun aCandidateWhoseNegotiatedRateCannotBeConvertedIsClosedAndTheNextOneIsTried() {
    val opener = FakeCaptureOpener { requested -> if (requested == 48_000) 44_100 else requested }

    val selection = selectRealtimeCaptureSession(listOf(48_000, 24_000), 24_000, opener::open)

    assertEquals(listOf(48_000, 24_000), opener.requestedRates)
    assertEquals(24_000, selection.captureSampleRateHz)
    // The rejected recorder is released exactly once, and the accepted one is left open.
    assertEquals(1, opener.opened[0].closeCalls)
    assertEquals(0, opener.opened[1].closeCalls)
  }

  @Test
  fun aCandidateThatCannotOpenAtAllFallsThroughToTheNextOne() {
    val opener =
      FakeCaptureOpener { requested ->
        if (requested == 48_000) throw UnsupportedOperationException("cannot open 48 kHz") else requested
      }

    val selection = selectRealtimeCaptureSession(listOf(48_000, 24_000), 24_000, opener::open)

    assertEquals(listOf(48_000, 24_000), opener.requestedRates)
    assertEquals(24_000, selection.captureSampleRateHz)
    assertEquals(1, opener.opened.size)
    assertEquals(0, opener.opened.single().closeCalls)
  }

  @Test
  fun everyCandidateBeingUnusableFailsClosedAndLeavesNoRecorderOpen() {
    val opener = FakeCaptureOpener { _ -> 44_100 }

    val failure =
      runCatching { selectRealtimeCaptureSession(listOf(48_000, 24_000), 24_000, opener::open) }.exceptionOrNull()

    assertTrue("expected a capture failure, got $failure", failure is IllegalStateException)
    assertEquals(listOf(48_000, 24_000), opener.requestedRates)
    assertEquals(listOf(1, 1), opener.opened.map { it.closeCalls })
  }

  @Test
  fun anOpenFailureIsReportedWhenNoLaterCandidateSucceeds() {
    val opener = FakeCaptureOpener { _ -> throw UnsupportedOperationException("no microphone") }

    val failure =
      runCatching { selectRealtimeCaptureSession(listOf(48_000, 24_000), 24_000, opener::open) }.exceptionOrNull()

    assertTrue("expected the open failure to surface, got $failure", failure is UnsupportedOperationException)
    assertEquals(0, opener.opened.size)
  }

  // ---- converter resolution ---------------------------------------------------------------

  @Test
  fun onlyExactIntegerDownsamplingResolves() {
    assertEquals(4_800, resolveRealtimeCaptureResampler(48_000, 24_000)!!.convert(pcm16Bytes(ShortArray(4_800)), 9_600).size)
    assertNull(resolveRealtimeCaptureResampler(44_100, 24_000))
    assertNull(resolveRealtimeCaptureResampler(16_000, 24_000))
    assertNull(resolveRealtimeCaptureResampler(0, 24_000))
    assertNull(resolveRealtimeCaptureResampler(48_000, 0))
    // Beyond the ratio the anti-alias filter is built for.
    assertNull(resolveRealtimeCaptureResampler(24_000 * 9, 24_000))
  }

  // ---- converter behavior -----------------------------------------------------------------

  @Test
  fun equalRatesPassThroughByteForByte() {
    val resampler = resolveRealtimeCaptureResampler(24_000, 24_000)!!
    val audio = pcm16Bytes(sine(freqHz = 440.0, sampleRateHz = 24_000, count = 2_400, amplitude = 12_000.0))

    assertArrayEquals(audio, resampler.convert(audio, audio.size))
  }

  @Test
  fun oneFrameOfCaptureBecomesOneFrameOfWireAudio() {
    // 100 ms at 48 kHz is 4,800 samples in and 2,400 samples out; the frame represents the wire
    // rate, not the capture rate, or uplink pacing drifts against the provider's clock.
    val resampler = resolveRealtimeCaptureResampler(48_000, 24_000)!!
    val frame = pcm16Bytes(sine(freqHz = 1_000.0, sampleRateHz = 48_000, count = 4_800, amplitude = 8_000.0))

    assertEquals(2_400 * 2, resampler.convert(frame, frame.size).size)

    // And it stays exact across the next frames rather than drifting by a sample.
    assertEquals(2_400 * 2, resampler.convert(frame, frame.size).size)
    assertEquals(2_400 * 2, resampler.convert(frame, frame.size).size)
  }

  @Test
  fun unevenChunkBoundariesProduceTheSameStreamAsOneShotConversion() {
    val audio = pcm16Bytes(sine(freqHz = 300.0, sampleRateHz = 48_000, count = 9_600, amplitude = 15_000.0))
    val oneShot = resolveRealtimeCaptureResampler(48_000, 24_000)!!.convert(audio, audio.size)

    // Odd sizes on purpose: AudioRecord returns a byte count, not a frame count, so a chunk can
    // split a sample in half and the converter has to carry that byte rather than drop it.
    val piecemeal = resolveRealtimeCaptureResampler(48_000, 24_000)!!
    val collected = ByteArrayOutputStream()
    var offset = 0
    val chunkSizes = intArrayOf(1, 37, 2, 501, 1_199, 4_001, 3, 999)
    var chunkIndex = 0
    while (offset < audio.size) {
      val size = minOf(chunkSizes[chunkIndex % chunkSizes.size], audio.size - offset)
      collected.write(piecemeal.convert(audio.copyOfRange(offset, offset + size), size))
      offset += size
      chunkIndex += 1
    }

    assertArrayEquals(oneShot, collected.toByteArray())
  }

  @Test
  fun aZeroLengthReadDoesNotDisturbACarriedByte() {
    val audio = pcm16Bytes(sine(freqHz = 300.0, sampleRateHz = 48_000, count = 4_800, amplitude = 15_000.0))
    val oneShot = resolveRealtimeCaptureResampler(48_000, 24_000)!!.convert(audio, audio.size)

    val piecemeal = resolveRealtimeCaptureResampler(48_000, 24_000)!!
    val collected = ByteArrayOutputStream()
    collected.write(piecemeal.convert(audio.copyOfRange(0, 101), 101))
    collected.write(piecemeal.convert(ByteArray(0), 0))
    collected.write(piecemeal.convert(audio.copyOfRange(101, audio.size), audio.size - 101))

    assertArrayEquals(oneShot, collected.toByteArray())
  }

  @Test
  fun converterStateIsRetainedWithinASessionAndScopedToTheInstance() {
    val first = pcm16Bytes(sine(freqHz = 900.0, sampleRateHz = 48_000, count = 4_800, amplitude = 15_000.0))
    val second = pcm16Bytes(sine(freqHz = 300.0, sampleRateHz = 48_000, count = 4_800, amplitude = 15_000.0))

    val freshA = resolveRealtimeCaptureResampler(48_000, 24_000)!!.convert(second, second.size)
    val freshB = resolveRealtimeCaptureResampler(48_000, 24_000)!!.convert(second, second.size)
    assertArrayEquals("two new sessions must agree", freshA, freshB)

    val carriedOver = resolveRealtimeCaptureResampler(48_000, 24_000)!!
    carriedOver.convert(first, first.size)
    val afterPriorAudio = carriedOver.convert(second, second.size)

    // Filter history really is retained inside an instance -- which is exactly why a restart must
    // get a new one. That a capture restart does build a new one is a property of the manager, and
    // is covered by aCaptureInstallBuildsItsConverterFromTheNegotiatedRate below.
    assertNotEquals(freshA.toList(), afterPriorAudio.toList())
  }

  // ---- DSP properties the production path depends on --------------------------------------

  @Test
  fun outOfBandContentIsRejectedRatherThanFoldedBackIntoSpeech() {
    // 18 kHz at a 48 kHz capture rate lands at 6 kHz -- squarely in the speech band -- if the
    // stream is simply decimated. Anti-aliasing before decimating is the whole reason the
    // converter is not a sample-dropping loop.
    val tone = sine(freqHz = 18_000.0, sampleRateHz = 48_000, count = 48_000, amplitude = 20_000.0)
    val filtered = decodePcm16(resolveRealtimeCaptureResampler(48_000, 24_000)!!.convert(pcm16Bytes(tone), tone.size * 2))
    val naive = ShortArray(tone.size / 2) { tone[it * 2] }

    val filteredRms = rms(filtered, skip = 200)
    val naiveRms = rms(naive, skip = 200)

    assertTrue("naive decimation should keep the aliased tone, got $naiveRms", naiveRms > 10_000.0)
    assertTrue("alias survived filtering: filtered=$filteredRms naive=$naiveRms", filteredRms < naiveRms * 0.05)
  }

  @Test
  fun inBandSpeechKeepsItsLevel() {
    val resampler = resolveRealtimeCaptureResampler(48_000, 24_000)!!
    val tone = sine(freqHz = 300.0, sampleRateHz = 48_000, count = 48_000, amplitude = 12_000.0)

    val converted = decodePcm16(resampler.convert(pcm16Bytes(tone), tone.size * 2))

    val expectedRms = 12_000.0 / sqrt(2.0)
    val actualRms = rms(converted, skip = 200)
    assertTrue("300 Hz lost level: expected ~$expectedRms got $actualRms", actualRms > expectedRms * 0.97)
    assertTrue("300 Hz gained level: expected ~$expectedRms got $actualRms", actualRms < expectedRms * 1.03)
  }

  @Test
  fun aConstantSignalPassesThroughAtUnityGain() {
    val resampler = resolveRealtimeCaptureResampler(48_000, 24_000)!!
    val dc = ShortArray(9_600) { 1_000 }

    val converted = decodePcm16(resampler.convert(pcm16Bytes(dc), dc.size * 2))

    // Past the filter's start-up transient the output must be the input value, not a scaled one.
    for (index in 200 until converted.size) {
      assertEquals("sample $index", 1_000, converted[index].toInt())
    }
  }

  @Test
  fun filterOvershootSaturatesInsteadOfWrapping() {
    val resampler = resolveRealtimeCaptureResampler(48_000, 24_000)!!
    // A step to full scale makes a windowed-sinc ring past the rail on the far side of the edge.
    // Real capture reaches full scale on loud speech, so this is the signal shape that decides
    // whether that overshoot is saturated or truncated.
    val step = ShortArray(9_600) { index -> if (index < 96) 0 else Short.MAX_VALUE }

    val converted = decodePcm16(resampler.convert(pcm16Bytes(step), step.size * 2))

    assertTrue(converted.isNotEmpty())
    // Ringing around the edge is a few percent of full scale and correct. Truncating instead of
    // saturating turns an overshoot of 32767+n into roughly -32768+n, which is not a few percent.
    val lowest = converted.minOrNull()!!
    assertTrue("overshoot wrapped to $lowest", lowest > -16_000)
    assertEquals("the output never reached the rail, so clamping was not exercised", Short.MAX_VALUE, converted.maxOrNull())
    assertEquals(Short.MAX_VALUE, converted.last())
  }
}

// ---- helpers --------------------------------------------------------------------------------

private fun jsonObject(payload: String): JsonObject = Json.parseToJsonElement(payload) as JsonObject

private class FakeCaptureCandidate(
  override val actualSampleRateHz: Int,
) : RealtimeCaptureCandidate {
  var closeCalls = 0

  override fun close() {
    closeCalls += 1
  }
}

/** Records what was asked for and what was handed back, so leaks and retries are observable. */
private class FakeCaptureOpener(
  private val negotiate: (requestedSampleRateHz: Int) -> Int,
) {
  val requestedRates = mutableListOf<Int>()
  val opened = mutableListOf<FakeCaptureCandidate>()

  fun open(requestedSampleRateHz: Int): FakeCaptureCandidate {
    requestedRates += requestedSampleRateHz
    val actual = negotiate(requestedSampleRateHz)
    return FakeCaptureCandidate(actual).also { opened += it }
  }
}

private fun sine(
  freqHz: Double,
  sampleRateHz: Int,
  count: Int,
  amplitude: Double,
): ShortArray = ShortArray(count) { index -> (sin(2.0 * PI * freqHz * index / sampleRateHz) * amplitude).roundToInt().toShort() }

private fun pcm16Bytes(samples: ShortArray): ByteArray {
  val bytes = ByteArray(samples.size * 2)
  for (index in samples.indices) {
    val sample = samples[index].toInt()
    bytes[index * 2] = (sample and 0xff).toByte()
    bytes[index * 2 + 1] = ((sample shr 8) and 0xff).toByte()
  }
  return bytes
}

private fun decodePcm16(bytes: ByteArray): ShortArray =
  ShortArray(bytes.size / 2) { index ->
    val low = bytes[index * 2].toInt() and 0xff
    val high = bytes[index * 2 + 1].toInt()
    (low or (high shl 8)).toShort()
  }

private fun rms(
  samples: ShortArray,
  skip: Int,
): Double {
  var total = 0.0
  var counted = 0
  for (index in skip until samples.size) {
    val value = samples[index].toDouble()
    total += value * value
    counted += 1
  }
  return if (counted == 0) 0.0 else sqrt(total / counted)
}
