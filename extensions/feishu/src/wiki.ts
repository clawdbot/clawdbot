// Feishu plugin module implements wiki behavior.
import type * as Lark from "@larksuiteoapi/node-sdk";
import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuToolClient, resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import { toolExecutionErrorResult, unknownToolActionResult } from "./tool-result.js";
import { FeishuWikiSchema, type FeishuWikiParams } from "./wiki-schema.js";

type ObjType = "doc" | "sheet" | "mindnote" | "bitable" | "file" | "docx" | "slides";

const WIKI_PAGE_SIZE = 50;

// ============ Actions ============

const WIKI_ACCESS_HINT =
  "To grant wiki access: Open wiki space → Settings → Members → Add the bot. " +
  "See: https://open.feishu.cn/document/server-docs/docs/wiki-v2/wiki-qa#a40ad4ca";

function requireWikiSpaceId(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(
      `${fieldName} must be a string. Feishu wiki space IDs are opaque identifiers; pass them quoted to avoid JavaScript number precision loss.`,
    );
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} must not be empty.`);
  }

  return trimmed;
}

function optionalWikiSpaceId(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return requireWikiSpaceId(value, fieldName);
}

function readWikiPageSize(params: Record<string, unknown>): number {
  return (
    readPositiveIntegerParam(params, "page_size", {
      max: WIKI_PAGE_SIZE,
      message: "page_size must be a positive integer between 1 and 50",
    }) ?? WIKI_PAGE_SIZE
  );
}

async function listSpaces(client: Lark.Client, pageSize: number, pageToken?: string) {
  const res = await client.wiki.space.list({
    params: { page_size: pageSize, page_token: pageToken },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const spaces =
    res.data?.items?.map((s) => ({
      space_id: s.space_id,
      name: s.name,
      description: s.description,
      visibility: s.visibility,
    })) ?? [];

  return {
    spaces,
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
    ...(spaces.length === 0 &&
      pageToken === undefined &&
      res.data?.has_more !== true && { hint: WIKI_ACCESS_HINT }),
  };
}

async function listNodes(
  client: Lark.Client,
  spaceId: string,
  parentNodeToken: string | undefined,
  pageSize: number,
  pageToken?: string,
) {
  const res = await client.wiki.spaceNode.list({
    path: { space_id: spaceId },
    params: {
      parent_node_token: parentNodeToken,
      page_size: pageSize,
      page_token: pageToken,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    nodes:
      res.data?.items?.map((n) => ({
        node_token: n.node_token,
        obj_token: n.obj_token,
        obj_type: n.obj_type,
        title: n.title,
        has_child: n.has_child,
      })) ?? [],
    has_more: res.data?.has_more ?? false,
    page_token: res.data?.page_token,
  };
}

async function getNode(client: Lark.Client, token: string) {
  const res = await client.wiki.space.getNode({
    params: { token },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const node = res.data?.node;
  return {
    node_token: node?.node_token,
    space_id: node?.space_id,
    obj_token: node?.obj_token,
    obj_type: node?.obj_type,
    title: node?.title,
    parent_node_token: node?.parent_node_token,
    has_child: node?.has_child,
    creator: node?.creator,
    create_time: node?.node_create_time,
  };
}

async function createNode(
  client: Lark.Client,
  spaceId: string,
  title: string,
  objType?: string,
  parentNodeToken?: string,
) {
  const res = await client.wiki.spaceNode.create({
    path: { space_id: spaceId },
    data: {
      obj_type: (objType as ObjType) || "docx",
      node_type: "origin" as const,
      title,
      parent_node_token: parentNodeToken,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  const node = res.data?.node;
  return {
    node_token: node?.node_token,
    obj_token: node?.obj_token,
    obj_type: node?.obj_type,
    title: node?.title,
  };
}

async function moveNode(
  client: Lark.Client,
  spaceId: string,
  nodeToken: string,
  targetSpaceId?: string,
  targetParentToken?: string,
) {
  const res = await client.wiki.spaceNode.move({
    path: { space_id: spaceId, node_token: nodeToken },
    data: {
      target_space_id: targetSpaceId || spaceId,
      target_parent_token: targetParentToken,
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    node_token: res.data?.node?.node_token,
  };
}

async function renameNode(client: Lark.Client, spaceId: string, nodeToken: string, title: string) {
  const res = await client.wiki.spaceNode.updateTitle({
    path: { space_id: spaceId, node_token: nodeToken },
    data: { title },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    success: true,
    node_token: nodeToken,
    title,
  };
}

// ============ Tool Registration ============

export function registerFeishuWikiTools(api: OpenClawPluginApi) {
  if (!api.config) {
    return;
  }

  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    return;
  }

  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  if (!toolsCfg.wiki) {
    return;
  }

  type FeishuWikiExecuteParams = FeishuWikiParams & { accountId?: string };

  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;
      return {
        name: "feishu_wiki",
        label: "Feishu Wiki",
        description:
          "Feishu knowledge base operations. Actions: spaces, nodes, get, create, move, rename",
        parameters: FeishuWikiSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuWikiExecuteParams;
          try {
            const createClient = () =>
              createFeishuToolClient({
                api,
                executeParams: p,
                defaultAccountId,
                requiredTool: { family: "wiki", label: "Wiki" },
              });
            switch (p.action) {
              case "spaces":
                return jsonResult(
                  await listSpaces(createClient(), readWikiPageSize(p), p.page_token),
                );
              case "nodes": {
                const spaceId = requireWikiSpaceId(p.space_id, "space_id");
                return jsonResult(
                  await listNodes(
                    createClient(),
                    spaceId,
                    p.parent_node_token,
                    readWikiPageSize(p),
                    p.page_token,
                  ),
                );
              }
              case "get":
                return jsonResult(await getNode(createClient(), p.token));
              case "search":
                optionalWikiSpaceId(p.space_id, "space_id");
                createClient();
                return jsonResult({
                  error:
                    "Search is not available. Use feishu_wiki with action: 'nodes' to browse or action: 'get' to lookup by token.",
                });
              case "create": {
                const spaceId = requireWikiSpaceId(p.space_id, "space_id");
                return jsonResult(
                  await createNode(
                    createClient(),
                    spaceId,
                    p.title,
                    p.obj_type,
                    p.parent_node_token,
                  ),
                );
              }
              case "move": {
                const spaceId = requireWikiSpaceId(p.space_id, "space_id");
                return jsonResult(
                  await moveNode(
                    createClient(),
                    spaceId,
                    p.node_token,
                    optionalWikiSpaceId(p.target_space_id, "target_space_id"),
                    p.target_parent_token,
                  ),
                );
              }
              case "rename": {
                const spaceId = requireWikiSpaceId(p.space_id, "space_id");
                return jsonResult(await renameNode(createClient(), spaceId, p.node_token, p.title));
              }
              default:
                return unknownToolActionResult((p as { action?: unknown }).action);
            }
          } catch (err) {
            return toolExecutionErrorResult(err);
          }
        },
      };
    },
    { name: "feishu_wiki" },
  );
}
