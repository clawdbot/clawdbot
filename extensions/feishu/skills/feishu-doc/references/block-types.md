# Feishu Block Types Reference

Complete reference for Feishu document block types. Use with `feishu_doc_list_blocks`, `feishu_doc_update_block`, and `feishu_doc_delete_block`.

## Block Type Table

| block_type | Name            | Description                    | Editable |
| ---------- | --------------- | ------------------------------ | -------- |
| 1          | Page            | Document root (contains title) | No       |
| 2          | Text            | Plain text paragraph           | Yes      |
| 3          | Heading1        | H1 heading                     | Yes      |
| 4          | Heading2        | H2 heading                     | Yes      |
| 5          | Heading3        | H3 heading                     | Yes      |
| 6          | Heading4        | H4 heading                     | Yes      |
| 7          | Heading5        | H5 heading                     | Yes      |
| 8          | Heading6        | H6 heading                     | Yes      |
| 9          | Heading7        | H7 heading                     | Yes      |
| 10         | Heading8        | H8 heading                     | Yes      |
| 11         | Heading9        | H9 heading                     | Yes      |
| 12         | Bullet          | Unordered list item            | Yes      |
| 13         | Ordered         | Ordered list item              | Yes      |
| 14         | Code            | Code block                     | Yes      |
| 15         | Quote           | Blockquote                     | Yes      |
| 16         | Equation        | LaTeX equation                 | Partial  |
| 17         | Todo            | Checkbox / task item           | Yes      |
| 18         | Bitable         | Multi-dimensional table        | No       |
| 19         | Callout         | Highlight block                | Yes      |
| 20         | ChatCard        | Chat card embed                | No       |
| 21         | Diagram         | Diagram embed                  | No       |
| 22         | Divider         | Horizontal rule                | No       |
| 23         | File            | File attachment                | No       |
| 24         | Grid            | Grid layout container          | No       |
| 25         | GridColumn      | Grid column                    | No       |
| 26         | Iframe          | Embedded iframe                | No       |
| 27         | Image           | Image                          | Partial  |
| 28         | ISV             | Third-party widget             | No       |
| 29         | MindnoteBlock   | Mindmap embed                  | No       |
| 30         | Sheet           | Spreadsheet embed              | No       |
| 31         | Table           | Table                          | Partial  |
| 32         | TableCell       | Table cell                     | Yes      |
| 33         | View            | View embed                     | No       |
| 34         | Undefined       | Unknown type                   | No       |
| 35         | QuoteContainer  | Quote container                | No       |
| 36         | Task            | Lark Tasks integration         | No       |
| 37         | OKR             | OKR integration                | No       |
| 38         | OKRObjective    | OKR objective                  | No       |
| 39         | OKRKeyResult    | OKR key result                 | No       |
| 40         | OKRProgress     | OKR progress                   | No       |
| 41         | AddOns          | Add-ons block                  | No       |
| 42         | JiraIssue       | Jira issue embed               | No       |
| 43         | WikiCatalog     | Wiki catalog                   | No       |
| 44         | Board           | Board embed                    | No       |
| 45         | Agenda          | Agenda block                   | No       |
| 46         | AgendaItem      | Agenda item                    | No       |
| 47         | AgendaItemTitle | Agenda item title              | No       |
| 48         | SyncedBlock     | Synced block reference         | No       |

## Editing Guidelines

### Text-based blocks (2-17, 19)

Update text content using `feishu_doc_update_block`:

```json
{
  "doc_token": "ABC123",
  "block_id": "block_xxx",
  "content": "New text content"
}
```

### Image blocks (27)

Images cannot be updated directly via `update_block`. Use `feishu_doc_write` or `feishu_doc_append` with markdown to add new images.

### Table blocks (31)

**Important:** Table blocks CANNOT be created via the `documentBlockChildren.create` API (error 1770029). This affects `feishu_doc_write` and `feishu_doc_append` - markdown tables will be skipped with a warning.

Tables can only be read (via `list_blocks`) and individual cells (type 32) can be updated, but new tables cannot be inserted programmatically via markdown.

### Container blocks (24, 25, 35)

Grid and QuoteContainer are layout containers. Edit their child blocks instead.

## Common Patterns

### Replace specific paragraph

1. `feishu_doc_list_blocks` - find the block_id
2. `feishu_doc_update_block` - update its content

### Insert content at specific location

Currently, the API only supports appending to document end. For insertion at specific positions, consider:

1. Read existing content
2. Delete affected blocks
3. Rewrite with new content in desired order

### Delete multiple blocks

Blocks must be deleted one at a time. Delete child blocks before parent containers.
