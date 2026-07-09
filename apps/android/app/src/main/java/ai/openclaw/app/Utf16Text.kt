package ai.openclaw.app

internal fun String.takeUtf16Safe(maxChars: Int): String {
  if (length <= maxChars) return this
  // Keep the code-unit cap without leaving a high surrogate at its boundary.
  val endsOnHighSurrogate = maxChars > 0 && Character.isHighSurrogate(this[maxChars - 1])
  return take(if (endsOnHighSurrogate) maxChars - 1 else maxChars)
}
