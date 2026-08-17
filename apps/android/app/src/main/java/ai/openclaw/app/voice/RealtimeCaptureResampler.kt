package ai.openclaw.app.voice

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Converts little-endian PCM16 mono audio from a device-portable hardware
 * capture rate to the realtime wire rate the Gateway declared in
 * talk.session.create's audio contract. Android hardware capture and the
 * realtime wire format are separate invariants (Android 14 CDD only
 * guarantees 16k/44.1k/48k raw PCM capture; the wire rate is whatever the
 * Gateway configured for the provider) and must never be conflated by
 * sending unconverted PCM at the wrong clock.
 *
 * Only exact integer downsample ratios are supported (anti-alias FIR
 * lowpass + decimate-by-M, or a passthrough when the rates already match).
 * [resolveRealtimeCaptureResampler] returns null for any other ratio so the
 * caller fails closed instead of shipping mis-clocked audio.
 */
internal class RealtimeCaptureResampler private constructor(
  private val decimationFactor: Int,
  private val taps: DoubleArray,
) {
  companion object {
    fun create(decimationFactor: Int): RealtimeCaptureResampler {
      if (decimationFactor <= 1) return RealtimeCaptureResampler(1, DoubleArray(0))
      val numTaps = 8 * decimationFactor + 1
      val center = (numTaps - 1) / 2.0
      val cutoff = 1.0 / (2.0 * decimationFactor)
      val raw =
        DoubleArray(numTaps) { n ->
          val x = n - center
          val ideal = if (x == 0.0) 2.0 * cutoff else sin(2.0 * PI * cutoff * x) / (PI * x)
          val window = 0.54 - 0.46 * cos(2.0 * PI * n / (numTaps - 1))
          ideal * window
        }
      val gain = raw.sum()
      return RealtimeCaptureResampler(decimationFactor, DoubleArray(numTaps) { raw[it] / gain })
    }
  }

  private val historyLen = (taps.size - 1).coerceAtLeast(0)
  private val history = DoubleArray(historyLen)
  private var phase = 0
  private var pendingByte: Byte? = null

  /** Consumes one capture-rate PCM16 chunk (first [length] bytes of [input]) and returns wire-rate PCM16 bytes. */
  fun process(
    input: ByteArray,
    length: Int,
  ): ByteArray {
    val samples = consumeBytes(input, length)
    if (decimationFactor == 1) return samplesToBytes(samples)
    if (samples.isEmpty()) return ByteArray(0)
    val combined = DoubleArray(historyLen + samples.size)
    history.copyInto(combined)
    samples.copyInto(combined, historyLen)
    val outputs = ArrayList<Double>(samples.size / decimationFactor + 1)
    for (i in samples.indices) {
      if ((phase + i) % decimationFactor == decimationFactor - 1) {
        val windowEnd = historyLen + i
        var acc = 0.0
        for (k in taps.indices) acc += taps[k] * combined[windowEnd - k]
        outputs.add(acc)
      }
    }
    phase = (phase + samples.size) % decimationFactor
    combined.copyInto(history, destinationOffset = 0, startIndex = samples.size, endIndex = samples.size + historyLen)
    return samplesToBytes(outputs.toDoubleArray())
  }

  /** Merges a carried-over odd trailing byte with [input] and decodes little-endian PCM16 samples. */
  private fun consumeBytes(
    input: ByteArray,
    length: Int,
  ): DoubleArray {
    val usableLength = length.coerceIn(0, input.size)
    val prefix = pendingByte
    pendingByte = null
    val merged =
      if (prefix == null) {
        input
      } else {
        ByteArray(usableLength + 1).also { buf ->
          buf[0] = prefix
          System.arraycopy(input, 0, buf, 1, usableLength)
        }
      }
    val mergedLength = usableLength + if (prefix == null) 0 else 1
    val sampleCount = mergedLength / 2
    val samples = DoubleArray(sampleCount)
    for (i in 0 until sampleCount) {
      val base = i * 2
      val lo = merged[base].toInt() and 0xff
      val hi = merged[base + 1].toInt()
      samples[i] = ((lo) or (hi shl 8)).toShort().toInt().toDouble()
    }
    if (mergedLength % 2 == 1) pendingByte = merged[mergedLength - 1]
    return samples
  }

  private fun samplesToBytes(samples: DoubleArray): ByteArray {
    val out = ByteArray(samples.size * 2)
    for (i in samples.indices) {
      val clamped = samples[i].roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
      out[i * 2] = (clamped and 0xff).toByte()
      out[i * 2 + 1] = ((clamped shr 8) and 0xff).toByte()
    }
    return out
  }
}

/**
 * Resolves the capture-to-wire converter for [captureRateHz] -> [wireRateHz], or null when the
 * ratio isn't an exact integer downsample (caller must fail closed rather than guess a conversion).
 */
internal fun resolveRealtimeCaptureResampler(
  captureRateHz: Int,
  wireRateHz: Int,
): RealtimeCaptureResampler? {
  if (captureRateHz <= 0 || wireRateHz <= 0 || captureRateHz < wireRateHz) return null
  if (captureRateHz % wireRateHz != 0) return null
  return RealtimeCaptureResampler.create(captureRateHz / wireRateHz)
}
