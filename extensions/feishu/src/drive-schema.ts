import { Type, type Static } from "typebox";

const FileType = Type.Union([
  Type.Literal("doc"),
  Type.Literal("docx"),
  Type.Literal("sheet"),
  Type.Literal("bitable"),
  Type.Literal("folder"),
  Type.Literal("file"),
  Type.Literal("mindnote"),
  Type.Literal("shortcut"),
]);

const CommentFileType = Type.Union([
  Type.Literal("doc"),
  Type.Literal("docx"),
  Type.Literal("sheet"),
  Type.Literal("file"),
  Type.Literal("slides"),
]);

export const FeishuDriveSchema = Type.Union([
  Type.Object({
    action: Type.Literal("list"),
    folder_token: Type.Optional(
      Type.String({ description: "Folder token (optional, omit for root directory)" }),
    ),
  }),
  Type.Object({
    action: Type.Literal("info"),
    file_token: Type.String({ description: "File or folder token" }),
    type: FileType,
  }),
  Type.Object({
    action: Type.Literal("create_folder"),
    name: Type.String({ description: "Folder name" }),
    folder_token: Type.Optional(
      Type.String({ description: "Parent folder token (optional, omit for root)" }),
    ),
  }),
  Type.Object({
    action: Type.Literal("move"),
    file_token: Type.String({ description: "File token to move" }),
    type: FileType,
    folder_token: Type.String({ description: "Target folder token" }),
  }),
  Type.Object({
    action: Type.Literal("delete"),
    file_token: Type.String({ description: "File token to delete" }),
    type: FileType,
  }),
  Type.Object({
    action: Type.Literal("list_comments"),
    file_token: Type.String({ description: "Document token" }),
    file_type: Type.Optional(CommentFileType),
    page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Page size" })),
    page_token: Type.Optional(Type.String({ description: "Comment page token" })),
  }),
  Type.Object({
    action: Type.Literal("list_comment_replies"),
    file_token: Type.String({ description: "Document token" }),
    file_type: Type.Optional(CommentFileType),
    comment_id: Type.String({ description: "Comment id" }),
    page_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Page size" })),
    page_token: Type.Optional(Type.String({ description: "Reply page token" })),
  }),
  Type.Object({
    action: Type.Literal("add_comment"),
    file_token: Type.String({ description: "Document token" }),
    file_type: Type.Optional(
      Type.Union([Type.Literal("doc"), Type.Literal("docx")], {
        description: "Document type. Defaults to docx when omitted.",
      }),
    ),
    content: Type.String({ description: "Comment text content" }),
    block_id: Type.Optional(
      Type.String({
        description:
          "Optional docx block id for a local comment. Omit to create a full-document comment.",
      }),
    ),
  }),
  Type.Object({
    action: Type.Literal("reply_comment"),
    file_token: Type.String({ description: "Document token" }),
    file_type: Type.Optional(CommentFileType),
    comment_id: Type.String({ description: "Comment id" }),
    content: Type.String({ description: "Reply text content" }),
  }),
]);

export type FeishuDriveParams = Static<typeof FeishuDriveSchema>;
