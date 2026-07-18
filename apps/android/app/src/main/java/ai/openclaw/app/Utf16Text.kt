package ai.openclaw.app

import android.icu.text.BreakIterator
import java.util.Locale

// BreakIterator creation is relatively expensive, and instances are not thread-safe.
private val graphemeBreakIterator = ThreadLocal.withInitial { BreakIterator.getCharacterInstance(Locale.ROOT) }

internal fun String.firstGraphemeOrNull(): String? {
  if (isEmpty()) return null
  val iterator = checkNotNull(graphemeBreakIterator.get())
  iterator.setText(this)
  iterator.first()
  val end = iterator.next()
  return if (end == BreakIterator.DONE) null else substring(0, end)
}

internal fun String.takeUtf16Safe(maxChars: Int): String {
  if (length <= maxChars) return this
  // Keep the code-unit cap without leaving a high surrogate at its boundary.
  val endsOnHighSurrogate = maxChars > 0 && Character.isHighSurrogate(this[maxChars - 1])
  return take(if (endsOnHighSurrogate) maxChars - 1 else maxChars)
}
