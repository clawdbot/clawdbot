package ai.openclaw.app.ui.chat

import ai.openclaw.app.ui.mobileAccent
import ai.openclaw.app.ui.mobileCallout
import ai.openclaw.app.ui.mobileCaption1
import ai.openclaw.app.ui.mobileCodeBg
import ai.openclaw.app.ui.mobileCodeText
import ai.openclaw.app.ui.mobileTextSecondary
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
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
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
import org.commonmark.parser.Parser
import org.commonmark.node.Image as MarkdownImage
import org.commonmark.node.Text as MarkdownTextNode

private const val LIST_INDENT_DP = 14
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
    .build()
}

@Composable
fun ChatMarkdown(
  text: String,
  textColor: Color,
) {
  val document = remember(text) { markdownParser.parse(text) as Document }
  val inlineStyles =
    InlineStyles(inlineCodeBg = mobileCodeBg, inlineCodeColor = mobileCodeText, linkColor = mobileAccent, baseCallout = mobileCallout)

  Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
    RenderMarkdownBlocks(
      start = document.firstChild,
      textColor = textColor,
      inlineStyles = inlineStyles,
      listDepth = 0,
    )
  }
}

@Composable
private fun RenderMarkdownBlocks(
  start: Node?,
  textColor: Color,
  inlineStyles: InlineStyles,
  listDepth: Int,
) {
  var node = start
  while (node != null) {
    val current = node
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
          ChatCodeBlock(code = current.literal.orEmpty(), language = current.info?.trim()?.ifEmpty { null })
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
              start = current.firstChild,
              textColor = textColor,
              inlineStyles = inlineStyles,
              listDepth = listDepth,
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
        )
      }
      is OrderedList -> {
        RenderOrderedList(
          list = current,
          textColor = textColor,
          inlineStyles = inlineStyles,
          listDepth = listDepth,
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
        val literal = current.literal.orEmpty().trim()
        if (literal.isNotEmpty()) {
          Text(
            text = literal,
            style = mobileCallout.copy(fontFamily = FontFamily.Monospace),
            color = textColor,
          )
        }
      }
    }
    node = current.next
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
        start = contentStart,
        textColor = textColor,
        inlineStyles = inlineStyles,
        listDepth = listDepth + 1,
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
        withStyle(
          SpanStyle(
            color = linkColor,
            textDecoration = TextDecoration.Underline,
          ),
        ) {
          appendInlineNode(
            current.firstChild,
            inlineCodeBg = inlineCodeBg,
            inlineCodeColor = inlineCodeColor,
            linkColor = linkColor,
          )
        }
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
        appendInlineNode(current.firstChild, inlineCodeBg = inlineCodeBg, inlineCodeColor = inlineCodeColor, linkColor = linkColor)
      }
    }
    current = current.next
  }
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

private fun parseDataImageDestination(destination: String?): ParsedDataImage? {
  val raw = destination?.trim().orEmpty()
  if (raw.isEmpty()) return null
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

private data class ParsedDataImage(
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
      contentDescription = mimeType ?: "image",
      contentScale = ContentScale.Fit,
      modifier = Modifier.fillMaxWidth(),
    )
  } else if (imageState.failed) {
    Text(
      text = "Image unavailable",
      modifier = Modifier.padding(vertical = 2.dp),
      style = mobileCaption1,
      color = mobileTextSecondary,
    )
  }
}
