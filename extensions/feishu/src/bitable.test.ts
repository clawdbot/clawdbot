import type * as Lark from "@larksuiteoapi/node-sdk";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

import { registerFeishuBitableTools } from "./bitable.js";

type MockRecord = {
  record_id?: string;
  fields?: Record<string, unknown>;
};

function createConfig(): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          default: {
            appId: "cli_default",
            appSecret: "secret_default", // pragma: allowlist secret
          },
        },
      },
    },
  } as OpenClawPluginApi["config"];
}

function createBitableClient(records: MockRecord[]) {
  const batchDelete = vi.fn(async () => ({ code: 0 }));
  const client = {
    bitable: {
      app: {
        create: vi.fn(async () => ({
          code: 0,
          data: {
            app: {
              app_token: "app_token",
              name: "Project Tracker",
              url: "https://example.feishu.cn/base/app_token",
            },
          },
        })),
      },
      appTable: {
        list: vi.fn(async () => ({
          code: 0,
          data: { items: [{ table_id: "tbl_main", name: "Table 1" }] },
        })),
      },
      appTableField: {
        list: vi.fn(async () => ({ code: 0, data: { items: [] } })),
        update: vi.fn(async () => ({ code: 0 })),
        delete: vi.fn(async () => ({ code: 0 })),
      },
      appTableRecord: {
        list: vi.fn(async () => ({ code: 0, data: { items: records } })),
        batchDelete,
        delete: vi.fn(async () => ({ code: 0 })),
      },
    },
  } as unknown as Lark.Client;

  return { batchDelete, client };
}

describe("feishu bitable create app cleanup", () => {
  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    createFeishuClientMock.mockReset();
  });

  it("deletes placeholder rows whose fields contain only default empty values", async () => {
    const { batchDelete, client } = createBitableClient([
      { record_id: "rec_missing_fields" },
      { record_id: "rec_empty_fields", fields: {} },
      {
        record_id: "rec_empty_defaults",
        fields: {
          Name: "",
          Status: [],
          Attachments: [],
          Started: null,
          EmptyObject: {},
        },
      },
      {
        record_id: "rec_empty_rich_text",
        fields: { Notes: [{ type: "text", text: "" }] },
      },
      {
        record_id: "rec_empty_nested",
        fields: { Notes: { value: "", segments: [{ type: "text", text: "" }] } },
      },
      { record_id: "rec_text", fields: { Name: "Milestone" } },
      { record_id: "rec_number", fields: { Estimate: 0 } },
      { record_id: "rec_boolean", fields: { Done: false } },
      { record_id: "rec_link", fields: { Link: { text: "", link: "https://example.com" } } },
      { record_id: "rec_attachment", fields: { Attachments: [{ file_token: "boxcn_token" }] } },
      { record_id: "rec_user", fields: { Assignee: [{ id: "ou_1", name: "" }] } },
      { record_id: "rec_location", fields: { Location: { name: "", location: "116,39" } } },
    ]);
    createFeishuClientMock.mockReturnValue(client);

    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuBitableTools(api);

    const result = await resolveTool("feishu_bitable_create_app").execute("call", {
      name: "Project Tracker",
    });

    expect(result.details.cleaned_placeholder_rows).toBe(5);
    expect(batchDelete).toHaveBeenCalledWith({
      path: { app_token: "app_token", table_id: "tbl_main" },
      data: {
        records: [
          "rec_missing_fields",
          "rec_empty_fields",
          "rec_empty_defaults",
          "rec_empty_rich_text",
          "rec_empty_nested",
        ],
      },
    });
  });
});
