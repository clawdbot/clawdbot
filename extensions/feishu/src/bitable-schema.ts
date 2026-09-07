// Feishu helper module supports Bitable schema behavior.
import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";

const BITABLE_APP_TOKEN_DESCRIPTION =
  "Bitable application token (the /base/ URL identifier, or app_token from metadata). Not the node token in a /wiki/ URL.";
const BITABLE_RECORD_FIELDS_DESCRIPTION =
  "Field values keyed by field name. Format by type: Text='string', Number=123, SingleSelect='Option', MultiSelect=['A','B'], DateTime=timestamp_ms, User=[{id:'ou_xxx'}], URL={text:'Display',link:'https://...'}";

// TypeBox emits an empty schema for Any/Unknown, which Bedrock-backed validators
// can reject inside patternProperties. Keep the existing any-JSON-value contract explicit.
const BitableFieldValueSchema = Type.Unsafe<unknown>({
  type: ["string", "number", "boolean", "object", "array", "null"],
});

export const FeishuBitableSchema = {
  getMeta: Type.Object({
    url: Type.String({
      description: "Bitable URL. Supports both formats: /base/XXX?table=YYY or /wiki/XXX?table=YYY",
    }),
  }),
  listFields: Type.Object({
    app_token: Type.String({ description: BITABLE_APP_TOKEN_DESCRIPTION }),
    table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  }),
  listRecords: Type.Object({
    app_token: Type.String({ description: BITABLE_APP_TOKEN_DESCRIPTION }),
    table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
    page_size: optionalPositiveIntegerSchema({
      description: "Number of records per page (1-500, default 100)",
      maximum: 500,
    }),
    page_token: Type.Optional(
      Type.String({ description: "Pagination token from previous response" }),
    ),
  }),
  getRecord: Type.Object({
    app_token: Type.String({ description: BITABLE_APP_TOKEN_DESCRIPTION }),
    table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
    record_id: Type.String({ description: "Record ID to retrieve" }),
  }),
  createRecord: Type.Object({
    app_token: Type.String({ description: BITABLE_APP_TOKEN_DESCRIPTION }),
    table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
    fields: Type.Record(Type.String(), BitableFieldValueSchema, {
      description: BITABLE_RECORD_FIELDS_DESCRIPTION,
    }),
  }),
  createApp: Type.Object({
    name: Type.String({
      description: "Name for the new Bitable application",
    }),
    folder_token: Type.Optional(
      Type.String({
        description: "Optional folder token to place the Bitable in a specific folder",
      }),
    ),
  }),
  createField: Type.Object({
    app_token: Type.String({ description: BITABLE_APP_TOKEN_DESCRIPTION }),
    table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
    field_name: Type.String({ description: "Name for the new field" }),
    field_type: Type.Number({
      description:
        "Field type ID: 1=Text, 2=Number, 3=SingleSelect, 4=MultiSelect, 5=DateTime, 7=Checkbox, 11=User, 13=Phone, 15=URL, 17=Attachment, 18=SingleLink, 19=Lookup, 20=Formula, 21=DuplexLink, 22=Location, 23=GroupChat, 1001=CreatedTime, 1002=ModifiedTime, 1003=CreatedUser, 1004=ModifiedUser, 1005=AutoNumber",
      minimum: 1,
    }),
    property: Type.Optional(
      Type.Record(Type.String(), BitableFieldValueSchema, {
        description:
          "Field-specific properties (e.g., options for SingleSelect, format for Number)",
      }),
    ),
  }),
  updateRecord: Type.Object({
    app_token: Type.String({ description: BITABLE_APP_TOKEN_DESCRIPTION }),
    table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
    record_id: Type.String({ description: "Record ID to update" }),
    fields: Type.Record(Type.String(), BitableFieldValueSchema, {
      description: BITABLE_RECORD_FIELDS_DESCRIPTION,
    }),
  }),
};
