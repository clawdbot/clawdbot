// Feishu plugin module implements bitable behavior.
import type * as Lark from "@larksuiteoapi/node-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { TSchema } from "typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { FeishuBitableSchema } from "./bitable-schema.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import { feishuExternalToolResult as json } from "./tool-result.js";

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
type BitableMetadataResponse<T> = LarkResponse<{
  items?: T[];
  has_more?: boolean;
  page_token?: string;
}>;

class LarkApiError extends Error {
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

async function listBitableMetadataItems<T>(
  loadPage: (pageToken?: string) => Promise<BitableMetadataResponse<T>>,
  api: string,
  context?: Record<string, unknown>,
): Promise<T[]> {
  const items: T[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const response = await loadPage(pageToken);
    ensureLarkSuccess(response, api, context);
    const data = response.data;
    if (!data) {
      throw new Error(`${api} returned missing response data`);
    }
    items.push(...(data.items ?? []));
    if (data.has_more !== true) {
      return items;
    }

    // Provider cursors are opaque: validate blanks without changing token identity.
    const nextPageToken = data.page_token;
    if (!nextPageToken?.trim()) {
      throw new Error(`${api} pagination returned a missing page token`);
    }
    if (seenPageTokens.has(nextPageToken)) {
      throw new Error(`${api} pagination returned a repeated page token`);
    }
    seenPageTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }

  throw new Error(`${api} pagination exceeded 100 pages`);
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
      const wikiPathSegment = wikiMatch[1];
      return wikiPathSegment === undefined
        ? null
        : { token: wikiPathSegment, tableId, isWiki: true };
    }

    // Base format: /base/XXXXX?table=YYY
    const baseMatch = u.pathname.match(/\/base\/([A-Za-z0-9]+)/);
    if (baseMatch) {
      const basePathSegment = baseMatch[1];
      return basePathSegment === undefined
        ? null
        : { token: basePathSegment, tableId, isWiki: false };
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
  const tables = parsed.tableId
    ? []
    : (
        await listBitableMetadataItems(
          (pageToken) =>
            client.bitable.appTable.list({
              path: { app_token: appToken },
              params: { page_size: 100, page_token: pageToken },
            }),
          "bitable.appTable.list",
          { appToken },
        )
      ).map((table) => ({ table_id: table.table_id!, name: table.name! }));

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
  const fields = await listBitableMetadataItems(
    (pageToken) =>
      client.bitable.appTableField.list({
        path: { app_token: appToken, table_id: tableId },
        params: { page_size: 100, page_token: pageToken },
      }),
    "bitable.appTableField.list",
    { appToken, tableId },
  );
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

function readBitableListRecordsPageSize(params: Record<string, unknown>): number | undefined {
  return readPositiveIntegerParam(params, "page_size", {
    max: 500,
    message: "page_size must be a positive integer between 1 and 500",
  });
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

function isDefaultEmptyBitableFieldValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isDefaultEmptyBitableFieldValue);
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0) {
      return true;
    }
    if ("text" in record && keys.every((key) => key === "text" || key === "type")) {
      return record.text === undefined || record.text === null || record.text === "";
    }
    return Object.values(record).every(isDefaultEmptyBitableFieldValue);
  }
  return false;
}

function isPlaceholderBitableRecord(fields: unknown): boolean {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return true;
  }
  const values = Object.values(fields);
  return values.every(isDefaultEmptyBitableFieldValue);
}

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
      .filter((r) => isPlaceholderBitableRecord(r.fields))
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
      tableId = tablesRes.data.items.at(0)?.table_id;
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
      : "Application created, but table metadata was not retrieved. Inspect the existing application using the returned app_token or URL; do not create it again.",
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

// ============ Tool Registration ============

export function registerFeishuBitableTools(api: OpenClawPluginApi) {
  if (!api.config) {
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(api.config);
  if (!toolsCfg.bitable) {
    return;
  }

  type AccountAwareParams = { accountId?: string };

  const getClient = (params: AccountAwareParams | undefined, defaultAccountId?: string) =>
    createFeishuToolClient({
      api,
      executeParams: params,
      defaultAccountId,
      requiredTool: { family: "bitable", label: "Bitable" },
    });

  const registerBitableTool = <
    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Tool params bind each schema-specific executor to its registered tool.
    TParams extends AccountAwareParams,
  >(params: {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute: (args: { params: TParams; defaultAccountId?: string }) => Promise<unknown>;
  }) => {
    api.registerTool(
      (ctx) => ({
        name: params.name,
        resultContentSource: "network",
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
    parameters: FeishuBitableSchema.getMeta,
    async execute({ params, defaultAccountId }) {
      return getBitableMeta(getClient(params, defaultAccountId), params.url);
    },
  });

  registerBitableTool<{ app_token: string; table_id: string; accountId?: string }>({
    name: "feishu_bitable_list_fields",
    label: "Feishu Bitable List Fields",
    description: "List all fields (columns) in a Bitable table with their types and properties",
    parameters: FeishuBitableSchema.listFields,
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
    parameters: FeishuBitableSchema.listRecords,
    async execute({ params, defaultAccountId }) {
      return listRecords(
        getClient(params, defaultAccountId),
        params.app_token,
        params.table_id,
        readBitableListRecordsPageSize(params as Record<string, unknown>),
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
    parameters: FeishuBitableSchema.getRecord,
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
    parameters: FeishuBitableSchema.createRecord,
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
    parameters: FeishuBitableSchema.updateRecord,
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
    parameters: FeishuBitableSchema.createApp,
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
    parameters: FeishuBitableSchema.createField,
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
}
