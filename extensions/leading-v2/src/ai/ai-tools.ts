import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { asString, envelopeError } from "../client/envelope.js";
import { type FieldValue, getJson, postForm, resolveConfig } from "../client/http-client.js";
import type { ApiKeyResolver } from "../client/key-resolver.js";
import { failure, resolveKeyOrError } from "../client/tool-helpers.js";
import type { BackendConfig } from "../client/types.js";
import {
  DEFAULT_WORKSPACE,
  JOB_STATUS_LABELS,
  LETTER_LABELS,
  resolveLatestJob,
  resolveLatestJobId,
  resolveLetterBasis,
} from "./job-basis.js";

const ListSchema = Type.Object(
  {
    q: Type.Optional(Type.String({ description: "Keyword over the task label." })),
    page: Type.Optional(Type.Number({ description: "Page number. Default 1." })),
    size: Type.Optional(Type.Number({ description: "Page size. Default 10." })),
  },
  { additionalProperties: false },
);

const LetterGenerateSchema = Type.Object(
  {
    supplement: Type.Optional(
      Type.String({
        description:
          "可选补充说明（例如要额外引用的法条），会附在检测结果之后。" +
          "违规事实一律取自该检测任务的检测结果，禁止在此自行编写违规事实。",
      }),
    ),
    all: Type.Optional(
      Type.Boolean({
        description:
          "生成全部三种文书（撤稿函/投诉通知/举报信）。默认由后端按任务类型选择。" +
          "官方公函/个人公函不是文书，不在此列。",
      }),
    ),
  },
  { additionalProperties: false },
);

const AGENT_JUDGMENT_SOURCE = "AgentJudgment";
const AGENT_JUDGMENT_MIN_LENGTH = 20;
const AGENT_JUDGMENT_MAX_LENGTH = 6000;

const DirectJudgmentProperties = {
  basisSource: Type.Optional(Type.Literal(AGENT_JUDGMENT_SOURCE)),
  confirmed: Type.Optional(
    Type.Boolean({ description: "仅在用户明确点击或选择举报/投诉后传 true。" }),
  ),
  subjectScope: Type.Optional(
    Type.Union([Type.Literal("Institution"), Type.Literal("Enterprise")], {
      description: "研判主体范围：Institution=非企业机构，Enterprise=企业或企业家。",
    }),
  ),
  judgment: Type.Optional(
    Type.String({
      description: "夙衡本轮研判形成的事实、规则与结论摘要，20至6000字。",
    }),
  ),
};

const ComplaintClassificationSchema = Type.Object(
  {
    link: Type.String({ description: "必须与 links 中的一条举报链接完全一致。" }),
    taxonomyVersionId: Type.Integer({ minimum: 1, description: "分类目录返回的版本 ID。" }),
    categoryCode: Type.String({ minLength: 1, description: "分类目录中的一级分类稳定代码。" }),
    subCategoryCode: Type.Optional(
      Type.String({ minLength: 1, description: "所选一级分类下的二级分类稳定代码。" }),
    ),
  },
  { additionalProperties: false },
);

type DirectJudgment = {
  source: typeof AGENT_JUDGMENT_SOURCE;
  subjectScope: "Institution" | "Enterprise";
  judgment: string;
};

type DirectJudgmentResult =
  | { code: "legacy" }
  | { code: "valid"; basis: DirectJudgment }
  | { code: "invalid"; error: string };

function resolveDirectJudgment(
  params: Record<string, unknown>,
  operation: "report" | "complaint",
): DirectJudgmentResult {
  if (params.basisSource === undefined) {
    return { code: "legacy" };
  }
  if (params.basisSource !== AGENT_JUDGMENT_SOURCE) {
    return { code: "invalid", error: "不支持的研判依据来源。" };
  }
  if (params.confirmed !== true) {
    return { code: "invalid", error: "请先让用户明确确认举报或投诉操作。" };
  }
  if (params.subjectScope !== "Institution" && params.subjectScope !== "Enterprise") {
    return { code: "invalid", error: "请提供正确的研判主体范围。" };
  }
  if (operation === "complaint" && params.subjectScope !== "Enterprise") {
    return { code: "invalid", error: "非企业主体不能投诉，请改用举报。" };
  }
  const judgment = asString(params.judgment)?.trim() ?? "";
  if (judgment.length < AGENT_JUDGMENT_MIN_LENGTH) {
    return { code: "invalid", error: "请提供完整的夙衡研判依据。" };
  }
  if (judgment.length > AGENT_JUDGMENT_MAX_LENGTH) {
    return { code: "invalid", error: "夙衡研判依据过长，请控制在6000字以内。" };
  }
  return {
    code: "valid",
    basis: { source: AGENT_JUDGMENT_SOURCE, subjectScope: params.subjectScope, judgment },
  };
}

const ComplaintSubmitSchema = Type.Object(
  {
    ...DirectJudgmentProperties,
    links: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "待举报的侵权链接。省略则复用最近一次内容检测任务提交的原始链接。" +
          "先用 complaint_taxonomy 查询当前链接分类，不得根据固定平台名单过滤链接。",
      }),
    ),
    role: Type.Optional(
      Type.Union([Type.Literal("Personal"), Type.Literal("Enterprise")], {
        description: "举报主体身份：Personal=个人，Enterprise=企业。默认 Personal。",
      }),
    ),
    classifications: Type.Optional(
      Type.Array(ComplaintClassificationSchema, {
        description:
          "逐链接的平台举报分类。直接使用夙衡研判时，首次省略本字段会返回当前分类目录；" +
          "根据研判为每条链接选择目录中的稳定代码后，使用相同参数再次调用。",
      }),
    ),
  },
  { additionalProperties: false },
);

const EmptySchema = Type.Object({}, { additionalProperties: false });

export function createJobListToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "job_list",
      label: "List 检测 Tasks",
      description:
        "List this account's 内容检测/AI tasks (most recent first). " +
        "Returns each task's label, status (处理中/已完成/已停止), rate and completion. Read-only.",
      parameters: ListSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "job_list");
        if ("error" in keyed) {
          return keyed.error;
        }
        const params: Record<string, FieldValue> = {
          workspace: DEFAULT_WORKSPACE,
          page: Math.max(1, Number(rawParams.page ?? 1) || 1),
          size: Math.min(50, Math.max(1, Number(rawParams.size ?? 10) || 10)),
          q: asString(rawParams.q),
        };
        let res: Record<string, unknown>;
        try {
          res = await getJson(config, "/ai/fetch-jobs", params, keyed.apiKey);
        } catch (error) {
          return failure(api, "job_list", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const jobs = Array.isArray(res.jobs) ? (res.jobs as Record<string, unknown>[]) : [];
        const list = jobs.map((job) => {
          const status = asString(job.status) ?? "";
          return {
            label: asString(job.label) ?? null,
            status,
            statusLabel: JOB_STATUS_LABELS[status] ?? status,
            rate: Number(job.rate ?? 0),
            completion: Number(job.completion ?? 0),
            date: asString(job.date) ?? null,
          };
        });
        return jsonResult({ success: true, total: Number(res.total ?? list.length), list });
      },
    };
  };
}

export function createJobStopToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "job_stop",
      label: "Stop 检测 Task",
      description:
        "Stop the most recent in-progress 内容检测 task for this account (refunds its credit). " +
        "Call with no arguments — it targets the latest task. Returns the stopped task's label.",
      parameters: EmptySchema,
      async execute(_toolCallId: string) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "job_stop");
        if ("error" in keyed) {
          return keyed.error;
        }
        let jobId: number | null;
        try {
          jobId = await resolveLatestJobId(config, keyed.apiKey);
        } catch (error) {
          return failure(api, "job_stop", userId, error);
        }
        if (!jobId) {
          return jsonResult({ success: false, error: "No recent task to stop." });
        }
        let res: Record<string, unknown>;
        try {
          res = await postForm(config, `/ai/stop-job/${jobId}`, {}, keyed.apiKey);
        } catch (error) {
          return failure(api, "job_stop", userId, error);
        }
        if (res.code !== "success") {
          return jsonResult({
            success: false,
            error: asString(res.message) ?? "Backend rejected the stop request.",
          });
        }
        const job = (res.job as Record<string, unknown> | undefined) ?? {};
        return jsonResult({ success: true, label: asString(job.label) ?? null });
      },
    };
  };
}

export function createLetterGenerateToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "letter_generate",
      label: "Generate 维权文书",
      description:
        "为最近一次内容检测任务生成「维权文书」——只有三种：撤稿函、投诉通知、举报信。" +
        "违规事实自动取自该检测任务的检测结果（与网页端「一键生成所需函件」同源），不需要也不允许自行编写；" +
        "检测任务尚未完成、或检测结果里没有违规事实时，本工具会直接拒绝——此时应告知用户等检测完成，不要编造违规事实。" +
        "异步执行——生成完毕后用 letter_fetch 取回。" +
        "注意：官方公函/个人公函不是文书，它们分别对应投诉(infringe_complaint_submit)与举报(complaint_submit)功能。",
      parameters: LetterGenerateSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "letter_generate");
        if ("error" in keyed) {
          return keyed.error;
        }
        // 前置闸门：检测必须已完成，且检测结果里确有违规事实（errors 由此而来）。
        let basis: Awaited<ReturnType<typeof resolveLetterBasis>>;
        try {
          basis = await resolveLetterBasis(config, keyed.apiKey);
        } catch (error) {
          return failure(api, "letter_generate", userId, error);
        }
        if (!basis.ok) {
          return jsonResult({ success: false, error: basis.error });
        }
        const supplement = asString(rawParams.supplement);
        const errors = supplement ? `${basis.errors}\n${supplement}` : basis.errors;
        const fields: Record<string, FieldValue> = {
          errors,
          jobId: basis.jobId,
          siteId: config.siteId,
          all: rawParams.all ? 1 : undefined,
        };
        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/ai/generate-letter", fields, keyed.apiKey);
        } catch (error) {
          return failure(api, "letter_generate", userId, error);
        }
        if (res.code !== "success") {
          // e.g. "文章违规程度较低，无法生成撤稿函"
          return jsonResult({
            success: false,
            error: asString(res.message) ?? "Backend rejected the request.",
          });
        }
        return jsonResult({
          success: true,
          submitted: true,
          message: asString(res.message) ?? "正在生成，请稍等！",
          agentInstruction:
            "维权文书生成任务已提交。请立刻告知用户文书正在后台生成，稍后可询问我取回文书。不要调用任何工具——等用户主动询问时再用 letter_fetch 获取。",
        });
      },
    };
  };
}

export function createLetterFetchToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "letter_fetch",
      label: "Fetch 维权文书",
      description:
        "取回最近一次内容检测任务已生成的「维权文书」（撤稿函/投诉通知/举报信三种，只返回已有正文的）。无需参数。" +
        "⚠️ SINGLE-USE PER TURN: call EXACTLY ONCE, then immediately reply to the user. " +
        "If count is 0, tell the user generation is still running and STOP — never call again in the same turn.",
      parameters: EmptySchema,
      async execute(_toolCallId: string) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "letter_fetch");
        if ("error" in keyed) {
          return keyed.error;
        }
        let jobId: number | null;
        try {
          jobId = await resolveLatestJobId(config, keyed.apiKey);
        } catch (error) {
          return failure(api, "letter_fetch", userId, error);
        }
        if (!jobId) {
          return jsonResult({
            success: false,
            error: "No recent 内容检测 task to fetch letters for.",
          });
        }
        let res: Record<string, unknown>;
        try {
          res = await postForm(
            config,
            "/ai/fetch-letters",
            { jobId, siteId: config.siteId },
            keyed.apiKey,
          );
        } catch (error) {
          return failure(api, "letter_fetch", userId, error);
        }
        const envErr = envelopeError(res);
        if (envErr) {
          return jsonResult({ success: false, error: envErr });
        }
        const map = res.letterMap;
        const entries =
          map && typeof map === "object" && !Array.isArray(map)
            ? Object.entries(map as Record<string, unknown>)
            : [];
        // 只认三种文书；GovOfficial/GovPersonal 属于投诉/举报功能，不是文书。
        // 正文为空的条目说明后端还在生成，等同于「未就绪」，不计入 count。
        const letters = entries
          .filter(([category]) => category in LETTER_LABELS)
          .map(([category, value]) => {
            const v = (value as Record<string, unknown>) ?? {};
            return {
              category,
              categoryLabel: LETTER_LABELS[category],
              content: asString(v.content) ?? null,
            };
          })
          .filter((letter) => letter.content);
        return jsonResult({
          success: true,
          count: letters.length,
          letters,
          agentInstruction:
            letters.length > 0
              ? "文书已生成，请向用户展示结果。"
              : "⚠️ 文书仍在生成中。请立刻告知用户「文书正在生成，稍后可再询问」并结束本轮对话。禁止再次调用此工具。",
        });
      },
    };
  };
}

export function createComplaintSubmitToolFactory(api: OpenClawPluginApi, resolver: ApiKeyResolver) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "complaint_submit",
      label: "一键举报",
      description:
        "一键举报：可直接使用夙衡本轮研判，或兼容复用最近一次内容检测任务。" +
        "直接使用研判时传 basisSource=AgentJudgment、confirmed=true、subjectScope、judgment 和 links，不要创建或查询内容检测任务。" +
        "直接研判首次调用不要猜分类、不要传 classifications；工具会返回当前平台分类目录，按研判选择稳定代码后立即用原参数再次调用，不要再次询问用户。" +
        "默认复用检测任务提交的原始链接；如需举报其他链接可传 links。" +
        "支持范围动态变化；查询 complaint_taxonomy 获取当前平台和逐链接分类，不得凭旧名单拒绝。" +
        "异步执行——提交成功后告知用户「举报任务已提交」，无需再调用任何工具。",
      parameters: ComplaintSubmitSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "complaint_submit");
        if ("error" in keyed) {
          return keyed.error;
        }
        const direct = resolveDirectJudgment(rawParams, "report");
        if (direct.code === "invalid") {
          return jsonResult({ success: false, error: direct.error });
        }
        let job: Record<string, unknown> | null = null;
        let jobId = 0;
        if (direct.code === "legacy") {
          try {
            job = await resolveLatestJob(config, keyed.apiKey);
          } catch (error) {
            return failure(api, "complaint_submit", userId, error);
          }
          jobId = Number(job?.id);
          if (!Number.isInteger(jobId) || jobId <= 0) {
            return jsonResult({
              success: false,
              error: "没有可举报的内容检测任务；请先完成一次侵权检测。",
            });
          }
        }

        // Reuse the detection task's own link unless the caller overrides with explicit links.
        const provided = Array.isArray(rawParams.links)
          ? (rawParams.links as unknown[]).map((v) => asString(v) ?? "").filter((v) => v.length > 0)
          : [];
        const jobLink = asString(job?.link);
        const links = provided.length > 0 ? provided : jobLink ? [jobLink] : [];
        if (links.length === 0) {
          return jsonResult({
            success: false,
            error:
              direct.code === "valid"
                ? "直接使用夙衡研判举报时必须提供 links。"
                : "未找到可举报的链接（该检测任务可能是纯文本/上传，没有原始链接）。请提供 links。",
          });
        }

        const classifications = Array.isArray(rawParams.classifications)
          ? rawParams.classifications.filter((item): item is Record<string, unknown> =>
              Boolean(item && typeof item === "object"),
            )
          : [];
        if (direct.code === "valid") {
          const classifiedLinks = new Set(
            classifications.map((item) => asString(item.link)).filter((link) => Boolean(link)),
          );
          const missingLinks = links.filter((link) => !classifiedLinks.has(link));
          if (missingLinks.length > 0) {
            let taxonomyResponse: Record<string, unknown>;
            try {
              taxonomyResponse = await getJson(
                config,
                "/legal/fetch-complaint-taxonomy",
                { links: missingLinks },
                keyed.apiKey,
              );
            } catch (error) {
              return failure(api, "complaint_submit", userId, error);
            }
            const taxonomyError = envelopeError(taxonomyResponse);
            if (
              taxonomyError ||
              taxonomyResponse.code !== "success" ||
              !Array.isArray(taxonomyResponse.taxonomies)
            ) {
              return jsonResult({
                success: false,
                error:
                  taxonomyError ??
                  "分类目录查询未成功，暂时无法判断支持范围；请重试，不要将查询失败解释为平台不支持。",
              });
            }
            const taxonomies = taxonomyResponse.taxonomies;
            const catalogLinks = new Set(
              taxonomies
                .map((item) =>
                  item && typeof item === "object"
                    ? asString((item as Record<string, unknown>).link)
                    : undefined,
                )
                .filter((link): link is string => Boolean(link)),
            );
            const unavailableLinks = Array.from(
              new Set(missingLinks.filter((link) => !catalogLinks.has(link))),
            );
            if (unavailableLinks.length > 0) {
              return jsonResult({
                success: false,
                classificationRequired: false,
                unsupportedLinks: unavailableLinks,
                error:
                  "部分链接没有当前已发布且允许自动选择的举报分类目录，已停止提交，避免生成空分类举报记录。",
              });
            }
            return jsonResult({
              success: false,
              classificationRequired: true,
              retryable: true,
              missingLinks,
              taxonomies,
              unsupportedLinks: Array.isArray(taxonomyResponse.unsupportedLinks)
                ? taxonomyResponse.unsupportedLinks
                : [],
              instruction:
                "请根据夙衡研判为每条链接选择 taxonomyVersionId、categoryCode 和适用的 subCategoryCode，然后用原参数及 classifications 再次调用 complaint_submit；不要再次询问用户。",
            });
          }
        }

        const role =
          direct.code === "valid"
            ? direct.basis.subjectScope === "Enterprise"
              ? "Enterprise"
              : "Personal"
            : rawParams.role === "Enterprise"
              ? "Enterprise"
              : "Personal";
        const fields: Record<string, FieldValue> = {
          id: jobId,
          links: JSON.stringify(links),
          role,
        };
        if (direct.code === "valid") {
          fields.basisSource = direct.basis.source;
          fields.confirmed = 1;
          fields.subjectScope = direct.basis.subjectScope;
          fields.judgment = direct.basis.judgment;
          fields.classifications = JSON.stringify(classifications);
        }
        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/legal/save-complaint-job", fields, keyed.apiKey);
        } catch (error) {
          return failure(api, "complaint_submit", userId, error);
        }
        if (res.code !== "success") {
          // e.g. "一键举报功能当前暂不支持您提供的链接"
          return jsonResult({
            success: false,
            error: asString(res.message) ?? "后端拒绝了举报请求。",
          });
        }
        return jsonResult({
          success: true,
          submitted: true,
          message: asString(res.message) ?? "举报任务已提交，请耐心等待",
          agentInstruction:
            "举报任务已提交。请立刻告知用户举报已在后台提交、系统会持续监测被举报链接是否下架。不要再调用任何工具。",
        });
      },
    };
  };
}

/* ============================================================
 * 侵权投诉（投诉方案）— 与「举报」(complaint_submit) 平级
 * 后端 InfringeComplaintController → /infringe-complaint/*
 * 举报走 legal_complaint + AutoComment；投诉走 legal_infringe_task/complaint
 * + AutoComplaint，前置更重：需主体档案 profileId + 盖章投诉函 stampedComplaint。
 * ============================================================ */

/** 与后端 InfringeComplaintController::INFRINGE_TYPES 对齐。 */
const INFRINGE_TYPES = ["Reputation", "Goodwill", "Portrait", "Privacy", "Name", "Other"] as const;

const INFRINGE_TYPE_LABELS: Record<string, string> = {
  Reputation: "名誉权",
  Goodwill: "商誉",
  Portrait: "肖像权",
  Privacy: "隐私权",
  Name: "姓名权/名称权",
  Other: "其他",
};

const SUBJECT_TYPE_LABELS: Record<string, string> = {
  Personal: "个人",
  Enterprise: "企业",
};

const InfringeProfileListSchema = Type.Object(
  {
    q: Type.Optional(Type.String({ description: "按档案标签或主体名称关键字过滤。" })),
  },
  { additionalProperties: false },
);

const InfringeComplaintSubmitSchema = Type.Object(
  {
    ...DirectJudgmentProperties,
    profileId: Type.Optional(
      Type.Number({
        description:
          "投诉主体档案 id（用 infringe_profile_list 获取）。省略时：账号仅 1 个档案则自动选用，多个档案则要求指定。",
      }),
    ),
    stampedComplaint: Type.Optional(
      Type.String({
        description:
          "盖章《投诉通知书》的 OSS object key 或可访问的 OSS URL（投诉前置，必需）。" +
          "优先使用聊天附件注入的 ossKey/ossUrl；旧消息只有 workspace 路径时，先用 file_share 上传并使用其返回 URL。",
      }),
    ),
    links: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "待投诉的侵权链接。省略则复用最近一次内容检测任务提交的原始链接。" +
          "不要根据固定名单过滤链接；涉企投诉适用范围以本接口实际校验为准。",
      }),
    ),
    infringeType: Type.Optional(
      Type.Union(
        [
          Type.Literal("Reputation"),
          Type.Literal("Goodwill"),
          Type.Literal("Portrait"),
          Type.Literal("Privacy"),
          Type.Literal("Name"),
          Type.Literal("Other"),
        ],
        {
          description:
            "侵权类型：Reputation=名誉权，Goodwill=商誉，Portrait=肖像权，Privacy=隐私权，Name=姓名权/名称权，Other=其他。默认 Reputation。",
        },
      ),
    ),
    rightsStatement: Type.Optional(
      Type.String({ description: "权利声明（权利人身份与权属说明）。" }),
    ),
    demand: Type.Optional(Type.String({ description: "投诉诉求（如：删除/下架/断开链接）。" })),
    factReason: Type.Optional(Type.String({ description: "事实与理由（侵权事实的具体陈述）。" })),
    agentId: Type.Optional(
      Type.Number({
        description:
          "代理人档案 id（代理投诉时用）。代理投诉要求该主体档案已上传授权委托书，否则后端会拒绝。",
      }),
    ),
  },
  { additionalProperties: false },
);

/** Map a raw 主体档案 row to a compact, content-safe summary for the agent. */
function summarizeProfile(profile: Record<string, unknown>) {
  const subjectType = asString(profile.subjectType) ?? "";
  const infringeType = asString(profile.defaultInfringeType) ?? "";
  return {
    id: Number(profile.id) || null,
    label: asString(profile.label) ?? null,
    name: asString(profile.name) ?? null,
    subjectType,
    subjectTypeLabel: SUBJECT_TYPE_LABELS[subjectType] ?? subjectType,
    defaultInfringeType: infringeType,
    defaultInfringeTypeLabel: INFRINGE_TYPE_LABELS[infringeType] ?? infringeType,
    // 是否已传授权委托书（代理投诉前置）。只回布尔，不外泄 OSS key。
    hasPowerOfAttorney: Boolean(asString(profile.powerOfAttorney)),
    contactName: asString(profile.contactName) ?? null,
    contactEmail: asString(profile.contactEmail) ?? null,
  };
}

/** Fetch this account's active 主体档案 rows (投诉主体资料库). */
async function fetchInfringeProfiles(
  config: BackendConfig,
  apiKey: string,
  q?: string,
): Promise<Record<string, unknown>[]> {
  const res = await getJson(config, "/infringe-complaint/fetch-profiles", { q }, apiKey);
  return Array.isArray(res.list) ? (res.list as Record<string, unknown>[]) : [];
}

export function createInfringeProfileListToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "infringe_profile_list",
      label: "投诉主体档案",
      description:
        "列出当前账号可用的「投诉主体资料库」档案（个人/企业资质档案），供 infringe_complaint_submit 选择 profileId。" +
        "返回每个档案的 id、标签、主体名称、主体类型、默认侵权类型，以及是否已上传授权委托书（代理投诉前置）。只读。",
      parameters: InfringeProfileListSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "infringe_profile_list");
        if ("error" in keyed) {
          return keyed.error;
        }
        let profiles: Record<string, unknown>[];
        try {
          profiles = await fetchInfringeProfiles(config, keyed.apiKey, asString(rawParams.q));
        } catch (error) {
          return failure(api, "infringe_profile_list", userId, error);
        }
        return jsonResult({
          success: true,
          total: profiles.length,
          list: profiles.map(summarizeProfile),
        });
      },
    };
  };
}

export function createInfringeComplaintSubmitToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "infringe_complaint_submit",
      label: "一键投诉",
      description:
        "发起涉企侵权投诉：可直接使用夙衡本轮研判，或兼容复用最近一次内容检测任务。" +
        "直接使用研判时传 basisSource=AgentJudgment、confirmed=true、subjectScope=Enterprise、judgment 和 links，不要创建或查询内容检测任务。" +
        "两个前置：① 投诉主体档案 profileId（用 infringe_profile_list 获取；仅 1 个档案时自动选用）；② 盖章《投诉通知书》 stampedComplaint（OSS key 或 URL）。" +
        "聊天附件已提供 ossKey/ossUrl 时直接使用；只有 workspace 路径时先调用 file_share。缺任一前置会返回提示，请照提示引导用户补齐。" +
        "默认复用检测任务提交的原始链接；如需投诉其他链接可传 links。" +
        "平台适用范围以本接口实际校验为准，不得凭旧名单拒绝；complaint_taxonomy 的举报目录不等于涉企投诉的执行能力。" +
        "异步执行——提交成功后告知用户「投诉任务已提交」，无需再调用任何工具。",
      parameters: InfringeComplaintSubmitSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "infringe_complaint_submit");
        if ("error" in keyed) {
          return keyed.error;
        }
        const direct = resolveDirectJudgment(rawParams, "complaint");
        if (direct.code === "invalid") {
          return jsonResult({ success: false, error: direct.error });
        }

        // 前置①：主体档案。显式传入优先；否则自动解析（唯一则用，多个则请用户指定）。
        let profileId = Number(rawParams.profileId);
        if (!Number.isInteger(profileId) || profileId <= 0) {
          let profiles: Record<string, unknown>[];
          try {
            profiles = await fetchInfringeProfiles(config, keyed.apiKey);
          } catch (error) {
            return failure(api, "infringe_complaint_submit", userId, error);
          }
          if (profiles.length === 0) {
            return jsonResult({
              success: false,
              error:
                "尚无投诉主体档案。请先用 infringe_profile_save 采集用户主体信息（个人/企业名称、证件号、联系方式等）创建档案；" +
                "身份证/营业执照/公章/委托书等证件可由用户直接上传为聊天附件，并把附件携带的 ossKey 填入对应字段。建好档案后再发起投诉。",
            });
          }
          if (profiles.length > 1) {
            return jsonResult({
              success: false,
              error: "存在多个投诉主体档案，请指定 profileId 后重试。",
              profiles: profiles.map(summarizeProfile),
            });
          }
          profileId = Number(profiles[0].id);
        }

        // 前置②：盖章投诉函（后端硬门槛）。此处先行拦截，给出可操作提示，避免空跑后端。
        const stampedComplaint = asString(rawParams.stampedComplaint);
        if (!stampedComplaint) {
          return jsonResult({
            success: false,
            error:
              "缺少「盖章投诉函」。请让用户直接在聊天中上传已盖章《投诉通知书》PDF；" +
              "附件带有 ossKey/ossUrl 时，将该 OSS key 或 URL 作为 stampedComplaint。" +
              "若当前仅有 workspace 文件路径，先调用 file_share 上传并使用其返回 URL，然后重试提交。",
          });
        }

        // 复用最近检测任务的原始链接与 jobId（与举报一致；jobId 供引擎带出研判证据）。
        let job: Record<string, unknown> | null = null;
        if (direct.code === "legacy") {
          try {
            job = await resolveLatestJob(config, keyed.apiKey);
          } catch (error) {
            return failure(api, "infringe_complaint_submit", userId, error);
          }
        }
        const provided = Array.isArray(rawParams.links)
          ? (rawParams.links as unknown[]).map((v) => asString(v) ?? "").filter((v) => v.length > 0)
          : [];
        const jobLink = asString(job?.link);
        const links = provided.length > 0 ? provided : jobLink ? [jobLink] : [];
        if (links.length === 0) {
          return jsonResult({
            success: false,
            error:
              direct.code === "valid"
                ? "直接使用夙衡研判投诉时必须提供 links。"
                : "未找到可投诉的链接（该检测任务可能是纯文本/上传，没有原始链接）。请提供 links。",
          });
        }

        const infringeType =
          typeof rawParams.infringeType === "string" &&
          (INFRINGE_TYPES as readonly string[]).includes(rawParams.infringeType)
            ? rawParams.infringeType
            : "Reputation";

        const fields: Record<string, FieldValue> = {
          profileId,
          infringeType,
          links: JSON.stringify(links),
          stampedComplaint,
          rightsStatement: asString(rawParams.rightsStatement),
          demand: asString(rawParams.demand),
          factReason: asString(rawParams.factReason),
        };
        const agentId = Number(rawParams.agentId);
        if (Number.isInteger(agentId) && agentId > 0) {
          fields.agentId = agentId;
        }
        const jobId = Number(job?.id);
        if (Number.isInteger(jobId) && jobId > 0) {
          fields.jobId = jobId;
        } else {
          fields.jobId = 0;
        }
        if (direct.code === "valid") {
          fields.basisSource = direct.basis.source;
          fields.confirmed = 1;
          fields.subjectScope = direct.basis.subjectScope;
          fields.judgment = direct.basis.judgment;
          fields.factReason = direct.basis.judgment;
        }

        let res: Record<string, unknown>;
        try {
          res = await postForm(
            config,
            "/infringe-complaint/save-complaint-job",
            fields,
            keyed.apiKey,
          );
        } catch (error) {
          return failure(api, "infringe_complaint_submit", userId, error);
        }
        if (res.code !== "success") {
          // 后端门槛（代理投诉缺委托书、平台不支持、档案无权限等）直接回传
          const backendMessage = asString(res.message) ?? "后端拒绝了投诉请求。";
          const error =
            Number.isInteger(agentId) &&
            agentId > 0 &&
            backendMessage.includes("代理人档案不存在或无权限")
              ? "代理人档案不可用：请确认该档案属于当前账号，并已补齐代理人身份证明；" +
                "同时确认投诉主体档案已上传授权委托书。" +
                `后端原始提示：${backendMessage}`
              : backendMessage;
          return jsonResult({
            success: false,
            error,
          });
        }
        return jsonResult({
          success: true,
          submitted: true,
          taskId: Number(res.taskId) || null,
          count: Number(res.count) || 0,
          message: asString(res.message) ?? "投诉任务已提交，请耐心等待",
          agentInstruction:
            "投诉任务已提交。请立刻告知用户投诉已在后台提交、系统会持续监测被投诉链接是否下架。不要再调用任何工具。",
        });
      },
    };
  };
}

const SUBJECT_TYPES = ["Personal", "Enterprise"] as const;

/** 主体档案上的「证件单件」列（聊天附件携带的 OSS object key）。 */
const PROFILE_DOC_KEYS = [
  "idCardFront",
  "idCardBack",
  "idCardHold",
  "businessLicense",
  "powerOfAttorney",
  "sealImage",
] as const;

const InfringeProfileSaveSchema = Type.Object(
  {
    profileId: Type.Optional(
      Type.Number({ description: "要更新的档案 id；省略则新建。更新须为本人/同组档案。" }),
    ),
    subjectType: Type.Union([Type.Literal("Personal"), Type.Literal("Enterprise")], {
      description: "主体类型：Personal=个人，Enterprise=企业。必填。",
    }),
    name: Type.String({ description: "主体名称（个人姓名 / 企业全称）。必填。" }),
    label: Type.Optional(Type.String({ description: "档案标签（便于识别）；省略则用 name。" })),
    idType: Type.Optional(Type.String({ description: "证件类型，如 身份证 / 统一社会信用代码。" })),
    idNumber: Type.Optional(Type.String({ description: "证件号码（身份证号 / 社会信用代码）。" })),
    address: Type.Optional(Type.String({ description: "联系地址。" })),
    contactName: Type.Optional(Type.String({ description: "联系人姓名。" })),
    contactPhone: Type.Optional(Type.String({ description: "联系电话。" })),
    contactEmail: Type.Optional(Type.String({ description: "联系邮箱（邮件渠道投诉会用到）。" })),
    legalRepName: Type.Optional(Type.String({ description: "企业法定代表人姓名（企业主体填）。" })),
    defaultInfringeType: Type.Optional(
      Type.Union(
        [
          Type.Literal("Reputation"),
          Type.Literal("Goodwill"),
          Type.Literal("Portrait"),
          Type.Literal("Privacy"),
          Type.Literal("Name"),
          Type.Literal("Other"),
        ],
        { description: "默认侵权类型，见 infringe_complaint_submit。默认 Reputation。" },
      ),
    ),
    memo: Type.Optional(Type.String({ description: "备注。" })),
    idCardFront: Type.Optional(
      Type.String({ description: "身份证正面 OSS object key（可从聊天附件 ossKey 取得）。" }),
    ),
    idCardBack: Type.Optional(Type.String({ description: "身份证反面 OSS object key。" })),
    idCardHold: Type.Optional(Type.String({ description: "手持身份证 OSS object key。" })),
    businessLicense: Type.Optional(
      Type.String({ description: "营业执照 OSS object key（企业主体）。" }),
    ),
    powerOfAttorney: Type.Optional(
      Type.String({ description: "授权委托书 OSS object key（代理投诉前置）。" }),
    ),
    sealImage: Type.Optional(Type.String({ description: "公章 OSS object key（企业主体）。" })),
  },
  { additionalProperties: false },
);

/** 按主体类型列出「引擎实际投诉仍需补齐」的证件（当前档案为空的那些）。 */
function profileMissingDocs(subjectType: string, fields: Record<string, FieldValue>): string[] {
  const missing: string[] = [];
  if (subjectType === "Enterprise") {
    if (!fields.businessLicense) {
      missing.push("营业执照");
    }
    if (!fields.sealImage) {
      missing.push("公章");
    }
  } else {
    if (!fields.idCardFront) {
      missing.push("身份证正面");
    }
    if (!fields.idCardBack) {
      missing.push("身份证反面");
    }
  }
  return missing;
}

export function createInfringeProfileSaveToolFactory(
  api: OpenClawPluginApi,
  resolver: ApiKeyResolver,
) {
  const config: BackendConfig = resolveConfig(api.pluginConfig ?? {});

  return (ctx: { agentId?: string }) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "infringe_profile_save",
      label: "建档投诉主体",
      description:
        "新建或更新「投诉主体资料库」档案（个人/企业资质），供 infringe_complaint_submit 使用。" +
        "把用户口述的主体信息（名称、证件类型/号码、联系人/电话/邮箱、企业法定代表人等）落成一条档案并返回 profileId——" +
        "无需再让用户去网页端从零建档。" +
        "身份证/营业执照/公章/委托书等证件字段使用聊天附件携带的 OSS object key；" +
        "缺这些证件时仍会建档成功，并在 missingDocs 里列出引擎实际投诉前需要用户继续作为聊天附件补充的证件。",
      parameters: InfringeProfileSaveSchema,
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const keyed = await resolveKeyOrError(api, resolver, userId, "infringe_profile_save");
        if ("error" in keyed) {
          return keyed.error;
        }

        const subjectType =
          typeof rawParams.subjectType === "string" &&
          (SUBJECT_TYPES as readonly string[]).includes(rawParams.subjectType)
            ? rawParams.subjectType
            : "";
        if (!subjectType) {
          return jsonResult({
            success: false,
            error: "请指定主体类型 subjectType（Personal/Enterprise）。",
          });
        }
        const name = asString(rawParams.name);
        if (!name) {
          return jsonResult({ success: false, error: "请提供主体名称 name。" });
        }

        const infringeType =
          typeof rawParams.defaultInfringeType === "string" &&
          (INFRINGE_TYPES as readonly string[]).includes(rawParams.defaultInfringeType)
            ? rawParams.defaultInfringeType
            : "Reputation";

        const fields: Record<string, FieldValue> = {
          subjectType,
          name,
          label: asString(rawParams.label),
          idType: asString(rawParams.idType),
          idNumber: asString(rawParams.idNumber),
          address: asString(rawParams.address),
          contactName: asString(rawParams.contactName),
          contactPhone: asString(rawParams.contactPhone),
          contactEmail: asString(rawParams.contactEmail),
          legalRepName: asString(rawParams.legalRepName),
          defaultInfringeType: infringeType,
          memo: asString(rawParams.memo),
        };
        for (const key of PROFILE_DOC_KEYS) {
          fields[key] = asString(rawParams[key]);
        }
        const profileId = Number(rawParams.profileId);
        if (Number.isInteger(profileId) && profileId > 0) {
          fields.id = profileId;
        }

        let res: Record<string, unknown>;
        try {
          res = await postForm(config, "/infringe-complaint/save-profile", fields, keyed.apiKey);
        } catch (error) {
          return failure(api, "infringe_profile_save", userId, error);
        }
        if (res.code !== "success") {
          return jsonResult({
            success: false,
            error: asString(res.message) ?? "后端拒绝了建档请求。",
          });
        }
        const missingDocs = profileMissingDocs(subjectType, fields);
        return jsonResult({
          success: true,
          profileId: Number(res.id) || profileId || null,
          missingDocs,
          message: asString(res.message) ?? "档案已保存",
          agentInstruction:
            missingDocs.length > 0
              ? `档案已建好，但引擎实际投诉前仍缺：${missingDocs.join("、")}。请让用户直接作为聊天附件补充，识别后把附件的 ossKey 写入档案；盖章《投诉通知书》PDF 也可直接在聊天中上传并提交其 ossKey/ossUrl。`
              : "档案已建好，可用于发起投诉。盖章《投诉通知书》PDF 可直接在聊天中上传，并用附件的 ossKey/ossUrl 提交。",
        });
      },
    };
  };
}
