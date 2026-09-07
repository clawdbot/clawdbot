const BASE_EVIDENCE_TOOLS = [
  "complaint_taxonomy",
  "feed_list",
  "feed_query",
  "full_text_search",
  "hot_rank",
  "image",
  "memory_get",
  "memory_search",
  "opinion_analyze",
  "risk_judge",
  "session_status",
  "topic_list",
  "web_fetch",
  "web_search",
] as const;

const REPORT_TOOLS = [
  "chart_render",
  "exec",
  "file_share",
  "monthly_stats",
  "opinion_report_export",
  "process",
  "read",
  "sheet_report_create",
  "write",
] as const;

const COMPLAINT_TOOLS = [
  "complaint_submit",
  "complaint_task_status",
  "crawl_refresh_create",
  "crawl_refresh_list",
  "crawl_refresh_status",
  "file_share",
  "infringe_complaint_submit",
  "infringe_profile_list",
  "infringe_profile_save",
  "letter_fetch",
  "letter_generate",
  "opinion_content_create",
  "opinion_download_content",
  "opinion_download_list",
  "opinion_download_status",
  "read",
  "write",
] as const;

const LINK_CHECK_TOOLS = ["link_batch_create", "link_batch_list", "link_batch_status"] as const;

const SCHEDULE_TOOLS = [
  "schedule_create",
  "schedule_delete",
  "schedule_list",
  "schedule_toggle",
] as const;

const MEDIA_TOOLS = [
  "file_share",
  "image_generate",
  "music_generate",
  "video_generate",
  "video_link_parse",
  "video_understand",
] as const;
const VIDEO_EVIDENCE_TOOLS = ["video_link_parse", "video_understand"] as const;

const SKILL_TOOLS = ["skill_get", "skill_list", "skill_save"] as const;
const JOB_CONTROL_TOOLS = ["job_list", "job_stop", "report_status", "report_stop"] as const;
const EMAIL_TOOLS = ["file_share", "send_email"] as const;
const ATTACHMENT_TOOLS = ["exec", "file_share", "process", "read"] as const;
const COLLABORATION_DIAGNOSTIC_TOOLS = ["collaboration_history_query"] as const;

export type SuhengToolProfileOptions = {
  hasAttachments?: boolean;
  hasCustomSkills?: boolean;
  builtinSkillName?: string;
};

const REPORT_INTENT =
  /(?:报告|简报|快报|专报|日报|周报|月报|汇报材料|表格|图表|看板|可视化|Word|docx|WPS|Excel|PDF|PPT|HTML|文件|文档)/iu;
const COMPLAINT_INTENT = /(?:侵权|投诉|举报|维权|投诉函|投诉通知|主体档案|证件|盖章|下架|固证)/iu;
const LINK_CHECK_INTENT_PATTERNS = [
  /(?:失效|无效|死链|坏链).{0,8}(?:链接|网址|URL)/iu,
  /(?:链接|网址|URL).{0,20}(?:失效|无效|有效|可用|可访问|正常访问|能否打开|是否正常)/iu,
] as const;
const SCHEDULE_INTENT = /(?:定时|计划任务|提醒|每天|每周|每月|定期|周期|几点|定时任务)/iu;
const MEDIA_INTENT_PATTERNS = [
  /(?:生成|制作|解析|理解|分析|下载|研判|抓取).{0,16}(?:图片|海报|音乐|音频|视频|短视频)/iu,
  /(?:图片|海报|音乐|音频|视频|短视频).{0,16}(?:生成|制作|解析|理解|分析|下载|研判|抓取)/iu,
] as const;
const EXTERNAL_HTTP_LINK = /https?:\/\/[^\s]+/iu;
const LINK_EVIDENCE_INTENT = /(?:研判|分析|核查|核实|判断|评估|看看|查看|读取|理解)/iu;
// Keep the small catalog tool family available whenever skills are mentioned.
// Verb lists miss natural requests such as "放到我的 skill 中" and distant actions.
// ASCII boundaries support Chinese/English mixing without matching "skillful".
const SKILL_REFERENCE = /技能|(?<![a-z])skills?(?![a-z])/iu;
const JOB_CONTROL_INTENT = /(?:任务|报告).{0,12}(?:状态|进度|停止|取消|终止|列表)/iu;
const EMAIL_INTENT = /(?:发送|发|推送|寄送).{0,8}(?:邮件|邮箱)|(?:邮件|邮箱).{0,8}(?:发送|推送)/iu;
const DAILY_RISK_TIPS_INTENT = /(?:每日风险提示|风险提示选题|风险提示素材)/iu;
const FEED_REANALYZE_INTENT = /(?:重新|再次|批量).{0,8}(?:分析|研判|标注)/iu;

function addTools(target: Set<string>, tools: readonly string[]): void {
  for (const tool of tools) {
    target.add(tool);
  }
}

function addBuiltinSkillTools(target: Set<string>, builtinSkillName: string): boolean {
  switch (builtinSkillName) {
    case "ai-public-opinion-brief":
    case "gov-public-opinion-analysis-agent":
      addTools(target, REPORT_TOOLS);
      return true;
    case "infringement-judgment":
    case "institution-violation-judgment":
      addTools(target, COMPLAINT_TOOLS);
      addTools(target, LINK_CHECK_TOOLS);
      return true;
    case "ai-collaboration-diagnostic":
      addTools(target, COLLABORATION_DIAGNOSTIC_TOOLS);
      return true;
    default:
      return false;
  }
}

/**
 * Return the smallest practical toolset for a Suheng web turn.
 *
 * The result is sorted so identical intents produce byte-stable model payloads.
 * Custom and unknown bundled skills keep the runtime's full toolset because
 * their requirements cannot be inferred safely here.
 */
export function resolveSuhengToolsAllow(message: string): string[];
export function resolveSuhengToolsAllow(
  message: string,
  options: SuhengToolProfileOptions,
): string[] | undefined;
export function resolveSuhengToolsAllow(
  message: string,
  options: SuhengToolProfileOptions = {},
): string[] | undefined {
  if (options.hasCustomSkills) {
    return undefined;
  }

  const tools = new Set<string>(BASE_EVIDENCE_TOOLS);
  if (options.builtinSkillName && !addBuiltinSkillTools(tools, options.builtinSkillName)) {
    return undefined;
  }
  if (options.hasAttachments) {
    addTools(tools, ATTACHMENT_TOOLS);
  }
  if (REPORT_INTENT.test(message)) {
    addTools(tools, REPORT_TOOLS);
  }
  if (COMPLAINT_INTENT.test(message)) {
    addTools(tools, COMPLAINT_TOOLS);
    addTools(tools, LINK_CHECK_TOOLS);
  }
  if (LINK_CHECK_INTENT_PATTERNS.some((pattern) => pattern.test(message))) {
    addTools(tools, LINK_CHECK_TOOLS);
  }
  if (SCHEDULE_INTENT.test(message)) {
    addTools(tools, SCHEDULE_TOOLS);
  }
  if (MEDIA_INTENT_PATTERNS.some((pattern) => pattern.test(message))) {
    addTools(tools, MEDIA_TOOLS);
  }
  if (EXTERNAL_HTTP_LINK.test(message) && LINK_EVIDENCE_INTENT.test(message)) {
    addTools(tools, VIDEO_EVIDENCE_TOOLS);
  }
  if (SKILL_REFERENCE.test(message)) {
    addTools(tools, SKILL_TOOLS);
  }
  if (JOB_CONTROL_INTENT.test(message)) {
    addTools(tools, JOB_CONTROL_TOOLS);
  }
  if (EMAIL_INTENT.test(message)) {
    addTools(tools, EMAIL_TOOLS);
  }
  if (DAILY_RISK_TIPS_INTENT.test(message)) {
    tools.add("daily_risk_tips");
  }
  if (FEED_REANALYZE_INTENT.test(message)) {
    tools.add("feed_reanalyze");
  }
  return [...tools].toSorted();
}
