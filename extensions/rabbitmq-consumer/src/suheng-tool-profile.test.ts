import { describe, expect, it } from "vitest";
import { resolveSuhengToolsAllow } from "./suheng-tool-profile.js";

describe("resolveSuhengToolsAllow", () => {
  it("keeps ordinary monitoring turns on a compact evidence toolset", () => {
    const tools = resolveSuhengToolsAllow("查询今天有哪些高风险舆情");

    expect(tools).toEqual(tools.toSorted());
    expect(tools).toEqual(
      expect.arrayContaining(["feed_query", "full_text_search", "risk_judge", "web_search"]),
    );
    expect(tools).not.toContain("schedule_create");
    expect(tools).not.toContain("infringe_complaint_submit");
    expect(tools).not.toContain("video_generate");
  });

  it("adds report and artifact tools only for report creation", () => {
    const tools = resolveSuhengToolsAllow("生成本月舆情报告和可视化图表");

    expect(tools).toEqual(
      expect.arrayContaining([
        "chart_render",
        "file_share",
        "monthly_stats",
        "read",
        "sheet_report_create",
        "write",
      ]),
    );
    expect(tools).not.toContain("music_generate");
  });

  it.each(["以docx版发给我", "这个文件打不开，你给我普通WORD版", "给我WPS版"])(
    "keeps generation and delivery tools available for Word requests: %s",
    (message) => {
      const tools = resolveSuhengToolsAllow(message);
      expect(tools).toEqual(
        expect.arrayContaining(["exec", "process", "read", "write", "file_share"]),
      );
      expect(tools).toEqual(tools.toSorted());
    },
  );

  it("adds only the relevant transactional family for complaint work", () => {
    const tools = resolveSuhengToolsAllow("请研判这些链接并提交侵权投诉");

    expect(tools).toEqual(
      expect.arrayContaining([
        "complaint_task_status",
        "infringe_complaint_submit",
        "infringe_profile_list",
        "letter_generate",
        "link_batch_create",
      ]),
    );
    expect(tools).not.toContain("schedule_create");
  });

  it.each([
    "请批量检测以下链接是否失效。\n任务名：晚间巡检\n链接（每行一个）：\nhttps://example.com/a\nhttps://example.com/b",
    "帮我检查这些网址能否正常访问",
    "创建一个失效链接监测任务",
    "这些链接有没有失效",
    "批量检查失效的链接",
  ])("adds dedicated link-check tools for %s", (message) => {
    const tools = resolveSuhengToolsAllow(message);

    expect(tools).toEqual(
      expect.arrayContaining(["link_batch_create", "link_batch_list", "link_batch_status"]),
    );
    expect(tools).not.toContain("complaint_submit");
    expect(tools).not.toContain("infringe_complaint_submit");
  });

  it("does not treat ordinary link-content reading as a dead-link check", () => {
    const tools = resolveSuhengToolsAllow("请读取这个链接讲了什么：https://example.com/news");

    expect(tools).not.toContain("link_batch_create");
    expect(tools).not.toContain("link_batch_status");
  });

  it("preserves link-check tools for the bundled infringement workflow", () => {
    const tools = resolveSuhengToolsAllow("执行流程", {
      builtinSkillName: "infringement-judgment",
    });

    expect(tools).toEqual(
      expect.arrayContaining(["infringe_complaint_submit", "link_batch_create"]),
    );
  });

  it("adds schedule controls only for scheduled-task intent", () => {
    const tools = resolveSuhengToolsAllow("每天九点创建舆情监测提醒");

    expect(tools).toEqual(
      expect.arrayContaining([
        "schedule_create",
        "schedule_delete",
        "schedule_list",
        "schedule_toggle",
      ]),
    );
    expect(tools).not.toContain("infringe_complaint_submit");
  });

  it("adds media tools without exposing unrelated transactional tools", () => {
    const tools = resolveSuhengToolsAllow("生成一段舆情科普短视频");

    expect(tools).toEqual(expect.arrayContaining(["video_generate", "video_understand"]));
    expect(tools).not.toContain("complaint_submit");
    expect(tools).not.toContain("schedule_create");
  });

  it.each(["有没有视频解析工具", "这条短视频帮我分析一下"])(
    "adds video tools when the media term comes before the action in %s",
    (message) => {
      const tools = resolveSuhengToolsAllow(message);

      expect(tools).toEqual(expect.arrayContaining(["video_link_parse", "video_understand"]));
    },
  );

  it("does not add media tools for a media mention without an action", () => {
    const tools = resolveSuhengToolsAllow("短视频行业近期发展很快");

    expect(tools).not.toContain("video_link_parse");
    expect(tools).not.toContain("video_understand");
  });

  it("makes video evidence fallbacks available when judging an external link", () => {
    const tools = resolveSuhengToolsAllow(
      "请夙衡研判这个链接：https://weibo.com/tv/show/1034:123456",
    );

    expect(tools).toEqual(
      expect.arrayContaining(["web_fetch", "video_link_parse", "video_understand"]),
    );
    expect(tools).not.toContain("video_generate");
  });

  it("does not add video fallbacks for an unrelated plain link", () => {
    const tools = resolveSuhengToolsAllow("把官网地址改成 https://example.com");

    expect(tools).not.toContain("video_link_parse");
    expect(tools).not.toContain("video_understand");
  });

  it("adds local inspection tools when the turn includes materialized attachments", () => {
    const tools = resolveSuhengToolsAllow("请分析一下", { hasAttachments: true });

    expect(tools).toEqual(expect.arrayContaining(["exec", "file_share", "process", "read"]));
  });

  it("adds only the permission-scoped history tool for collaboration diagnostics", () => {
    const tools = resolveSuhengToolsAllow("开始诊断", {
      builtinSkillName: "ai-collaboration-diagnostic",
    });

    expect(tools).toContain("collaboration_history_query");
    expect(tools).not.toContain("sessions_history");
    expect(tools).not.toContain("sessions_list");
  });

  it("does not narrow tools for custom or unknown skills", () => {
    expect(resolveSuhengToolsAllow("执行流程", { hasCustomSkills: true })).toBeUndefined();
    expect(
      resolveSuhengToolsAllow("执行流程", { builtinSkillName: "future-bundled-skill" }),
    ).toBeUndefined();
  });

  it.each([
    "只要把这个skill 放到“我的skill”中，起名为“央办12377举报函模板”即可",
    "把这套流程加入我的技能库",
    "这个技能帮我收录一下，下次直接调用",
    "导入这个 SKILL，中文名叫举报函模板",
    "我的skills里有哪些？",
    "这个技能\n请将上面已经确认过的格式、写作规范和自检清单全部整理好，然后放进去",
    "把流程做成一个可复用的技能",
    "技能库里刚才那个，再改一下标题",
    "skill_save 为什么没有开放？",
  ])("keeps skill library tools available for natural requests: %s", (message) => {
    const tools = resolveSuhengToolsAllow(message);

    expect(tools).toEqual(expect.arrayContaining(["skill_get", "skill_list", "skill_save"]));
    expect(tools).toEqual([...new Set(tools)].toSorted());
    expect(resolveSuhengToolsAllow(message)).toEqual(tools);
    expect(tools).not.toContain("schedule_create");
    expect(tools).not.toContain("send_email");
  });

  it.each(["查询今日舆情", "把这段文字放进报告", "a skillful analyst", "review upskilling trends"])(
    "does not expose skill tools without a skill reference: %s",
    (message) => {
      const tools = resolveSuhengToolsAllow(message);

      expect(tools).not.toContain("skill_get");
      expect(tools).not.toContain("skill_list");
      expect(tools).not.toContain("skill_save");
    },
  );

  it.each([
    ["把这套流程保存为技能", ["skill_get", "skill_list", "skill_save"]],
    ["查看报告任务进度", ["job_list", "report_status"]],
    ["查举报结果", ["complaint_task_status"]],
    ["生成今天的每日风险提示", ["daily_risk_tips"]],
    ["批量重新研判这些舆情", ["feed_reanalyze"]],
    ["把报告发送到我的邮箱", ["file_share", "send_email"]],
  ])("adds the narrow capability for %s", (message, expected) => {
    expect(resolveSuhengToolsAllow(message)).toEqual(expect.arrayContaining(expected));
  });
});
