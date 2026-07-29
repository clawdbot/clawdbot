package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.CHAT_IMAGE_MAX_BASE64_CHARS
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.mobileAccent
import ai.openclaw.app.ui.mobileCallout
import ai.openclaw.app.ui.mobileCaption1
import ai.openclaw.app.ui.mobileCodeBg
import ai.openclaw.app.ui.mobileCodeText
import ai.openclaw.app.ui.mobileTextSecondary
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.commonmark.Extension
import org.commonmark.ext.autolink.AutolinkExtension
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableBody
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TableHead
import org.commonmark.ext.gfm.tables.TableRow
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.ext.task.list.items.TaskListItemMarker
import org.commonmark.ext.task.list.items.TaskListItemsExtension
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Document
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.IncludeSourceSpans
import org.commonmark.parser.Parser
import java.net.URI
import java.util.Locale
import org.commonmark.node.Image as MarkdownImage
import org.commonmark.node.Text as MarkdownTextNode

private const val LIST_INDENT_DP = 14
private const val DATA_IMAGE_HEADER_MAX_CHARS = 64
internal const val CHAT_MARKDOWN_DISCLOSURE_MAX_DEPTH = 32
private val dataImageRegex = Regex("^data:image/([a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=\\n\\r]+)$")

private val markdownParser: Parser by lazy {
  val extensions: List<Extension> =
    listOf(
      AutolinkExtension.create(),
      StrikethroughExtension.create(),
      TablesExtension.create(),
      TaskListItemsExtension.create(),
    )
  Parser
    .builder()
    .extensions(extensions)
    .includeSourceSpans(IncludeSourceSpans.BLOCKS_AND_INLINES)
    .build()
}

/** Renders gateway/chat Markdown using the restricted mobile-safe feature set. */
@Composable
fun ChatMarkdown(
  text: String,
  textColor: Color,
  isStreaming: Boolean = false,
) {
  val blocks = remember(text, isStreaming) { segmentChatMarkdown(text, isStreaming) }
  val inlineStyles =
    InlineStyles(inlineCodeBg = mobileCodeBg, inlineCodeColor = mobileCodeText, linkColor = mobileAccent, baseCallout = mobileCallout)

  Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
    for (block in blocks) {
      when (block) {
        is ChatMarkdownSourceBlock.Markdown -> {
          val documentBlocks = remember(block.source) { parseChatMarkdownBlocks(block.source) }
          RenderMarkdownBlocks(
            blocks = documentBlocks,
            textColor = textColor,
            inlineStyles = inlineStyles,
            listDepth = 0,
            isStreaming = isStreaming,
          )
        }
        is ChatMarkdownSourceBlock.Math -> ChatMathBlock(latex = block.latex, textColor = textColor)
        is ChatMarkdownSourceBlock.MathFallback -> ChatMathFallback(latex = block.latex)
      }
    }
  }
}

@Composable
private fun RenderMarkdownBlocks(
  blocks: List<ChatMarkdownRenderBlock>,
  textColor: Color,
  inlineStyles: InlineStyles,
  listDepth: Int,
  isStreaming: Boolean,
) {
  for (block in blocks) {
    when (block) {
      is ChatMarkdownRenderBlock.CommonMark ->
        RenderCommonMarkBlock(
          current = block.node,
          textColor = textColor,
          inlineStyles = inlineStyles,
          listDepth = listDepth,
          isStreaming = isStreaming,
        )
      is ChatMarkdownRenderBlock.LiteralHtml -> RenderLiteralHtml(block.source, textColor)
      is ChatMarkdownRenderBlock.Disclosure ->
        RenderMarkdownDisclosure(
          disclosure = block,
          textColor = textColor,
          inlineStyles = inlineStyles,
          listDepth = listDepth,
          isStreaming = isStreaming,
        )
    }
  }
}

@Composable
private fun RenderCommonMarkBlock(
  current: Node,
  textColor: Color,
  inlineStyles: InlineStyles,
  listDepth: Int,
  isStreaming: Boolean,
) {
  when (current) {
    is Paragraph -> {
      RenderParagraph(current, textColor = textColor, inlineStyles = inlineStyles)
    }
    is Heading -> {
      val headingText = remember(current) { buildInlineMarkdown(current.firstChild, inlineStyles) }
      Text(
        text = headingText,
        style = headingStyle(current.level, inlineStyles.baseCallout),
        color = textColor,
      )
    }
    is FencedCodeBlock -> {
      SelectionContainer(modifier = Modifier.fillMaxWidth()) {
        ChatCodeBlock(
          code = current.literal.orEmpty(),
          language = current.info?.trim()?.ifEmpty { null },
          // Streaming: an unclosed fence grows on every delta, so keep it plain until the
          // closing marker arrives. Finalized messages may validly end at EOF without a
          // closing fence (CommonMark), so completeness comes from stream state, not syntax.
          isComplete = !isStreaming || current.closingFenceLength != null,
        )
      }
    }
    is IndentedCodeBlock -> {
      SelectionContainer(modifier = Modifier.fillMaxWidth()) {
        ChatCodeBlock(code = current.literal.orEmpty(), language = null)
      }
    }
    is BlockQuote -> {
      Row(
        modifier =
          Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top,
      ) {
        Box(
          modifier =
            Modifier
              .width(2.dp)
              .fillMaxHeight()
              .background(mobileTextSecondary.copy(alpha = 0.35f)),
        )
        Column(
          modifier = Modifier.weight(1f),
          verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          RenderMarkdownBlocks(
            blocks = commonMarkBlocks(current.firstChild),
            textColor = textColor,
            inlineStyles = inlineStyles,
            listDepth = listDepth,
            isStreaming = isStreaming,
          )
        }
      }
    }
    is BulletList -> {
      RenderBulletList(
        list = current,
        textColor = textColor,
        inlineStyles = inlineStyles,
        listDepth = listDepth,
        isStreaming = isStreaming,
      )
    }
    is OrderedList -> {
      RenderOrderedList(
        list = current,
        textColor = textColor,
        inlineStyles = inlineStyles,
        listDepth = listDepth,
        isStreaming = isStreaming,
      )
    }
    is TableBlock -> {
      RenderTableBlock(
        table = current,
        textColor = textColor,
        inlineStyles = inlineStyles,
      )
    }
    is ThematicBreak -> {
      Box(
        modifier =
          Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(mobileTextSecondary.copy(alpha = 0.25f)),
      )
    }
    is HtmlBlock -> {
      RenderLiteralHtml(current.literal.orEmpty(), textColor)
    }
  }
}

@Composable
private fun RenderLiteralHtml(
  source: String,
  textColor: Color,
) {
  val literal = source.trim()
  if (literal.isNotEmpty()) {
    Text(
      text = literal,
      style = mobileCallout.copy(fontFamily = FontFamily.Monospace),
      color = textColor,
    )
  }
}

@Composable
private fun RenderMarkdownDisclosure(
  disclosure: ChatMarkdownRenderBlock.Disclosure,
  textColor: Color,
  inlineStyles: InlineStyles,
  listDepth: Int,
  isStreaming: Boolean,
) {
  var isExpanded by rememberSaveable { mutableStateOf(disclosure.isExpanded) }
  val summarySource = chatMarkdownDisclosureSummarySource(disclosure.summary) { nativeString("Details") }
  val summary =
    remember(summarySource, inlineStyles.linkColor) {
      buildChatInlineMarkdown(summarySource, linkColor = inlineStyles.linkColor)
    }

  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Surface(
      onClick = { isExpanded = !isExpanded },
      shape = RoundedCornerShape(8.dp),
      color = ClawTheme.colors.surfaceRaised.copy(alpha = 0.72f),
      contentColor = ClawTheme.colors.textMuted,
      border = BorderStroke(1.dp, ClawTheme.colors.border.copy(alpha = 0.6f)),
    ) {
      Row(
        modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          text = if (isExpanded) "▾" else "▸",
          style = mobileCallout.copy(fontWeight = FontWeight.SemiBold),
        )
        Text(
          text = summary,
          style = mobileCallout.copy(fontWeight = FontWeight.SemiBold),
          color = textColor,
        )
      }
    }

    if (isExpanded) {
      Column(
        modifier = Modifier.padding(start = 8.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
      ) {
        RenderMarkdownBlocks(
          blocks = disclosure.blocks,
          textColor = textColor,
          inlineStyles = inlineStyles,
          listDepth = listDepth,
          isStreaming = isStreaming,
        )
      }
    }
  }
}

@Composable
private fun RenderParagraph(
  paragraph: Paragraph,
  textColor: Color,
  inlineStyles: InlineStyles,
) {
  val standaloneImage = remember(paragraph) { standaloneDataImage(paragraph) }
  if (standaloneImage != null) {
    // Render a paragraph that is only a data image as media, not as an inline alt label.
    InlineBase64Image(base64 = standaloneImage.base64, mimeType = standaloneImage.mimeType)
    return
  }

  val annotated = remember(paragraph) { buildInlineMarkdown(paragraph.firstChild, inlineStyles) }
  if (annotated.text.trimEnd().isEmpty()) {
    return
  }

  Text(
    text = annotated,
    style = inlineStyles.baseCallout,
    color = textColor,
  )
}

@Composable
private fun RenderBulletList(
  list: BulletList,
  textColor: Color,
  inlineStyles: InlineStyles,
  listDepth: Int,
  isStreaming: Boolean,
) {
  Column(
    modifier = Modifier.padding(start = (LIST_INDENT_DP * listDepth).dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    var item = list.firstChild
    while (item != null) {
      if (item is ListItem) {
        RenderListItem(
          item = item,
          markerText = "•",
          textColor = textColor,
          inlineStyles = inlineStyles,
          listDepth = listDepth,
          isStreaming = isStreaming,
        )
      }
      item = item.next
    }
  }
}

@Composable
private fun RenderOrderedList(
  list: OrderedList,
  textColor: Color,
  inlineStyles: InlineStyles,
  listDepth: Int,
  isStreaming: Boolean,
) {
  Column(
    modifier = Modifier.padding(start = (LIST_INDENT_DP * listDepth).dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    var index = list.markerStartNumber ?: 1
    var item = list.firstChild
    while (item != null) {
      if (item is ListItem) {
        RenderListItem(
          item = item,
          markerText = "$index.",
          textColor = textColor,
          inlineStyles = inlineStyles,
          listDepth = listDepth,
          isStreaming = isStreaming,
        )
        index += 1
      }
      item = item.next
    }
  }
}

@Composable
private fun RenderListItem(
  item: ListItem,
  markerText: String,
  textColor: Color,
  inlineStyles: InlineStyles,
  listDepth: Int,
  isStreaming: Boolean,
) {
  var contentStart = item.firstChild
  var marker = markerText
  val task = contentStart as? TaskListItemMarker
  if (task != null) {
    marker = if (task.isChecked) "☑" else "☐"
    contentStart = task.next
  }

  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
    verticalAlignment = Alignment.Top,
  ) {
    Text(
      text = marker,
      style = inlineStyles.baseCallout.copy(fontWeight = FontWeight.SemiBold),
      color = textColor,
      modifier = Modifier.width(24.dp),
    )

    Column(
      modifier = Modifier.weight(1f),
      verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      RenderMarkdownBlocks(
        blocks = commonMarkBlocks(contentStart),
        textColor = textColor,
        inlineStyles = inlineStyles,
        listDepth = listDepth + 1,
        isStreaming = isStreaming,
      )
    }
  }
}

@Composable
private fun RenderTableBlock(
  table: TableBlock,
  textColor: Color,
  inlineStyles: InlineStyles,
) {
  val rows = remember(table) { buildTableRows(table, inlineStyles) }
  if (rows.isEmpty()) return

  val maxCols = rows.maxOf { row -> row.cells.size }.coerceAtLeast(1)
  val scrollState = rememberScrollState()

  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .horizontalScroll(scrollState)
        .border(1.dp, mobileTextSecondary.copy(alpha = 0.25f)),
  ) {
    for (row in rows) {
      Row(
        modifier = Modifier.fillMaxWidth(),
      ) {
        for (index in 0 until maxCols) {
          val cell = row.cells.getOrNull(index) ?: AnnotatedString("")
          Text(
            text = cell,
            style = if (row.isHeader) mobileCaption1.copy(fontWeight = FontWeight.SemiBold) else inlineStyles.baseCallout,
            color = textColor,
            modifier =
              Modifier
                .border(1.dp, mobileTextSecondary.copy(alpha = 0.22f))
                .padding(horizontal = 8.dp, vertical = 6.dp)
                .width(160.dp),
          )
        }
      }
    }
  }
}

private fun buildTableRows(
  table: TableBlock,
  inlineStyles: InlineStyles,
): List<TableRenderRow> {
  val rows = mutableListOf<TableRenderRow>()
  var child = table.firstChild
  while (child != null) {
    when (child) {
      is TableHead -> rows.addAll(readTableSection(child, isHeader = true, inlineStyles = inlineStyles))
      is TableBody -> rows.addAll(readTableSection(child, isHeader = false, inlineStyles = inlineStyles))
      is TableRow -> rows.add(readTableRow(child, isHeader = false, inlineStyles = inlineStyles))
    }
    child = child.next
  }
  return rows
}

private fun readTableSection(
  section: Node,
  isHeader: Boolean,
  inlineStyles: InlineStyles,
): List<TableRenderRow> {
  val rows = mutableListOf<TableRenderRow>()
  var row = section.firstChild
  while (row != null) {
    if (row is TableRow) {
      rows.add(readTableRow(row, isHeader = isHeader, inlineStyles = inlineStyles))
    }
    row = row.next
  }
  return rows
}

private fun readTableRow(
  row: TableRow,
  isHeader: Boolean,
  inlineStyles: InlineStyles,
): TableRenderRow {
  val cells = mutableListOf<AnnotatedString>()
  var cellNode = row.firstChild
  while (cellNode != null) {
    if (cellNode is TableCell) {
      cells.add(buildInlineMarkdown(cellNode.firstChild, inlineStyles))
    }
    cellNode = cellNode.next
  }
  return TableRenderRow(isHeader = isHeader, cells = cells)
}

private fun buildInlineMarkdown(
  start: Node?,
  inlineStyles: InlineStyles,
): AnnotatedString =
  buildAnnotatedString {
    appendInlineNode(
      node = start,
      inlineCodeBg = inlineStyles.inlineCodeBg,
      inlineCodeColor = inlineStyles.inlineCodeColor,
      linkColor = inlineStyles.linkColor,
    )
  }

private fun AnnotatedString.Builder.appendInlineNode(
  node: Node?,
  inlineCodeBg: Color,
  inlineCodeColor: Color,
  linkColor: Color,
) {
  var current = node
  while (current != null) {
    when (current) {
      is MarkdownTextNode -> append(current.literal)
      is SoftLineBreak -> append('\n')
      is HardLineBreak -> append('\n')
      is Code -> {
        withStyle(
          SpanStyle(
            fontFamily = FontFamily.Monospace,
            background = inlineCodeBg,
            color = inlineCodeColor,
          ),
        ) {
          append(current.literal)
        }
      }
      is Emphasis -> {
        withStyle(SpanStyle(fontStyle = FontStyle.Italic)) {
          appendInlineNode(
            current.firstChild,
            inlineCodeBg = inlineCodeBg,
            inlineCodeColor = inlineCodeColor,
            linkColor = linkColor,
          )
        }
      }
      is StrongEmphasis -> {
        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) {
          appendInlineNode(
            current.firstChild,
            inlineCodeBg = inlineCodeBg,
            inlineCodeColor = inlineCodeColor,
            linkColor = linkColor,
          )
        }
      }
      is Strikethrough -> {
        withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) {
          appendInlineNode(
            current.firstChild,
            inlineCodeBg = inlineCodeBg,
            inlineCodeColor = inlineCodeColor,
            linkColor = linkColor,
          )
        }
      }
      is Link -> {
        appendLinkNode(
          link = current,
          inlineCodeBg = inlineCodeBg,
          inlineCodeColor = inlineCodeColor,
          linkColor = linkColor,
        )
      }
      is MarkdownImage -> {
        val alt = buildPlainText(current.firstChild)
        if (alt.isNotBlank()) {
          append(alt)
        } else {
          append("image")
        }
      }
      is HtmlInline -> {
        if (!current.literal.isNullOrBlank()) {
          append(current.literal)
        }
      }
      else -> {
        appendInlineNode(
          current.firstChild,
          inlineCodeBg = inlineCodeBg,
          inlineCodeColor = inlineCodeColor,
          linkColor = linkColor,
        )
      }
    }
    current = current.next
  }
}

private fun AnnotatedString.Builder.appendLinkNode(
  link: Link,
  inlineCodeBg: Color,
  inlineCodeColor: Color,
  linkColor: Color,
) {
  val destination = link.destination?.trim().orEmpty()
  val linkStyle =
    SpanStyle(
      color = linkColor,
      textDecoration = TextDecoration.Underline,
    )
  if (destination.isEmpty() || !isSafeMarkdownLinkDestination(destination)) {
    // Drop unsafe schemes while preserving visible link text.
    appendInlineNode(
      link.firstChild,
      inlineCodeBg = inlineCodeBg,
      inlineCodeColor = inlineCodeColor,
      linkColor = linkColor,
    )
    return
  }

  withLink(LinkAnnotation.Url(url = destination, styles = TextLinkStyles(style = linkStyle))) {
    appendInlineNode(
      link.firstChild,
      inlineCodeBg = inlineCodeBg,
      inlineCodeColor = inlineCodeColor,
      linkColor = linkColor,
    )
  }
}

internal fun isSafeMarkdownLinkDestination(destination: String): Boolean {
  val scheme =
    runCatching { URI(destination).scheme?.lowercase(Locale.US) }
      .getOrNull()
      ?: return false
  // Chat markdown links are user/model supplied; keep navigation limited to
  // browser-safe web URLs instead of custom Android intents or file URLs.
  return scheme == "http" || scheme == "https"
}

/** Builds styled inline markdown for compact chat labels and preview text. */
internal fun buildChatInlineMarkdown(
  text: String,
  linkColor: Color = Color.Blue,
): AnnotatedString {
  val document = parseChatMarkdown(text)
  val paragraph = document.firstChild as? Paragraph ?: return AnnotatedString("")
  return buildInlineMarkdown(
    paragraph.firstChild,
    InlineStyles(
      inlineCodeBg = Color.Transparent,
      inlineCodeColor = Color.Unspecified,
      linkColor = linkColor,
      baseCallout = TextStyle.Default,
    ),
  )
}

internal fun parseChatMarkdown(text: String): Document = markdownParser.parse(text) as Document

internal sealed interface ChatMarkdownRenderBlock {
  data class CommonMark(
    val node: Node,
  ) : ChatMarkdownRenderBlock

  data class LiteralHtml(
    val source: String,
  ) : ChatMarkdownRenderBlock

  data class Disclosure(
    val summary: String?,
    val isExpanded: Boolean,
    val blocks: List<ChatMarkdownRenderBlock>,
  ) : ChatMarkdownRenderBlock
}

internal fun chatMarkdownDisclosureSummarySource(
  authoredSummary: String?,
  localizedDefault: () -> String,
): String = authoredSummary ?: localizedDefault()

internal fun parseChatMarkdownBlocks(text: String): List<ChatMarkdownRenderBlock> {
  val document = parseChatMarkdown(text)
  val tokenizer = DisclosureTokenizer()
  val tokens = mutableListOf<DisclosureToken>()
  var node = document.firstChild
  while (node != null) {
    val current = node
    if (current is HtmlBlock && DisclosureTokenizer.startsWithCandidateLine(current.literal.orEmpty())) {
      tokens += tokenizer.tokenize(current.literal.orEmpty())
    } else {
      tokens += DisclosureToken.Block(ChatMarkdownRenderBlock.CommonMark(current))
    }
    node = current.next
  }
  return foldDisclosureTokens(tokens)
}

private fun commonMarkBlocks(start: Node?): List<ChatMarkdownRenderBlock> {
  val blocks = mutableListOf<ChatMarkdownRenderBlock>()
  var node = start
  while (node != null) {
    blocks += ChatMarkdownRenderBlock.CommonMark(node)
    node = node.next
  }
  return blocks
}

private sealed interface DisclosureToken {
  data class Block(
    val block: ChatMarkdownRenderBlock,
  ) : DisclosureToken

  data class Open(
    val isExpanded: Boolean,
  ) : DisclosureToken

  data class Summary(
    val source: String,
  ) : DisclosureToken

  data object Close : DisclosureToken
}

private class DisclosureTokenizer {
  private data class BalanceFrame(
    val isStructural: Boolean,
    var hasSummary: Boolean = false,
  )

  private enum class TagKind {
    DETAILS_OPEN,
    DETAILS_OPEN_EXPANDED,
    DETAILS_CLOSE,
    SUMMARY_OPEN,
    SUMMARY_CLOSE,
    UNSUPPORTED_DETAILS_OPEN,
    UNSUPPORTED_DETAILS_CLOSE,
    UNSUPPORTED_SUMMARY,
  }

  private data class Tag(
    val range: IntRange,
    val raw: String,
    val kind: TagKind,
  )

  // Disclosure scanning pauses inside CommonMark raw HTML block types 1-5;
  // their contents stay literal until the matching terminator.
  private sealed interface RawHtmlContext {
    fun closes(line: String): Boolean

    data object Comment : RawHtmlContext {
      override fun closes(line: String): Boolean = line.contains("-->")
    }

    data object ProcessingInstruction : RawHtmlContext {
      override fun closes(line: String): Boolean = line.contains("?>")
    }

    data object Declaration : RawHtmlContext {
      override fun closes(line: String): Boolean = line.contains('>')
    }

    data object Cdata : RawHtmlContext {
      override fun closes(line: String): Boolean = line.contains("]]>")
    }

    data class Element(
      val tag: String,
    ) : RawHtmlContext {
      override fun closes(line: String): Boolean = line.lowercase(Locale.US).contains("</$tag>")
    }

    companion object {
      fun opening(line: String): RawHtmlContext? {
        val trimmed = line.trimStart()
        val lowercased = trimmed.lowercase(Locale.US)
        if (trimmed.startsWith("<!--")) return Comment
        if (trimmed.startsWith("<?")) return ProcessingInstruction
        if (trimmed.startsWith("<![CDATA[")) return Cdata
        if (trimmed.length > 2 && trimmed.startsWith("<!") && trimmed[2] in 'A'..'Z') return Declaration
        for (tag in listOf("pre", "script", "style", "textarea")) {
          val prefix = "<$tag"
          if (!lowercased.startsWith(prefix)) continue
          val boundary = lowercased.getOrNull(prefix.length)
          if (boundary == null || boundary.isWhitespace() || boundary == '>') return Element(tag)
        }
        return null
      }
    }
  }

  private val balanceStack = mutableListOf<BalanceFrame>()

  fun tokenize(source: String): List<DisclosureToken> {
    val lines = source.split('\n')
    val tokens = mutableListOf<DisclosureToken>()
    val pendingSource = StringBuilder()
    var rawHtmlContext: RawHtmlContext? = null

    fun flushSource() {
      val markdown = pendingSource.toString()
      pendingSource.clear()
      if (markdown.isBlank()) return
      val document = parseChatMarkdown(markdown)
      var child = document.firstChild
      while (child != null) {
        tokens += DisclosureToken.Block(ChatMarkdownRenderBlock.CommonMark(child))
        child = child.next
      }
    }

    fun appendLiteral(raw: String) {
      flushSource()
      tokens += DisclosureToken.Block(ChatMarkdownRenderBlock.LiteralHtml(raw))
    }

    fun appendSourceLine(
      line: String,
      index: Int,
    ) {
      pendingSource.append(line)
      if (index < lines.lastIndex) pendingSource.append('\n')
    }

    lines.forEachIndexed { lineIndex, line ->
      rawHtmlContext?.let { context ->
        appendSourceLine(line, lineIndex)
        if (context.closes(line)) rawHtmlContext = null
        return@forEachIndexed
      }
      RawHtmlContext.opening(line)?.let { context ->
        appendSourceLine(line, lineIndex)
        if (!context.closes(line)) rawHtmlContext = context
        return@forEachIndexed
      }
      val tags = tags(line)
      if (tags == null) {
        appendSourceLine(line, lineIndex)
        return@forEachIndexed
      }

      var cursor = 0
      var index = 0
      while (index < tags.size) {
        val tag = tags[index]
        pendingSource.append(line, cursor, tag.range.first)
        when (tag.kind) {
          TagKind.DETAILS_OPEN,
          TagKind.DETAILS_OPEN_EXPANDED,
          -> {
            flushSource()
            val isStructural = balanceStack.size < CHAT_MARKDOWN_DISCLOSURE_MAX_DEPTH
            if (isStructural) {
              tokens += DisclosureToken.Open(tag.kind == TagKind.DETAILS_OPEN_EXPANDED)
            } else {
              appendLiteral(tag.raw)
            }
            balanceStack += BalanceFrame(isStructural = isStructural)
          }
          TagKind.UNSUPPORTED_DETAILS_OPEN -> {
            appendLiteral(tag.raw)
            balanceStack += BalanceFrame(isStructural = false)
          }
          TagKind.DETAILS_CLOSE,
          TagKind.UNSUPPORTED_DETAILS_CLOSE,
          -> {
            val frame = balanceStack.removeLastOrNull()
            if (frame == null) {
              appendLiteral(tag.raw)
            } else {
              flushSource()
              if (frame.isStructural && tag.kind == TagKind.DETAILS_CLOSE) {
                tokens += DisclosureToken.Close
              } else {
                appendLiteral(tag.raw)
              }
            }
          }
          TagKind.SUMMARY_OPEN -> {
            // The web block rule also pairs summary tags within one line;
            // multiline summaries deliberately remain literal on every surface.
            // Reference definitions resolve in bodies, not standalone summaries;
            // keeping fragments isolated avoids cross-document splicing.
            val closeIndex = ((index + 1) until tags.size).firstOrNull { tags[it].kind == TagKind.SUMMARY_CLOSE }
            val frame = balanceStack.lastOrNull()
            if (closeIndex != null && frame?.isStructural == true && !frame.hasSummary) {
              flushSource()
              val close = tags[closeIndex]
              val summary = line.substring(tag.range.last + 1, close.range.first)
              if (summary.isNotBlank()) tokens += DisclosureToken.Summary(summary)
              frame.hasSummary = true
              cursor = close.range.last + 1
              index = closeIndex + 1
              continue
            }
            appendLiteral(tag.raw)
          }
          TagKind.SUMMARY_CLOSE,
          TagKind.UNSUPPORTED_SUMMARY,
          -> appendLiteral(tag.raw)
        }
        cursor = tag.range.last + 1
        index += 1
      }
      pendingSource.append(line, cursor, line.length)
      if (lineIndex < lines.lastIndex) pendingSource.append('\n')
    }

    flushSource()
    return tokens
  }

  companion object {
    private val candidateLineRegex = Regex("^ {0,3}</?(?:details|summary)(?=[\\s>])", RegexOption.IGNORE_CASE)
    private val tagRegex = Regex("</?(?:details|summary)(?=[\\s>])[^>]*>", RegexOption.IGNORE_CASE)

    fun startsWithCandidateLine(source: String): Boolean = source.lineSequence().firstOrNull { it.isNotBlank() }?.let { tags(it) != null } ?: false

    private fun tags(line: String): List<Tag>? {
      if (!candidateLineRegex.containsMatchIn(line)) return null
      val codeRanges = inlineCodeRanges(line)
      val tags =
        tagRegex
          .findAll(line)
          .mapNotNull { match ->
            if (isEscaped(line, match.range.first) || codeRanges.any { match.range.first in it }) {
              null
            } else {
              Tag(range = match.range, raw = match.value, kind = kind(match.value))
            }
          }.toList()
      return tags.ifEmpty { null }
    }

    private fun kind(raw: String): TagKind =
      when (raw.lowercase(Locale.US)) {
        "<details>" -> TagKind.DETAILS_OPEN
        "<details open>" -> TagKind.DETAILS_OPEN_EXPANDED
        "</details>" -> TagKind.DETAILS_CLOSE
        "<summary>" -> TagKind.SUMMARY_OPEN
        "</summary>" -> TagKind.SUMMARY_CLOSE
        else -> {
          val lower = raw.lowercase(Locale.US)
          when {
            lower.startsWith("</details") -> TagKind.UNSUPPORTED_DETAILS_CLOSE
            lower.startsWith("<details") -> TagKind.UNSUPPORTED_DETAILS_OPEN
            else -> TagKind.UNSUPPORTED_SUMMARY
          }
        }
      }

    private fun isEscaped(
      line: String,
      index: Int,
    ): Boolean {
      var cursor = index - 1
      var count = 0
      while (cursor >= 0 && line[cursor] == '\\') {
        count += 1
        cursor -= 1
      }
      return count % 2 == 1
    }

    private fun inlineCodeRanges(line: String): List<IntRange> {
      val ranges = mutableListOf<IntRange>()
      var cursor = 0
      while (cursor < line.length) {
        if (line[cursor] != '`') {
          cursor += 1
          continue
        }
        val openerStart = cursor
        while (cursor < line.length && line[cursor] == '`') cursor += 1
        val runLength = cursor - openerStart
        var search = cursor
        var closeEnd = -1
        while (search < line.length) {
          if (line[search] != '`') {
            search += 1
            continue
          }
          val closeStart = search
          while (search < line.length && line[search] == '`') search += 1
          if (search - closeStart == runLength) {
            closeEnd = search
            break
          }
        }
        if (closeEnd >= 0) {
          ranges += openerStart until closeEnd
          cursor = closeEnd
        }
      }
      return ranges
    }
  }
}

private fun foldDisclosureTokens(tokens: List<DisclosureToken>): List<ChatMarkdownRenderBlock> {
  data class Frame(
    var summary: String? = null,
    val isExpanded: Boolean,
    val blocks: MutableList<ChatMarkdownRenderBlock> = mutableListOf(),
  )

  val result = mutableListOf<ChatMarkdownRenderBlock>()
  val stack = mutableListOf<Frame>()

  fun append(block: ChatMarkdownRenderBlock) {
    stack.lastOrNull()?.blocks?.add(block) ?: result.add(block)
  }

  fun closeTopFrame() {
    val frame = stack.removeLastOrNull() ?: return
    append(
      ChatMarkdownRenderBlock.Disclosure(
        summary = frame.summary,
        isExpanded = frame.isExpanded,
        blocks = frame.blocks,
      ),
    )
  }

  tokens.forEach { token ->
    when (token) {
      is DisclosureToken.Block -> append(token.block)
      is DisclosureToken.Open -> stack += Frame(isExpanded = token.isExpanded)
      is DisclosureToken.Summary -> stack.lastOrNull()?.summary = token.source
      DisclosureToken.Close -> closeTopFrame()
    }
  }

  // Streaming commonly ends before the closing tag; fold every open frame at
  // EOF so the partial body stays inside a stable expandable section.
  while (stack.isNotEmpty()) closeTopFrame()
  return result
}

private fun buildPlainText(start: Node?): String {
  val sb = StringBuilder()
  var node = start
  while (node != null) {
    when (node) {
      is MarkdownTextNode -> sb.append(node.literal)
      is SoftLineBreak, is HardLineBreak -> sb.append('\n')
      else -> sb.append(buildPlainText(node.firstChild))
    }
    node = node.next
  }
  return sb.toString()
}

private fun standaloneDataImage(paragraph: Paragraph): ParsedDataImage? {
  val only = paragraph.firstChild as? MarkdownImage ?: return null
  if (only.next != null) return null
  return parseDataImageDestination(only.destination)
}

/** Parses a data:image Markdown destination when it is safe to render inline. */
internal fun parseDataImageDestination(destination: String?): ParsedDataImage? {
  val raw = destination?.trim().orEmpty()
  if (raw.isEmpty()) return null
  // Bound the full URI before regex parsing so pasted data images cannot allocate huge match buffers.
  if (raw.length > CHAT_IMAGE_MAX_BASE64_CHARS + DATA_IMAGE_HEADER_MAX_CHARS) return null
  val match = dataImageRegex.matchEntire(raw) ?: return null
  val subtype =
    match.groupValues
      .getOrNull(1)
      ?.trim()
      ?.ifEmpty { "png" } ?: "png"
  val base64 =
    match.groupValues
      .getOrNull(2)
      ?.replace("\n", "")
      ?.replace("\r", "")
      ?.trim()
      .orEmpty()
  if (base64.isEmpty()) return null
  if (base64.length > CHAT_IMAGE_MAX_BASE64_CHARS) return null
  return ParsedDataImage(mimeType = "image/$subtype", base64 = base64)
}

private fun headingStyle(
  level: Int,
  baseCallout: TextStyle,
): TextStyle =
  when (level.coerceIn(1, 6)) {
    1 -> baseCallout.copy(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold)
    2 -> baseCallout.copy(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.Bold)
    3 -> baseCallout.copy(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold)
    4 -> baseCallout.copy(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold)
    else -> baseCallout.copy(fontWeight = FontWeight.SemiBold)
  }

private data class InlineStyles(
  val inlineCodeBg: Color,
  val inlineCodeColor: Color,
  val linkColor: Color,
  val baseCallout: TextStyle,
)

private data class TableRenderRow(
  val isHeader: Boolean,
  val cells: List<AnnotatedString>,
)

/**
 * Parsed bounded data-image payload for chat markdown rendering.
 */
internal data class ParsedDataImage(
  val mimeType: String,
  val base64: String,
)

@Composable
private fun InlineBase64Image(
  base64: String,
  mimeType: String?,
) {
  val imageState = rememberBase64ImageState(base64)
  val image = imageState.image

  if (image != null) {
    Image(
      bitmap = image,
      contentDescription = mimeType ?: nativeString("Image"),
      contentScale = ContentScale.Fit,
      modifier = Modifier.fillMaxWidth(),
    )
  } else if (imageState.failed) {
    Text(
      text = nativeString("Image unavailable"),
      modifier = Modifier.padding(vertical = 2.dp),
      style = mobileCaption1,
      color = mobileTextSecondary,
    )
  }
}
