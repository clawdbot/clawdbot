package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.CHAT_IMAGE_MAX_BASE64_CHARS
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.font.FontStyle
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.Paragraph
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatMarkdownTest {
  @Test
  fun displayMathSegmentsOwnLineAndSameLineDollarBlocks() {
    val sameLine = segmentChatMarkdown("before\n$$ x^2 + y^2 $$\nafter", isStreaming = false)
    val ownLine = segmentChatMarkdown("$$\nx + y\n$$", isStreaming = false)

    assertEquals(
      listOf(
        ChatMarkdownSourceBlock.Markdown("before"),
        ChatMarkdownSourceBlock.Math("x^2 + y^2"),
        ChatMarkdownSourceBlock.Markdown("after"),
      ),
      sameLine,
    )
    assertEquals(listOf(ChatMarkdownSourceBlock.Math("x + y")), ownLine)
  }

  @Test
  fun displayMathSegmentsBracketBlocks() {
    assertEquals(
      listOf(ChatMarkdownSourceBlock.Math("\\frac{a}{b}")),
      segmentChatMarkdown("\\[\\frac{a}{b}\\]", isStreaming = false),
    )
  }

  @Test
  fun displayMathIgnoresFencedAndInlineCode() {
    val fenced = "```tex\n$$\nx + y\n$$\n```"
    val inline = "`$$ x + y $$`"

    assertEquals(listOf(ChatMarkdownSourceBlock.Markdown(fenced)), segmentChatMarkdown(fenced, isStreaming = false))
    assertEquals(listOf(ChatMarkdownSourceBlock.Markdown(inline)), segmentChatMarkdown(inline, isStreaming = false))
  }

  @Test
  fun fencedDelimiterCannotCloseStreamingDisplayMath() {
    val source = "$$\nx\n```text\n$$\n```"

    assertEquals(
      listOf(ChatMarkdownSourceBlock.Markdown(source)),
      segmentChatMarkdown(source, isStreaming = true),
    )
  }

  @Test
  fun displayMathDoesNotSplitSpanningInlineMarkup() {
    val emphasized = "*before\n$$ x + y $$\nafter*"

    assertEquals(
      listOf(ChatMarkdownSourceBlock.Markdown(emphasized)),
      segmentChatMarkdown(emphasized, isStreaming = false),
    )
  }

  @Test
  fun displayMathDoesNotExposeHardBreakEscape() {
    val hardBreak = "before\\\n$$ x + y $$\nafter"

    assertEquals(
      listOf(ChatMarkdownSourceBlock.Markdown(hardBreak)),
      segmentChatMarkdown(hardBreak, isStreaming = false),
    )
  }

  @Test
  fun unclosedStreamingDisplayMathStaysMarkdown() {
    val source = "before\n$$\nx + y"

    assertEquals(
      listOf(ChatMarkdownSourceBlock.Markdown(source)),
      segmentChatMarkdown(source, isStreaming = true),
    )
  }

  @Test
  fun oversizedDisplayMathUsesCodeFallback() {
    val latex = "é".repeat(CHAT_MATH_MAX_BYTES / 2 + 1)

    assertEquals(
      listOf(ChatMarkdownSourceBlock.MathFallback(latex)),
      segmentChatMarkdown("$$\n$latex\n$$", isStreaming = false),
    )
  }

  @Test
  fun bareUrlsCarryClickableUrlAnnotations() {
    val url = "https://www.amazon.it/GAZEBO-CANOPY-ACCIAIO-BIANCO-IMPERMEABILE/dp/B01G5R9FCK"

    val annotated = buildChatInlineMarkdown("Open $url")

    assertEquals("Open $url", annotated.text)
    val links = annotated.getLinkAnnotations(0, annotated.length)
    assertEquals(1, links.size)
    assertEquals(5, links.single().start)
    assertEquals(5 + url.length, links.single().end)
    assertEquals(url, (links.single().item as LinkAnnotation.Url).url)
  }

  @Test
  fun markdownLinksUseLabelTextAndDestinationUrl() {
    val annotated = buildChatInlineMarkdown("Open [docs](https://docs.openclaw.ai/help/testing) now")

    assertEquals("Open docs now", annotated.text)
    val links = annotated.getLinkAnnotations(0, annotated.length)
    assertEquals(1, links.size)
    assertEquals(5, links.single().start)
    assertEquals(9, links.single().end)
    assertEquals("https://docs.openclaw.ai/help/testing", (links.single().item as LinkAnnotation.Url).url)
  }

  @Test
  fun markdownLinksDropUnsafeDestinations() {
    listOf(
      "intent://example/#Intent;scheme=openclaw;end",
      "file:///sdcard/Download/x",
      "content://downloads/public_downloads/1",
      "tel:+15551234567",
      "javascript:alert(1)",
    ).forEach { destination ->
      val annotated = buildChatInlineMarkdown("Open [settings]($destination)")

      assertEquals("Open settings", annotated.text)
      assertTrue(annotated.getLinkAnnotations(0, annotated.length).isEmpty())
    }
  }

  @Test
  fun plainTextDoesNotAddLinkAnnotations() {
    val annotated = buildChatInlineMarkdown("No link here")

    assertEquals("No link here", annotated.text)
    assertTrue(annotated.getLinkAnnotations(0, annotated.length).isEmpty())
  }

  @Test
  fun leadingListsAndQuotesParseAsBlockMarkdown() {
    assertTrue(parseChatMarkdown("- first\n- second").firstChild is BulletList)
    assertTrue(parseChatMarkdown("> quoted").firstChild is BlockQuote)
  }

  @Test
  fun underscoreEmphasisRendersAsItalicText() {
    val document = parseChatMarkdown("_important_")
    val paragraph = document.firstChild as Paragraph

    assertTrue(paragraph.firstChild is Emphasis)
    val annotated = buildChatInlineMarkdown("_important_")
    assertEquals("important", annotated.text)
    val emphasis =
      annotated.spanStyles
        .single()
        .item
    assertEquals(
      FontStyle.Italic,
      emphasis.fontStyle,
    )
  }

  @Test
  fun parseDataImageDestinationAcceptsBoundedPayloads() {
    val parsed = parseDataImageDestination("data:image/png;base64,QUJD")

    assertEquals(ParsedDataImage(mimeType = "image/png", base64 = "QUJD"), parsed)
  }

  @Test
  fun parseDataImageDestinationRejectsOversizedPayloads() {
    val oversized = "A".repeat(CHAT_IMAGE_MAX_BASE64_CHARS + 1)

    val parsed = parseDataImageDestination("data:image/png;base64,$oversized")

    assertNull(parsed)
  }

  @Test
  fun kotlinCodeTokenizesKeywordStringCommentAndNumber() {
    val code = "// greet\nfun main() {\n  val count = 42\n  println(\"hi\")\n}\n"

    val tokens = codeHighlightTokens(code, "kotlin")

    fun assertToken(
      snippet: String,
      kind: CodeTokenKind,
    ) {
      val start = code.indexOf(snippet)
      assertTrue(
        "expected $kind token for $snippet",
        tokens.any { it.start == start && it.end == start + snippet.length && it.kind == kind },
      )
    }
    assertToken("// greet", CodeTokenKind.COMMENT)
    assertToken("fun", CodeTokenKind.KEYWORD)
    assertToken("val", CodeTokenKind.KEYWORD)
    assertToken("42", CodeTokenKind.NUMBER)
    assertToken("\"hi\"", CodeTokenKind.STRING)
  }

  @Test
  fun highlightedCodeAppliesThemeTokenColors() {
    val colors = CodeTokenColors(keyword = Color.Red, string = Color.Green, comment = Color.Gray, number = Color.Blue)

    val annotated = buildHighlightedCode("val x = 1", "kotlin", colors)

    assertEquals("val x = 1", annotated.text)
    val keyword = annotated.spanStyles.single { it.start == 0 && it.end == 3 }
    assertEquals(Color.Red, keyword.item.color)
    val number = annotated.spanStyles.single { it.start == 8 && it.end == 9 }
    assertEquals(Color.Blue, number.item.color)
  }

  @Test
  fun unknownOrMissingLanguageRendersPlain() {
    val code = "fun main() {}"
    val colors = CodeTokenColors(keyword = Color.Red, string = Color.Green, comment = Color.Gray, number = Color.Blue)

    assertTrue(codeHighlightTokens(code, "brainfuck").isEmpty())
    assertTrue(codeHighlightTokens(code, null).isEmpty())
    assertTrue(buildHighlightedCode(code, "brainfuck", colors).spanStyles.isEmpty())
  }

  @Test
  fun openFencedBlockParsesWithoutClosingFence() {
    val open = parseChatMarkdown("```kotlin\nval x = 1\n").firstChild as FencedCodeBlock
    val closed = parseChatMarkdown("```kotlin\nval x = 1\n```\n").firstChild as FencedCodeBlock

    // While streaming, the renderer keeps fences without a closing marker plain; finalized
    // messages highlight regardless because CommonMark allows fences to end at EOF.
    assertNull(open.closingFenceLength)
    assertNotNull(closed.closingFenceLength)
  }

  @Test
  fun blocksOverTheLineOrCharBoundSkipHighlighting() {
    val overLineBound = buildString { repeat(CODE_HIGHLIGHT_MAX_LINES + 1) { append("val v$it = $it\n") } }
    // Fenced literals keep a trailing newline; a block of exactly MAX lines must still highlight.
    val atLineBound = buildString { repeat(CODE_HIGHLIGHT_MAX_LINES) { append("val v$it = $it\n") } }
    // A minified one-line payload must hit the char bound even though it has no newlines.
    val overCharBound = "{\"k\": \"" + "a".repeat(CODE_HIGHLIGHT_MAX_CHARS) + "\"}"

    assertTrue(codeHighlightTokens(overLineBound, "kotlin").isEmpty())
    assertTrue(codeHighlightTokens(atLineBound, "kotlin").isNotEmpty())
    assertTrue(codeHighlightTokens(overCharBound, "json").isEmpty())
  }

  @Test
  fun jsonAndBashTokenizeStringsCommentsAndLiterals() {
    val json = "{\"enabled\": true, \"count\": 3}"
    val jsonTokens = codeHighlightTokens(json, "json")
    assertTrue(jsonTokens.any { it.kind == CodeTokenKind.STRING })
    assertTrue(jsonTokens.any { it.kind == CodeTokenKind.KEYWORD && json.substring(it.start, it.end) == "true" })
    assertTrue(jsonTokens.any { it.kind == CodeTokenKind.NUMBER && json.substring(it.start, it.end) == "3" })

    val bash = "# list\nfor f in *.txt; do echo \"\$f\"; done\n"
    val bashTokens = codeHighlightTokens(bash, "bash")
    assertTrue(bashTokens.any { it.kind == CodeTokenKind.COMMENT && it.start == 0 })
    assertTrue(bashTokens.any { it.kind == CodeTokenKind.KEYWORD && bash.substring(it.start, it.end) == "done" })
  }

  @Test
  fun escapedSingleQuotesAndBashHashesTokenizeCorrectly() {
    // TS single-quoted strings keep backslash escapes: the literal is one token and code after it is not a string.
    val ts = "const m = 'don\\'t'; call()"
    val literal = "'don\\'t'"
    val tsTokens = codeHighlightTokens(ts, "typescript")
    val start = ts.indexOf(literal)
    assertTrue(tsTokens.any { it.kind == CodeTokenKind.STRING && it.start == start && it.end == start + literal.length })
    assertTrue(tsTokens.none { it.kind == CodeTokenKind.STRING && it.start > start })

    // Template literals span newlines; code after the closing backtick is not a string.
    val template = "const t = `a\nb`; call()"
    val templateTokens = codeHighlightTokens(template, "typescript")
    val backtick = template.indexOf('`')
    assertTrue(
      templateTokens.any { it.kind == CodeTokenKind.STRING && it.start == backtick && it.end == template.indexOf("`;") + 1 },
    )
    assertTrue(templateTokens.none { it.kind == CodeTokenKind.STRING && it.start > backtick })

    // Bash '#' inside parameter expansion is not a comment; whitespace- or operator-adjacent '#' is.
    val bash = "echo \${#items[@]} # count\n"
    val bashTokens = codeHighlightTokens(bash, "bash")
    val comments = bashTokens.filter { it.kind == CodeTokenKind.COMMENT }
    assertEquals(1, comments.size)
    assertEquals(bash.indexOf("# count"), comments.single().start)

    val compact = "echo ok;# if true\n"
    val compactComments = codeHighlightTokens(compact, "bash").filter { it.kind == CodeTokenKind.COMMENT }
    assertEquals(listOf(compact.indexOf("#")), compactComments.map { it.start })
  }

  @Test
  fun nestedBlockCommentsAndMultilineShellStringsStayOneToken() {
    // Kotlin block comments nest: the outer comment ends at the outer close, not the inner one.
    val kotlin = "/* outer /* inner */ tail */\nval x = 1"
    val kotlinTokens = codeHighlightTokens(kotlin, "kotlin")
    val comment = kotlinTokens.single { it.kind == CodeTokenKind.COMMENT }
    assertEquals(0, comment.start)
    assertEquals(kotlin.lastIndexOf("*/") + 2, comment.end)
    assertTrue(kotlinTokens.any { it.kind == CodeTokenKind.KEYWORD && kotlin.substring(it.start, it.end) == "val" })

    // Shell strings span newlines: one token, and code after the closing quote is not a string.
    val bash = "msg='a\nb'\nif true; then echo hi; fi\n"
    val bashTokens = codeHighlightTokens(bash, "bash")
    val string = bashTokens.single { it.kind == CodeTokenKind.STRING }
    assertEquals(bash.indexOf('\''), string.start)
    assertEquals(bash.indexOf("'\n", string.start + 1) + 1, string.end)
    assertTrue(bashTokens.any { it.kind == CodeTokenKind.KEYWORD && bash.substring(it.start, it.end) == "if" })
  }

  @Test
  fun escapedTripleQuotesDoNotEndPythonOrSwiftStrings() {
    val samples =
      listOf(
        "python" to "message = \"\"\"before \\\"\"\" after\"\"\"\nreturn 1\n",
        "swift" to "let message = \"\"\"\nbefore \\\"\"\" after\n\"\"\"\nreturn 1\n",
      )

    samples.forEach { (language, code) ->
      val tokens = codeHighlightTokens(code, language)
      val string = tokens.single { it.kind == CodeTokenKind.STRING }

      assertEquals(code.indexOf("\"\"\""), string.start)
      assertEquals(code.lastIndexOf("\"\"\"") + 3, string.end)
      assertTrue(tokens.any { it.kind == CodeTokenKind.KEYWORD && code.substring(it.start, it.end) == "return" })
    }
  }
}
