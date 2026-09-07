package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.CHAT_IMAGE_MAX_BASE64_CHARS
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HtmlBlock
import org.commonmark.node.Paragraph
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatMarkdownTest {
  @Test
  fun detailsFoldCollapsedAndExpandedBlocks() {
    val collapsed =
      parseChatMarkdownBlocks(
        """
        <details>
        <summary>**Why**</summary>

        Body

        </details>
        """.trimIndent(),
      ).single() as ChatMarkdownRenderBlock.Disclosure
    val expanded =
      parseChatMarkdownBlocks(
        """
        <details open>
        <summary>More</summary>

        Body

        </details>
        """.trimIndent(),
      ).single() as ChatMarkdownRenderBlock.Disclosure

    assertEquals("**Why**", collapsed.summary)
    assertEquals(false, collapsed.isExpanded)
    assertTrue((collapsed.blocks.single() as ChatMarkdownRenderBlock.CommonMark).node is Paragraph)
    val renderedSummary = buildChatInlineMarkdown(checkNotNull(collapsed.summary))
    assertEquals("Why", renderedSummary.text)
    assertTrue(renderedSummary.spanStyles.any { it.item.fontWeight == FontWeight.SemiBold })
    assertEquals("More", expanded.summary)
    assertEquals(true, expanded.isExpanded)
  }

  @Test
  fun authoredDetailsSummaryDoesNotUseLocalizedFallback() {
    val disclosure =
      parseChatMarkdownBlocks("<details>\n<summary>Details</summary>\n\nBody\n\n</details>")
        .single() as ChatMarkdownRenderBlock.Disclosure
    var fallbackEvaluated = false
    val rendered =
      chatMarkdownDisclosureSummarySource(disclosure.summary) {
        fallbackEvaluated = true
        "Localized details"
      }

    assertEquals("Details", disclosure.summary)
    assertEquals("Details", rendered)
    assertEquals(false, fallbackEvaluated)
  }

  @Test
  fun detailsWithoutSummaryUseLocalizedDefaultLabel() {
    val disclosure =
      parseChatMarkdownBlocks("<details>\n\nBody\n\n</details>").single() as ChatMarkdownRenderBlock.Disclosure

    assertNull(disclosure.summary)
    assertEquals(
      "Localized details",
      chatMarkdownDisclosureSummarySource(disclosure.summary) { "Localized details" },
    )
  }

  @Test
  fun emptyDetailsSummaryAfterProseUsesLocalizedDefault() {
    val blocks =
      parseChatMarkdownBlocks(
        "Intro\n\n<details>\n<summary></summary>\n\nBody\n\n</details>",
      )
    val intro = (blocks[0] as ChatMarkdownRenderBlock.CommonMark).node as Paragraph
    val disclosure = blocks[1] as ChatMarkdownRenderBlock.Disclosure

    assertEquals("Intro", (intro.firstChild as org.commonmark.node.Text).literal)
    assertNull(disclosure.summary)
    assertEquals(
      "Localized details",
      chatMarkdownDisclosureSummarySource(disclosure.summary) { "Localized details" },
    )
  }

  @Test
  fun detailsBodyKeepsNativeListAndFenceBlocks() {
    val disclosure =
      parseChatMarkdownBlocks(
        """
        <details open>
        <summary>Why</summary>

        - first
        - second

        ```kotlin
        val value = 1
        ```

        </details>
        """.trimIndent(),
      ).single() as ChatMarkdownRenderBlock.Disclosure

    assertTrue((disclosure.blocks[0] as ChatMarkdownRenderBlock.CommonMark).node is BulletList)
    assertTrue((disclosure.blocks[1] as ChatMarkdownRenderBlock.CommonMark).node is FencedCodeBlock)
  }

  @Test
  fun type6HtmlBlockCannotAbsorbTheDetailsCloser() {
    val blocks =
      parseChatMarkdownBlocks(
        """
        <details>
        <summary>X</summary>

        <div>body</div>
        </details>

        Following
        """.trimIndent(),
      )
    val disclosure = blocks[0] as ChatMarkdownRenderBlock.Disclosure
    val html = (disclosure.blocks.single() as ChatMarkdownRenderBlock.CommonMark).node as HtmlBlock
    val following = (blocks[1] as ChatMarkdownRenderBlock.CommonMark).node as Paragraph

    assertTrue(html.literal.contains("body"))
    assertEquals("Following", (following.firstChild as org.commonmark.node.Text).literal)
  }

  @Test
  fun unsupportedNestedDetailsBalanceWithoutClosingOuterDisclosure() {
    val blocks =
      parseChatMarkdownBlocks(
        """
        <details>
        <summary>Outer</summary>

        <details class="legacy">

        unsupported body

        </details>

        still outer

        </details>
        """.trimIndent(),
      )
    val outer = blocks.single() as ChatMarkdownRenderBlock.Disclosure
    val literals = outer.blocks.filterIsInstance<ChatMarkdownRenderBlock.LiteralHtml>().map { it.source }

    assertTrue(literals.contains("<details class=\"legacy\">"))
    assertTrue(literals.contains("</details>"))
    val paragraphText =
      outer.blocks
        .filterIsInstance<ChatMarkdownRenderBlock.CommonMark>()
        .mapNotNull { it.node as? Paragraph }
        .mapNotNull { it.firstChild as? org.commonmark.node.Text }
        .mapNotNull { it.literal }
    assertTrue(paragraphText.contains("still outer"))
  }

  @Test
  fun detailsTagsInFencedAndInlineCodeStayLiteral() {
    val fenced = parseChatMarkdownBlocks("```html\n<details>\n</details>\n```").single()
    val inline = parseChatMarkdownBlocks("`<details>`").single()

    assertTrue((fenced as ChatMarkdownRenderBlock.CommonMark).node is FencedCodeBlock)
    assertTrue((inline as ChatMarkdownRenderBlock.CommonMark).node is Paragraph)
  }

  @Test
  fun detailsInRawHtmlContextsStayLiteral() {
    val commented = "<!--\n<details>\n<summary>Example</summary>\n</details>\n-->"
    val preformatted = "<pre>\n<details>\n<summary>Example</summary>\n</details>\n</pre>"

    assertTrue((parseChatMarkdownBlocks(commented).single() as ChatMarkdownRenderBlock.CommonMark).node is HtmlBlock)
    assertTrue((parseChatMarkdownBlocks(preformatted).single() as ChatMarkdownRenderBlock.CommonMark).node is HtmlBlock)
  }

  @Test
  fun detailsAfterHtmlCommentStillFold() {
    val comment = "<!--\n<details>\n</details>\n-->"
    val blocks =
      parseChatMarkdownBlocks(
        "$comment\n<details>\n<summary>After</summary>\n\nBody\n\n</details>",
      )

    assertEquals(2, blocks.size)
    assertTrue((blocks[0] as ChatMarkdownRenderBlock.CommonMark).node is HtmlBlock)
    assertEquals("After", (blocks[1] as ChatMarkdownRenderBlock.Disclosure).summary)
  }

  @Test
  fun rawHtmlCloseMarkersInsideDetailsStayLiteral() {
    listOf(
      "<details>\n<summary>X</summary>\n<pre>\n</details>\n</pre>\n</details>" to "</details>",
      "<details>\n<summary>X</summary>\n<!--\n</details>\n-->\n</details>" to "</details>",
      "<details>\n<summary>X</summary>\n<?pi\n<details>\n?>\n</details>" to "<details>",
      "<details>\n<summary>X</summary>\n<![CDATA[\n<details>\n]]>\n</details>" to "<details>",
      "<details>\n<summary>X</summary>\n<!DOCTYPE\n<details>\n</details>" to "<details>",
    ).forEach { (source, literalClose) ->
      val blocks = parseChatMarkdownBlocks(source)
      val disclosure = blocks.single() as ChatMarkdownRenderBlock.Disclosure
      val rawBlock = (disclosure.blocks.single() as ChatMarkdownRenderBlock.CommonMark).node as HtmlBlock

      assertTrue(rawBlock.literal.contains(literalClose))
    }
  }

  @Test
  fun midLineAndOverIndentedDetailsStayLiteral() {
    val midLine = parseChatMarkdownBlocks("before <details> after").single()
    val indented = parseChatMarkdownBlocks("    <details>\n    body\n    </details>").single()

    assertTrue((midLine as ChatMarkdownRenderBlock.CommonMark).node is Paragraph)
    val indentedNode = (indented as ChatMarkdownRenderBlock.CommonMark).node
    assertTrue(indentedNode is org.commonmark.node.IndentedCodeBlock)
  }

  @Test
  fun unclosedStreamingDetailsFoldAvailableBody() {
    val disclosure =
      parseChatMarkdownBlocks("<details open>\n<summary>Progress</summary>\n\n- first")
        .single() as ChatMarkdownRenderBlock.Disclosure

    assertEquals("Progress", disclosure.summary)
    assertEquals(true, disclosure.isExpanded)
    assertTrue((disclosure.blocks.single() as ChatMarkdownRenderBlock.CommonMark).node is BulletList)
  }

  @Test
  fun detailsNestingStopsAtDepthCap() {
    val depth = CHAT_MARKDOWN_DISCLOSURE_MAX_DEPTH + 1
    val markdown =
      List(depth) { "<details>" }.joinToString("\n") +
        "\nbody\n" +
        List(depth) { "</details>" }.joinToString("\n")
    var blocks = parseChatMarkdownBlocks(markdown)
    var structuralDepth = 0
    while (blocks.singleOrNull() is ChatMarkdownRenderBlock.Disclosure) {
      structuralDepth += 1
      blocks = (blocks.single() as ChatMarkdownRenderBlock.Disclosure).blocks
    }

    assertEquals(CHAT_MARKDOWN_DISCLOSURE_MAX_DEPTH, structuralDepth)
    assertTrue(blocks.filterIsInstance<ChatMarkdownRenderBlock.LiteralHtml>().any { it.source == "<details>" })
    assertTrue(blocks.filterIsInstance<ChatMarkdownRenderBlock.LiteralHtml>().any { it.source == "</details>" })
  }

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
  fun mermaidOnlyClaimsExplicitCompletedFences() {
    for ((language, diagram) in listOf("mermaid" to true, "MeRmAiD title" to true, "mermaid\ttitle" to true, "bash" to false, "mermaidjs" to false, "" to false)) {
      val open = parseChatMarkdown("```$language\nflowchart LR\nA --> B\n").firstChild as FencedCodeBlock
      val closed = parseChatMarkdown("```$language\nflowchart LR\nA --> B\n```\n").firstChild as FencedCodeBlock
      assertEquals(false, isChatMermaidFence(open, isStreaming = true))
      assertEquals(diagram, isChatMermaidFence(open, isStreaming = false))
      assertEquals(diagram, isChatMermaidFence(closed, isStreaming = true))
    }
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
