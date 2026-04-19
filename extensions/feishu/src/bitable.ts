import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type } from "@sinclair/typebox";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuToolClient } from "./tool-account.js";

// ============ Helpers ============

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

type LarkResponse<T = unknown> = { code?: number; msg?: string; data?: T };
type BitableRecordCreatePayload = NonNullable<
  Parameters<Lark.Client["bitable"]["appTableRecord"]["create"]>[0]
>;
type BitableRecordUpdatePayload = NonNullable<
  Parameters<Lark.Client["bitable"]["appTableRecord"]["update"]>[0]
>;
type BitableRecordFields = NonNullable<NonNullable<BitableRecordCreatePayload["data"]>["fields"]>;
type BitableRecordUpdateFields = NonNullable<
  NonNullable<BitableRecordUpdatePayload["data"]>["fields"]
>;

export class LarkApiError extends Error {
  readonly code: number;
  readonly api: string;
  readonly context?: Record<string, unknown>;
  constructor(code: number, message: string, api: string, context?: Record<string, unknown>) {
    super(`[${api}] code=${code} message=${message}`);
    this.name = "LarkApiError";
    this.code = code;
    this.api = api;
    this.context = context;
  }
}

function ensureLarkSuccess<T>(
  res: LarkResponse<T>,
  api: string,
  context?: Record<string, unknown>,
): asserts res is LarkResponse<T> & { code: 0 } {
  if (res.code !== 0) {
    throw new LarkApiError(res.code ?? -1, res.msg ?? "unknown error", api, context);
  }
}

/** Field type ID to human-readable name */
const FIELD_TYPE_NAMES: Record<number, string> = {
  1: "Text",
  2: "Number",
  3: "SingleSelect",
  4: "MultiSelect",
  5: "DateTime",
  7: "Checkbox",
  11: "User",
  13: "Phone",
  15: "URL",
  17: "Attachment",
  18: "SingleLink",
  19: "Lookup",
  20: "Formula",
  21: "DuplexLink",
  22: "Location",
  23: "GroupChat",
  1001: "CreatedTime",
  1002: "ModifiedTime",
  1003: "CreatedUser",
  1004: "ModifiedUser",
  1005: "AutoNumber",
};

// ============ Core Functions ============

/** Parse bitable URL and extract tokens */
function parseBitableUrl(url: string): { token: string; tableId?: string; isWiki: boolean } | null {
  try {
    const u = new URL(url);
    const tableId = u.searchParams.get("table") ?? undefined;

    // Wiki format: /wiki/XXXXX?table=YYY
    const wikiMatch = u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
    if (wikiMatch) {
      return { token: wikiMatch[1], tableId, isWiki: true };
    }

    // Base format: /base/XXXXX?table=YYY
    const baseMatch = u.pathname.match(/\/base\/([A-Za-z0-9]+)/);
    if (baseMatch) {
      return { token: baseMatch[1], tableId, isWiki: false };
    }

    return null;
  } catch {
    return null;
  }
}

/** Get app_token from wiki node_token */
async function getAppTokenFromWiki(client: Lark.Client, nodeToken: string): Promise<string> {
  const res = await client.wiki.space.getNode({
    params: { token: nodeToken },
  });
  ensureLarkSuccess(res, "wiki.space.getNode", { nodeToken });

  const node = res.data?.node;
  if (!node) {
    throw new Error("Node not found");
  }
  if (node.obj_type !== "bitable") {
    throw new Error(`Node is not a bitable (type: ${node.obj_type})`);
  }

  return node.obj_token!;
}

/** Get bitable metadata from URL (handles both /base/ and /wiki/ URLs) */
async function getBitableMeta(client: Lark.Client, url: string) {
  const parsed = parseBitableUrl(url);
  if (!parsed) {
    throw new Error("Invalid URL format. Expected /base/XXX or /wiki/XXX URL");
  }

  let appToken: string;
  if (parsed.isWiki) {
    appToken = await getAppTokenFromWiki(client, parsed.token);
  } else {
    appToken = parsed.token;
  }

  // Get bitable app info
  const res = await client.bitable.app.get({
    path: { app_token: appToken },
  });
  ensureLarkSuccess(res, "bitable.app.get", { appToken });

  // List tables if no table_id specified
  let tables: { table_id: string; name: string }[] = [];
  if (!parsed.tableId) {
    const tablesRes = await client.bitable.appTable.list({
      path: { app_token: appToken },
    });
    if (tablesRes.code === 0) {
      tables = (tablesRes.data?.items ?? []).map((t) => ({
        table_id: t.table_id!,
        name: t.name!,
      }));
    }
  }

  return {
    app_token: appToken,
    table_id: parsed.tableId,
    name: res.data?.app?.name,
    url_type: parsed.isWiki ? "wiki" : "base",
    ...(tables.length > 0 && { tables }),
    hint: parsed.tableId
      ? `Use app_token="${appToken}" and table_id="${parsed.tableId}" for other bitable tools`
      : `Use app_token="${appToken}" for other bitable tools. Select a table_id from the tables list.`,
  };
}

async function listFields(client: Lark.Client, appToken: string, tableId: string) {
  const res = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
  });
  ensureLarkSuccess(res, "bitable.appTableField.list", { appToken, tableId });

  const fields = res.data?.items ?? [];
  return {
    fields: fields.map((f) => ({
      field_id: f.field_id,
      field_name: f.field_name,
      type: f.type,
      type_name: FIELD_TYPE_NAMES[f.type ?? 0] || `type_${f.type}`,
      is_primary: f.is_primary,
      ...(f.property && { property: f.property }),
    })),
    total: fields.length,
  };
}

async function listRecords(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  pageSize?: number,
  pageToken?: string,
) {
  const res = await client.bitable.appTableRecord.list({
    path: { app_token: appToken, table_id: tableId },
    params: {
      page_size: pageSize ?? 100,
      ...(pageToken && { page_token: pageToken }),
    },
  });
  ensureLarkSuccess(res, "bitable.appTableRecord.list", { appToken, tableId, pageSize });

  return {
    records: res.data?.items ?? [],
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
    total: res.data?.total,
  };
}

async function getRecord(client: Lark.Client, appToken: string, tableId: string, recordId: string) {
  const res = await client.bitable.appTableRecord.get({
    path: { app_token: appToken, table_id: tableId, record_id: recordId },
  });
  ensureLarkSuccess(res, "bitable.appTableRecord.get", { appToken, tableId, recordId });

  return {
    record: res.data?.record,
  };
}

async function createRecord(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  fields: BitableRecordFields,
) {
  const res = await client.bitable.appTableRecord.create({
    path: { app_token: appToken, table_id: tableId },
    data: { fields },
  });
  ensureLarkSuccess(res, "bitable.appTableRecord.create", { appToken, tableId });

  return {
    record: res.data?.record,
  };
}

/** Logger interface for cleanup operations */
type CleanupLogger = {
  debug: (msg: string) => void;
  warn: (msg: string) => void;
};

/** Default field types created for new Bitable tables (to be cleaned up) */
const DEFAULT_CLEANUP_FIELD_TYPES = new Set([3, 5, 17]); // SingleSelect, DateTime, Attachment

/** Clean up default placeholder rows and fields in a newly created Bitable table */
async function cleanupNewBitable(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  tableName: string,
  logger: CleanupLogger,
): Promise<{ cleanedRows: number; cleanedFields: number }> {
  let cleanedRows = 0;
  let cleanedFields = 0;

  // Step 1: Clean up default fields
  const fieldsRes = await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
  });

  if (fieldsRes.code === 0 && fieldsRes.data?.items) {
    // Step 1a: Rename primary field to the table name (works for both Feishu and Lark)
    const primaryField = fieldsRes.data.items.find((f) => f.is_primary);
    if (primaryField?.field_id) {
      try {
        const newFieldName = tableName.length <= 20 ? tableName : "Name";
        await client.bitable.appTableField.update({
          path: {
            app_token: appToken,
            table_id: tableId,
            field_id: primaryField.field_id,
          },
          data: {
            field_name: newFieldName,
            type: 1,
          },
        });
        cleanedFields++;
      } catch (err) {
        logger.debug(`Failed to rename primary field: ${String(err)}`);
      }
    }

    // Step 1b: Delete default placeholder fields by type (works for both Feishu and Lark)
    const defaultFieldsToDelete = fieldsRes.data.items.filter(
      (f) => !f.is_primary && DEFAULT_CLEANUP_FIELD_TYPES.has(f.type ?? 0),
    );

    for (const field of defaultFieldsToDelete) {
      if (field.field_id) {
        try {
          await client.bitable.appTableField.delete({
            path: {
              app_token: appToken,
              table_id: tableId,
              field_id: field.field_id,
            },
          });
          cleanedFields++;
        } catch (err) {
          logger.debug(`Failed to delete default field ${field.field_name}: ${String(err)}`);
        }
      }
    }
  }

  // Step 2: Delete empty placeholder rows (batch when possible)
  const recordsRes = await client.bitable.appTableRecord.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 100 },
  });

  if (recordsRes.code === 0 && recordsRes.data?.items) {
    const emptyRecordIds = recordsRes.data.items
      .filter((r) => !r.fields || Object.keys(r.fields).length === 0)
      .map((r) => r.record_id)
      .filter((id): id is string => Boolean(id));

    if (emptyRecordIds.length > 0) {
      try {
        await client.bitable.appTableRecord.batchDelete({
          path: { app_token: appToken, table_id: tableId },
          data: { records: emptyRecordIds },
        });
        cleanedRows = emptyRecordIds.length;
      } catch {
        // Fallback: delete one by one if batch API is unavailable
        for (const recordId of emptyRecordIds) {
          try {
            await client.bitable.appTableRecord.delete({
              path: { app_token: appToken, table_id: tableId, record_id: recordId },
            });
            cleanedRows++;
          } catch (err) {
            logger.debug(`Failed to delete empty row ${recordId}: ${String(err)}`);
          }
        }
      }
    }
  }

  return { cleanedRows, cleanedFields };
}

async function createApp(
  client: Lark.Client,
  name: string,
  folderToken?: string,
  logger?: CleanupLogger,
) {
  const res = await client.bitable.app.create({
    data: {
      name,
      ...(folderToken && { folder_token: folderToken }),
    },
  });
  ensureLarkSuccess(res, "bitable.app.create", { name, folderToken });

  const appToken = res.data?.app?.app_token;
  if (!appToken) {
    throw new Error("Failed to create Bitable: no app_token returned");
  }

  const log: CleanupLogger = logger ?? { debug: () => {}, warn: () => {} };
  let tableId: string | undefined;
  let cleanedRows = 0;
  let cleanedFields = 0;

  try {
    const tablesRes = await client.bitable.appTable.list({
      path: { app_token: appToken },
    });
    if (tablesRes.code === 0 && tablesRes.data?.items && tablesRes.data.items.length > 0) {
      tableId = tablesRes.data.items[0].table_id ?? undefined;
      if (tableId) {
        const cleanup = await cleanupNewBitable(client, appToken, tableId, name, log);
        cleanedRows = cleanup.cleanedRows;
        cleanedFields = cleanup.cleanedFields;
      }
    }
  } catch (err) {
    log.debug(`Cleanup failed (non-critical): ${String(err)}`);
  }

  return {
    app_token: appToken,
    table_id: tableId,
    name: res.data?.app?.name,
    url: res.data?.app?.url,
    cleaned_placeholder_rows: cleanedRows,
    cleaned_default_fields: cleanedFields,
    hint: tableId
      ? `Table created. Use app_token="${appToken}" and table_id="${tableId}" for other bitable tools.`
      : "Table created. Use feishu_bitable_get_meta to get table_id and field details.",
  };
}

async function createField(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  fieldName: string,
  fieldType: number,
  property?: Record<string, unknown>,
) {
  const res = await client.bitable.appTableField.create({
    path: { app_token: appToken, table_id: tableId },
    data: {
      field_name: fieldName,
      type: fieldType,
      ...(property && { property }),
    },
  });
  ensureLarkSuccess(res, "bitable.appTableField.create", {
    appToken,
    tableId,
    fieldName,
    fieldType,
  });

  return {
    field_id: res.data?.field?.field_id,
    field_name: res.data?.field?.field_name,
    type: res.data?.field?.type,
    type_name: FIELD_TYPE_NAMES[res.data?.field?.type ?? 0] || `type_${res.data?.field?.type}`,
  };
}

async function updateRecord(
  client: Lark.Client,
  appToken: string,
  tableId: string,
  recordId: string,
  fields: NonNullable<NonNullable<BitableRecordUpdatePayload["data"]>["fields"]>,
) {
  const res = await client.bitable.appTableRecord.update({
    path: { app_token: appToken, table_id: tableId, record_id: recordId },
    data: { fields },
  });
  ensureLarkSuccess(res, "bitable.appTableRecord.update", { appToken, tableId, recordId });

  return {
    record: res.data?.record,
  };
}

// ============ Schemas ============

const GetMetaSchema = Type.Object({
  url: Type.String({
    description: "Bitable URL. Supports both formats: /base/XXX?table=YYY or /wiki/XXX?table=YYY",
  }),
});

const ListFieldsSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
});

const ListRecordsSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  page_size: Type.Optional(
    Type.Number({
      description: "Number of records per page (1-500, default 100)",
      minimum: 1,
      maximum: 500,
    }),
  ),
  page_token: Type.Optional(
    Type.String({ description: "Pagination token from previous response" }),
  ),
});

const GetRecordSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  record_id: Type.String({ description: "Record ID to retrieve" }),
});

const CreateRecordSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  fields: Type.Record(Type.String(), Type.Any(), {
    description:
      "Field values keyed by field name. Format by type: Text='string', Number=123, SingleSelect='Option', MultiSelect=['A','B'], DateTime=timestamp_ms, User=[{id:'ou_xxx'}], URL={text:'Display',link:'https://...'}",
  }),
});

const CreateAppSchema = Type.Object({
  name: Type.String({
    description: "Name for the new Bitable application",
  }),
  folder_token: Type.Optional(
    Type.String({
      description: "Optional folder token to place the Bitable in a specific folder",
    }),
  ),
});

const CreateFieldSchema = Type.Object({
  app_token: Type.String({
    description:
      "Bitable app token (use feishu_bitable_get_meta to get from URL, or feishu_bitable_create_app to create new)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  field_name: Type.String({ description: "Name for the new field" }),
  field_type: Type.Number({
    description:
      "Field type ID: 1=Text, 2=Number, 3=SingleSelect, 4=MultiSelect, 5=DateTime, 7=Checkbox, 11=User, 13=Phone, 15=URL, 17=Attachment, 18=SingleLink, 19=Lookup, 20=Formula, 21=DuplexLink, 22=Location, 23=GroupChat, 1001=CreatedTime, 1002=ModifiedTime, 1003=CreatedUser, 1004=ModifiedUser, 1005=AutoNumber",
    minimum: 1,
  }),
  property: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "Field-specific properties (e.g., options for SingleSelect, format for Number)",
    }),
  ),
});

const UpdateRecordSchema = Type.Object({
  app_token: Type.String({
    description: "Bitable app token (use feishu_bitable_get_meta to get from URL)",
  }),
  table_id: Type.String({ description: "Table ID (from URL: ?table=YYY)" }),
  record_id: Type.String({ description: "Record ID to update" }),
  fields: Type.Record(Type.String(), Type.Any(), {
    description: "Field values to update (same format as create_record)",
  }),
});

// ============ Tool Registration ============

export function registerFeishuBitableTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_bitable: No config available, skipping bitable tools");
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_bitable: No Feishu accounts configured, skipping bitable tools");
    return;
  }

  type AccountAwareParams = { accountId?: string };

  const getClient = (params: AccountAwareParams | undefined, defaultAccountId?: string) =>
    createFeishuToolClient({ api, executeParams: params, defaultAccountId });

  const registerBitableTool = <
    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Tool params bind each schema-specific executor to its registered tool.
    TParams extends AccountAwareParams,
  >(params: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (args: { params: TParams; defaultAccountId?: string }) => Promise<unknown>;
  }) => {
    api.registerTool(
      (ctx) => ({
        name: params.name,
        label: params.label,
        description: params.description,
        parameters: params.parameters,
        async execute(_toolCallId, rawParams) {
          try {
            return json(
              await params.execute({
                params: rawParams as TParams,
                defaultAccountId: ctx.agentAccountId,
              }),
            );
          } catch (err) {
            return json({ error: formatErrorMessage(err) });
          }
        },
      }),
      { name: params.name },
    );
  };

  registerBitableTool<{ url: string; accountId?: string }>({
    name: "feishu_bitable_get_meta",
    label: "Feishu Bitable Get Meta",
    description:
      "Parse a Bitable URL and get app_token, table_id, and table list. Use this first when given a /wiki/ or /base/ URL.",
    parameters: GetMetaSchema,
    async execute({ params, defaultAccountId }) {
      return getBitableMeta(getClient(params, defaultAccountId), params.url);
    },
  });

  registerBitableTool<{ app_token: string; table_id: string; accountId?: string }>({
    name: "feishu_bitable_list_fields",
    label: "Feishu Bitable List Fields",
    description: "List all fields (columns) in a Bitable table with their types and properties",
    parameters: ListFieldsSchema,
    async execute({ params, defaultAccountId }) {
      return listFields(getClient(params, defaultAccountId), params.app_token, params.table_id);
    },
  });

  registerBitableTool<{
    app_token: string;
    table_id: string;
    page_size?: number;
    page_token?: string;
    accountId?: string;
  }>({
    name: "feishu_bitable_list_records",
    label: "Feishu Bitable List Records",
    description: "List records (rows) from a Bitable table with pagination support",
    parameters: ListRecordsSchema,
    async execute({ params, defaultAccountId }) {
      return listRecords(
        getClient(params, defaultAccountId),
        params.app_token,
        params.table_id,
        params.page_size,
        params.page_token,
      );
    },
  });

  registerBitableTool<{
    app_token: string;
    table_id: string;
    record_id: string;
    accountId?: string;
  }>({
    name: "feishu_bitable_get_record",
    label: "Feishu Bitable Get Record",
    description: "Get a single record by ID from a Bitable table",
    parameters: GetRecordSchema,
    async execute({ params, defaultAccountId }) {
      return getRecord(
        getClient(params, defaultAccountId),
        params.app_token,
        params.table_id,
        params.record_id,
      );
    },
  });

  registerBitableTool<{
    app_token: string;
    table_id: string;
    fields: BitableRecordFields;
    accountId?: string;
  }>({
    name: "feishu_bitable_create_record",
    label: "Feishu Bitable Create Record",
    description: "Create a new record (row) in a Bitable table",
    parameters: CreateRecordSchema,
    async execute({ params, defaultAccountId }) {
      return createRecord(
        getClient(params, defaultAccountId),
        params.app_token,
        params.table_id,
        params.fields,
      );
    },
  });

  registerBitableTool<{
    app_token: string;
    table_id: string;
    record_id: string;
    fields: BitableRecordUpdateFields;
    accountId?: string;
  }>({
    name: "feishu_bitable_update_record",
    label: "Feishu Bitable Update Record",
    description: "Update an existing record (row) in a Bitable table",
    parameters: UpdateRecordSchema,
    async execute({ params, defaultAccountId }) {
      return updateRecord(
        getClient(params, defaultAccountId),
        params.app_token,
        params.table_id,
        params.record_id,
        params.fields,
      );
    },
  });

  registerBitableTool<{ name: string; folder_token?: string; accountId?: string }>({
    name: "feishu_bitable_create_app",
    label: "Feishu Bitable Create App",
    description: "Create a new Bitable (multidimensional table) application",
    parameters: CreateAppSchema,
    async execute({ params, defaultAccountId }) {
      return createApp(getClient(params, defaultAccountId), params.name, params.folder_token, {
        debug: (msg) => api.logger.debug?.(msg),
        warn: (msg) => api.logger.warn?.(msg),
      });
    },
  });

  registerBitableTool<{
    app_token: string;
    table_id: string;
    field_name: string;
    field_type: number;
    property?: Record<string, unknown>;
    accountId?: string;
  }>({
    name: "feishu_bitable_create_field",
    label: "Feishu Bitable Create Field",
    description: "Create a new field (column) in a Bitable table",
    parameters: CreateFieldSchema,
    async execute({ params, defaultAccountId }) {
      return createField(
        getClient(params, defaultAccountId),
        params.app_token,
        params.table_id,
        params.field_name,
        params.field_type,
        params.property,
      );
    },
  });

  api.logger.debug?.("feishu_bitable: Registered bitable tools");
}
