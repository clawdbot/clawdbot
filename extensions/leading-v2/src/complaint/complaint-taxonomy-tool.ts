import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { envelopeError } from "../client/envelope.js";
import { getJson, resolveConfig } from "../client/http-client.js";
import type { ApiKeyResolver } from "../client/key-resolver.js";
import { failure, resolveKeyOrError } from "../client/tool-helpers.js";

export function createComplaintTaxonomyToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
) {
  const config = resolveConfig(api.pluginConfig ?? {});
  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "complaint_taxonomy",
      label: "查询举报平台和分类",
      description:
        "只读查询当前举报分类目录，不提交任务。用户问支持哪些平台时不传 links；核对具体链接时传 links。必须查询后再回答，不得根据旧名单拒绝网易等平台。platforms 表示目录可用，具体链接以 taxonomies 和 unsupportedLinks 为准；接口失败或旧版缺少 platforms 不代表不支持。目录可用不保证举报执行、涉企投诉或下架成功。",
      parameters: Type.Object(
        {
          links: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 50 }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_id: string, params: Record<string, unknown>) {
        if (
          params.links !== undefined &&
          (!Array.isArray(params.links) ||
            params.links.length > 50 ||
            params.links.some(
              (link) => typeof link !== "string" || !link.trim() || link.length > 2048,
            ))
        ) {
          return jsonResult({
            success: false,
            error: "links 必须为最多50条非空链接的数组，每条不超过2048字符。",
          });
        }
        const links = params.links as string[] | undefined;
        const keyed = await resolveKeyOrError(api, resolver, userId, "complaint_taxonomy");
        if ("error" in keyed) {
          return keyed.error;
        }
        try {
          const result = await getJson(
            config,
            "/legal/fetch-complaint-taxonomy",
            links?.length ? { links } : {},
            keyed.apiKey,
          );
          const error = envelopeError(result);
          if (error) {
            return jsonResult({ success: false, error });
          }
          if (
            result.code !== "success" ||
            !Array.isArray(result.taxonomies) ||
            !Array.isArray(result.unsupportedLinks) ||
            (!links?.length && !Array.isArray(result.platforms))
          ) {
            return jsonResult({
              success: false,
              error:
                "分类接口未返回完整目录（可能尚未升级），当前无法判断支持范围。不要解释为平台不支持。",
            });
          }
          return jsonResult({
            success: true,
            ...(!links?.length ? { platforms: result.platforms } : {}),
            taxonomies: result.taxonomies,
            unsupportedLinks: result.unsupportedLinks,
          });
        } catch (error) {
          return failure(api, "complaint_taxonomy", userId, error);
        }
      },
    };
  };
}
