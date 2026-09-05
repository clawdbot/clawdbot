package ai.openclaw.app.ui.chat

import android.icu.text.BreakIterator
import java.util.Locale

// Bounding the viewport alone does not bound native text measurement allocations.
private const val CHAT_TEXT_LAYOUT_MAX_CHARS = 16_384

internal fun chatTextLayoutRanges(
  text: String,
  maxLines: Int = Int.MAX_VALUE,
): List<IntRange> {
  val boundaries = BreakIterator.getCharacterInstance(Locale.ROOT).apply { setText(text) }
  return buildList {
    var start = 0
    do {
      var end = start + minOf(CHAT_TEXT_LAYOUT_MAX_CHARS, text.length - start)
      if (maxLines != Int.MAX_VALUE) {
        var cursor = start
        var lines = 0
        while (cursor < end && lines < maxLines) {
          val newline = text.indexOf('\n', cursor)
          if (newline !in cursor until end) break
          cursor = newline + 1
          lines += 1
        }
        if (lines == maxLines) end = cursor
      }
      if (end < text.length) {
        val boundary = boundaries.preceding(end + 1)
        if (boundary > start) {
          end = boundary
        } else if (text[end - 1].isHighSurrogate() && text[end].isLowSurrogate()) {
          // An over-budget grapheme must still respect the native allocation cap.
          end -= 1
        }
      }
      add(start until end)
      start = end
    } while (start < text.length)
  }
}
