import { Type, type Static } from "@sinclair/typebox";

const tableCreationProperties = {
  doc_token: Type.String({ description: "Document token" }),
  parent_block_id: Type.Optional(
    Type.String({ description: "Parent block ID (default: document root)" }),
  ),
  row_size: Type.Integer({ description: "Table row count", minimum: 1 }),
  column_size: Type.Integer({ description: "Table column count", minimum: 1 }),
  column_width: Type.Optional(
    Type.Array(Type.Number({ minimum: 1 }), {
      description: "Column widths in px (length should match column_size)",
    }),
  ),
};

export const FeishuDocSchema = Type.Union([
  Type.Object({
    action: Type.Literal("read"),
    doc_token: Type.String({ description: "Document token (extract from URL /docx/XXX)" }),
  }),
  Type.Object({
    action: Type.Literal("write"),
    doc_token: Type.String({ description: "Document token" }),
    content: Type.String({
      description: "Markdown content to write (replaces entire document content)",
    }),
  }),
  Type.Object({
    action: Type.Literal("append"),
    doc_token: Type.String({ description: "Document token" }),
    content: Type.String({ description: "Markdown content to append to end of document" }),
  }),
  Type.Object({
    action: Type.Literal("insert"),
    doc_token: Type.String({ description: "Document token" }),
    content: Type.String({ description: "Markdown content to insert" }),
    after_block_id: Type.String({
      description: "Insert content after this block ID. Use list_blocks to find block IDs.",
    }),
  }),
  Type.Object({
    action: Type.Literal("create"),
    title: Type.String({ description: "Document title" }),
    folder_token: Type.Optional(Type.String({ description: "Target folder token (optional)" })),
    grant_to_requester: Type.Optional(
      Type.Boolean({
        description:
          "Grant edit permission to the trusted requesting Feishu user from runtime context (default: true).",
      }),
    ),
  }),
  Type.Object({
    action: Type.Literal("list_blocks"),
    doc_token: Type.String({ description: "Document token" }),
  }),
  Type.Object({
    action: Type.Literal("get_block"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Block ID (from list_blocks)" }),
  }),
  Type.Object({
    action: Type.Literal("update_block"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Block ID (from list_blocks)" }),
    content: Type.String({ description: "New text content" }),
  }),
  Type.Object({
    action: Type.Literal("delete_block"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Block ID" }),
  }),
  // Table creation (explicit structure)
  Type.Object({
    action: Type.Literal("create_table"),
    ...tableCreationProperties,
  }),
  Type.Object({
    action: Type.Literal("write_table_cells"),
    doc_token: Type.String({ description: "Document token" }),
    table_block_id: Type.String({ description: "Table block ID" }),
    values: Type.Array(Type.Array(Type.String()), {
      description: "2D matrix values[row][col] to write into table cells",
      minItems: 1,
    }),
  }),
  Type.Object({
    action: Type.Literal("create_table_with_values"),
    ...tableCreationProperties,
    values: Type.Array(Type.Array(Type.String()), {
      description: "2D matrix values[row][col] to write into table cells",
      minItems: 1,
    }),
  }),
  // Table row/column manipulation
  Type.Object({
    action: Type.Literal("insert_table_row"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Table block ID" }),
    row_index: Type.Optional(
      Type.Number({ description: "Row index to insert at (-1 for end, default: -1)" }),
    ),
  }),
  Type.Object({
    action: Type.Literal("insert_table_column"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Table block ID" }),
    column_index: Type.Optional(
      Type.Number({ description: "Column index to insert at (-1 for end, default: -1)" }),
    ),
  }),
  Type.Object({
    action: Type.Literal("delete_table_rows"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Table block ID" }),
    row_start: Type.Number({ description: "Start row index (0-based)" }),
    row_count: Type.Optional(Type.Number({ description: "Number of rows to delete (default: 1)" })),
  }),
  Type.Object({
    action: Type.Literal("delete_table_columns"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Table block ID" }),
    column_start: Type.Number({ description: "Start column index (0-based)" }),
    column_count: Type.Optional(
      Type.Number({ description: "Number of columns to delete (default: 1)" }),
    ),
  }),
  Type.Object({
    action: Type.Literal("merge_table_cells"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Table block ID" }),
    row_start: Type.Number({ description: "Start row index" }),
    row_end: Type.Number({ description: "End row index (exclusive)" }),
    column_start: Type.Number({ description: "Start column index" }),
    column_end: Type.Number({ description: "End column index (exclusive)" }),
  }),
  // Image / file upload
  Type.Object({
    action: Type.Literal("upload_image"),
    doc_token: Type.String({ description: "Document token" }),
    url: Type.Optional(Type.String({ description: "Remote image URL (http/https)" })),
    file_path: Type.Optional(Type.String({ description: "Local image file path" })),
    image: Type.Optional(
      Type.String({
        description:
          "Image as data URI (data:image/png;base64,...) or plain base64 string. Use instead of url/file_path for DALL-E outputs, canvas screenshots, etc.",
      }),
    ),
    parent_block_id: Type.Optional(
      Type.String({ description: "Parent block ID (default: document root)" }),
    ),
    filename: Type.Optional(Type.String({ description: "Optional filename override" })),
    index: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Insert position (0-based index among siblings). Omit to append.",
      }),
    ),
  }),
  Type.Object({
    action: Type.Literal("upload_file"),
    doc_token: Type.String({ description: "Document token" }),
    url: Type.Optional(Type.String({ description: "Remote file URL (http/https)" })),
    file_path: Type.Optional(Type.String({ description: "Local file path" })),
    parent_block_id: Type.Optional(
      Type.String({ description: "Parent block ID (default: document root)" }),
    ),
    filename: Type.Optional(Type.String({ description: "Optional filename override" })),
  }),
  // Text color / style
  Type.Object({
    action: Type.Literal("color_text"),
    doc_token: Type.String({ description: "Document token" }),
    block_id: Type.String({ description: "Text block ID to update" }),
    content: Type.String({
      description:
        'Text with color markup. Tags: [red], [green], [blue], [orange], [yellow], [purple], [grey], [bold], [bg:yellow]. Example: "Revenue [green]+15%[/green] YoY"',
    }),
  }),
]);

export type FeishuDocParams = Static<typeof FeishuDocSchema>;
