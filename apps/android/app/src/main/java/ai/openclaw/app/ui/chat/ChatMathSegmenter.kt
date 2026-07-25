package ai.openclaw.app.ui.chat

import org.commonmark.node.Code
import org.commonmark.node.Document
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Node
import org.commonmark.node.Paragraph
import org.commonmark.node.Image as MarkdownImage
import org.commonmark.node.Link as MarkdownLink

internal const val CHAT_MATH_MAX_BYTES = 5000

internal sealed interface ChatMarkdownSourceBlock {
  data class Markdown(
    val source: String,
  ) : ChatMarkdownSourceBlock

  data class Math(
    val latex: String,
  ) : ChatMarkdownSourceBlock

  data class MathFallback(
    val latex: String,
  ) : ChatMarkdownSourceBlock
}

/** Extracts top-level display math while CommonMark owns code/container boundaries. */
internal fun segmentChatMarkdown(
  source: String,
  isStreaming: Boolean,
): List<ChatMarkdownSourceBlock> {
  if (!source.contains("$$") && !source.contains("\\[")) {
    return listOf(ChatMarkdownSourceBlock.Markdown(source))
  }

  val document = parseChatMarkdown(source)
  val topLevelParagraphLines = mutableSetOf<Int>()
  val protectedInlineLines = mutableSetOf<Int>()
  var child = document.firstChild
  while (child != null) {
    if (child is Paragraph) {
      child.sourceSpans.forEach { span -> topLevelParagraphLines.add(span.lineIndex) }
      collectProtectedInlineLines(child.firstChild, protectedInlineLines)
    }
    child = child.next
  }

  val lines = source.split('\n')
  val extractions = mutableListOf<MathExtraction>()
  var lineIndex = 0
  while (lineIndex < lines.size) {
    val opener =
      if (lineIndex in topLevelParagraphLines && lineIndex !in protectedInlineLines) {
        MathDelimiter.parse(lines[lineIndex])
      } else {
        null
      }
    if (opener == null) {
      lineIndex += 1
      continue
    }

    if (opener.sameLineLatex != null) {
      extractions.add(MathExtraction(lineIndex..lineIndex, opener.sameLineLatex))
      lineIndex += 1
      continue
    }

    var closeIndex = lineIndex + 1
    while (
      closeIndex < lines.size &&
      (
        closeIndex !in topLevelParagraphLines ||
          closeIndex in protectedInlineLines ||
          !opener.isClose(lines[closeIndex])
      )
    ) {
      closeIndex += 1
    }
    val closed = closeIndex < lines.size
    if (!closed && isStreaming) {
      // One unmatched opener owns the remaining stream; later delimiter-looking lines stay text.
      break
    }

    val contentEnd = if (closed) closeIndex else lines.size
    val latex = lines.subList(lineIndex + 1, contentEnd).joinToString("\n").trim()
    val extractionEnd = if (closed) closeIndex else lines.lastIndex
    extractions.add(MathExtraction(lineIndex..extractionEnd, latex))
    lineIndex = extractionEnd + 1
  }

  if (extractions.isEmpty()) {
    return listOf(ChatMarkdownSourceBlock.Markdown(source))
  }
  if (containsReferenceStyleLink(document, source)) {
    // Splitting would separate a reference link from its definition and change CommonMark semantics.
    return listOf(ChatMarkdownSourceBlock.Markdown(source))
  }

  val blocks = mutableListOf<ChatMarkdownSourceBlock>()
  var proseStart = 0
  for (extraction in extractions) {
    appendMarkdownBlock(lines, proseStart, extraction.lines.first, blocks)
    blocks.add(
      if (extraction.latex.toByteArray(Charsets.UTF_8).size <= CHAT_MATH_MAX_BYTES) {
        ChatMarkdownSourceBlock.Math(extraction.latex)
      } else {
        ChatMarkdownSourceBlock.MathFallback(extraction.latex)
      },
    )
    proseStart = extraction.lines.last + 1
  }
  appendMarkdownBlock(lines, proseStart, lines.size, blocks)
  return blocks
}

private fun containsReferenceStyleLink(
  document: Document,
  source: String,
): Boolean {
  fun search(start: Node?): Boolean {
    var node = start
    while (node != null) {
      if (node is MarkdownLink || node is MarkdownImage) {
        val spans = node.sourceSpans
        val startIndex = spans.minOfOrNull { span -> span.inputIndex }
        val endIndex = spans.maxOfOrNull { span -> span.inputIndex + span.length }
        if (startIndex != null && endIndex != null && startIndex >= 0 && endIndex <= source.length) {
          if (source.substring(startIndex, endIndex).trimEnd().endsWith(']')) return true
        }
      }
      if (search(node.firstChild)) return true
      node = node.next
    }
    return false
  }
  return search(document.firstChild)
}

private fun collectProtectedInlineLines(
  start: Node?,
  lines: MutableSet<Int>,
) {
  var node = start
  while (node != null) {
    if (node is Code) {
      node.sourceSpans.forEach { span -> lines.add(span.lineIndex) }
    }
    if (node is HardLineBreak) {
      node.sourceSpans.forEach { span -> lines.add(span.lineIndex + 1) }
    }
    val spannedLines = node.sourceSpans.map { span -> span.lineIndex }.distinct()
    if (spannedLines.size > 1) {
      lines.addAll(checkNotNull(spannedLines.minOrNull())..checkNotNull(spannedLines.maxOrNull()))
    }
    collectProtectedInlineLines(node.firstChild, lines)
    node = node.next
  }
}

private fun appendMarkdownBlock(
  lines: List<String>,
  start: Int,
  end: Int,
  blocks: MutableList<ChatMarkdownSourceBlock>,
) {
  var contentStart = start
  var contentEnd = end
  while (contentStart < contentEnd && lines[contentStart].isBlank()) contentStart += 1
  while (contentEnd > contentStart && lines[contentEnd - 1].isBlank()) contentEnd -= 1
  if (contentStart < contentEnd) {
    blocks.add(ChatMarkdownSourceBlock.Markdown(lines.subList(contentStart, contentEnd).joinToString("\n")))
  }
}

private data class MathExtraction(
  val lines: IntRange,
  val latex: String,
)

private data class MathDelimiter(
  val close: String,
  val sameLineLatex: String?,
) {
  fun isClose(line: String): Boolean = line.trim() == close

  companion object {
    fun parse(line: String): MathDelimiter? {
      val indent = line.indexOfFirst { char -> char != ' ' }.let { index -> if (index == -1) line.length else index }
      if (indent > 3 || indent == line.length) return null
      val suffix = line.substring(indent)
      val (open, close) =
        when {
          suffix.startsWith("$$") -> "$$" to "$$"
          suffix.startsWith("\\[") -> "\\[" to "\\]"
          else -> return null
        }
      val remainder = suffix.removePrefix(open)
      if (remainder.isBlank()) return MathDelimiter(close = close, sameLineLatex = null)
      val closeIndex = remainder.lastIndexOf(close)
      if (closeIndex < 0 || remainder.substring(closeIndex + close.length).isNotBlank()) return null
      return MathDelimiter(close = close, sameLineLatex = remainder.substring(0, closeIndex).trim())
    }
  }
}
