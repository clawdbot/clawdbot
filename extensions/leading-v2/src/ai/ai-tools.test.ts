import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../../api.js";
import { ApiKeyResolver } from "../client/key-resolver.js";

const { mockPostForm, mockGetJson } = vi.hoisted(() => ({
  mockPostForm: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
  mockGetJson: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>(),
}));

vi.mock("../client/http-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client/http-client.js")>();
  return { ...actual, postForm: mockPostForm, getJson: mockGetJson };
});

const {
  createJobListToolFactory,
  createJobStopToolFactory,
  createLetterGenerateToolFactory,
  createLetterFetchToolFactory,
  createComplaintSubmitToolFactory,
  createInfringeProfileListToolFactory,
  createInfringeComplaintSubmitToolFactory,
  createInfringeProfileSaveToolFactory,
} = await import("./ai-tools.js");

const fakeApi = {
  pluginConfig: { backend: { baseUrl: "https://v2.businesstimescn.com", siteId: "legal" } },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
} as unknown as OpenClawPluginApi;

const resolver = new ApiKeyResolver({ "1749": "sk_test1749" }, undefined);

function parse(result: unknown): Record<string, unknown> {
  const r = result as { details?: unknown; content?: Array<{ text?: string }> };
  if (r?.details && typeof r.details === "object") {
    return r.details as Record<string, unknown>;
  }
  const text = r?.content?.[0]?.text;
  return text ? JSON.parse(text) : (result as Record<string, unknown>);
}

afterEach(() => vi.clearAllMocks());

describe("gating", () => {
  it("hides tools from non-rabbitmq agents", () => {
    expect(createJobListToolFactory(fakeApi, resolver)({ agentId: "telegram-1" })).toBeNull();
    expect(createLetterGenerateToolFactory(fakeApi, resolver)({ agentId: undefined })).toBeNull();
  });
});

describe("job_list", () => {
  it("lists pr-workspace jobs with status labels", async () => {
    const tool = createJobListToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    mockGetJson.mockResolvedValue({
      code: "success",
      total: 1,
      jobs: [{ id: 1, label: "某检测", status: "Done", rate: 4.5, completion: 100, date: "d" }],
    });
    const res = parse(await tool.execute("j1", {}));
    const [, path, params] = mockGetJson.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/ai/fetch-jobs");
    expect(params).toMatchObject({ workspace: "pr" });
    expect((res.list as Array<Record<string, unknown>>)[0]).toMatchObject({
      label: "某检测",
      status: "Done",
      statusLabel: "已完成",
    });
  });
});

describe("letter_generate", () => {
  const tool = () =>
    createLetterGenerateToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;

  /** 两段 GET：先 /ai/fetch-jobs 定位任务，再 /ai/fetch-job 取检测结果。 */
  function mockJob(job: Record<string, unknown>, detail?: Record<string, unknown>) {
    mockGetJson.mockImplementation((_config: unknown, path: unknown) =>
      Promise.resolve(path === "/ai/fetch-jobs" ? { jobs: [job] } : (detail ?? {})),
    );
  }

  const DONE_JOB = { id: 6032, label: "某检测", status: "Done" };
  const DETAIL = {
    job: { id: 6032, rate: 4.5, summary: "整体评估：存在多处未经核实的财务数据。" },
    tasks: [{ ruleTitle: "互联网新闻信息服务管理规定", result: "第3段虚构营收数据。" }],
  };

  it("refuses while the detection task is still running — no backend write", async () => {
    mockJob({ id: 6032, label: "某检测", status: "Pending" });
    const res = parse(await tool().execute("g0", {}));
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("尚未完成");
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("refuses when the finished task found no violations", async () => {
    mockJob(DONE_JOB, { job: { id: 6032, rate: 0, summary: "未发现违规" }, tasks: [] });
    const res = parse(await tool().execute("g1", {}));
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("未检测到违规事实");
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("takes the violations from the detection result, not from the model", async () => {
    mockJob(DONE_JOB, DETAIL);
    mockPostForm.mockResolvedValue({ code: "success", message: "正在生成，请稍等！" });
    const res = parse(await tool().execute("g2", { all: true }));
    const [, path, fields] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/ai/generate-letter");
    expect(fields).toMatchObject({ jobId: 6032, siteId: "legal", all: 1 });
    expect(fields.errors).toBe(
      "整体评估：存在多处未经核实的财务数据。\n《互联网新闻信息服务管理规定》：第3段虚构营收数据。",
    );
    expect(res).toMatchObject({ success: true, submitted: true });
  });

  it("appends the optional supplement after the detection result", async () => {
    mockJob(DONE_JOB, DETAIL);
    mockPostForm.mockResolvedValue({ code: "success" });
    await tool().execute("g3", { supplement: "另引用《民法典》第1024条。" });
    const [, , fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(String(fields.errors)).toMatch(/第3段虚构营收数据。\n另引用《民法典》第1024条。$/);
  });

  it("surfaces the backend 'too minor' error", async () => {
    mockJob(DONE_JOB, DETAIL);
    mockPostForm.mockResolvedValue({ code: "error", message: "文章违规程度较低，无法生成撤稿函" });
    const res = parse(await tool().execute("g4", {}));
    expect(res).toMatchObject({ success: false, error: "文章违规程度较低，无法生成撤稿函" });
  });

  it("errors when there is no recent job", async () => {
    mockGetJson.mockResolvedValue({ jobs: [] });
    const res = parse(await tool().execute("g5", {}));
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });
});

describe("letter_fetch", () => {
  it("maps letterMap to a list with category labels", async () => {
    const tool = createLetterFetchToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6052 }] });
    mockPostForm.mockResolvedValue({
      code: "success",
      letterMap: {
        Retraction: { id: 1, category: "Retraction", content: "撤稿函正文" },
        Report: { id: 2, category: "Report", content: "举报信正文" },
      },
      size: 2,
    });
    const res = parse(await tool.execute("lf1"));
    const [, path, fields] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/ai/fetch-letters");
    expect(fields).toMatchObject({ jobId: 6052 });
    expect(res.count).toBe(2);
    expect((res.letters as Array<Record<string, unknown>>)[0]).toMatchObject({
      category: "Retraction",
      categoryLabel: "撤稿函",
      content: "撤稿函正文",
    });
  });

  it("drops 公函 entries and letters that have no content yet", async () => {
    const tool = createLetterFetchToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6052 }] });
    mockPostForm.mockResolvedValue({
      code: "success",
      letterMap: {
        // 公函 = 投诉/举报功能，不是文书
        GovOfficial: { id: 3, category: "GovOfficial", content: "官方公函正文" },
        GovPersonal: { id: 4, category: "GovPersonal", content: "个人公函正文" },
        // 后端占位、正文尚未生成
        Complaint: { id: 5, category: "Complaint", content: "" },
        Retraction: { id: 6, category: "Retraction", content: "撤稿函正文" },
      },
    });
    const res = parse(await tool.execute("lf3"));
    expect(res.count).toBe(1);
    expect((res.letters as Array<Record<string, unknown>>)[0]).toMatchObject({
      category: "Retraction",
      categoryLabel: "撤稿函",
    });
  });

  it("treats an empty letterMap array as zero letters", async () => {
    const tool = createLetterFetchToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6052 }] });
    mockPostForm.mockResolvedValue({ code: "success", letterMap: [], size: 0 });
    const res = parse(await tool.execute("lf2"));
    expect(res).toMatchObject({ success: true, count: 0 });
  });
});

describe("job_stop", () => {
  it("resolves latest job and posts stop-job/{id}", async () => {
    const tool = createJobStopToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6058 }] });
    mockPostForm.mockResolvedValue({
      code: "success",
      job: { id: 6058, label: "某检测", status: "stop" },
    });
    const res = parse(await tool.execute("st1"));
    const [, path] = mockPostForm.mock.calls[0] as [unknown, string];
    expect(path).toBe("/ai/stop-job/6058");
    expect(res).toMatchObject({ success: true, label: "某检测" });
  });
});

describe("complaint_submit", () => {
  const tool = () =>
    createComplaintSubmitToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;

  it("is hidden from non-rabbitmq agents", () => {
    expect(
      createComplaintSubmitToolFactory(fakeApi, resolver)({ agentId: "telegram-1" }),
    ).toBeNull();
  });

  it("reuses the latest job's link and posts save-complaint-job", async () => {
    mockGetJson.mockResolvedValue({
      jobs: [{ id: 6070, link: "https://www.douyin.com/video/123" }],
    });
    mockPostForm.mockResolvedValue({ code: "success", message: "举报任务已提交，请耐心等待" });
    const res = parse(await tool().execute("c1", {}));
    const [, path, fields] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/legal/save-complaint-job");
    expect(fields).toMatchObject({
      id: 6070,
      links: JSON.stringify(["https://www.douyin.com/video/123"]),
      role: "Personal",
    });
    expect(res).toMatchObject({ success: true, submitted: true });
  });

  it("prefers explicit links and honors Enterprise role", async () => {
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6071, link: "https://ignored.example" }] });
    mockPostForm.mockResolvedValue({ code: "success", message: "举报任务已提交，请耐心等待" });
    await tool().execute("c2", {
      links: ["https://www.xiaohongshu.com/a", ""],
      role: "Enterprise",
    });
    const [, , fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(fields).toMatchObject({
      id: 6071,
      links: JSON.stringify(["https://www.xiaohongshu.com/a"]),
      role: "Enterprise",
    });
  });

  it("submits a confirmed agent judgment without resolving a detection job", async () => {
    mockPostForm.mockResolvedValue({ code: "success", message: "举报任务已提交，请耐心等待" });
    const judgment = "夙衡逐项研判确认该内容包含虚构事实，并对应现行规则，建议立即举报。";

    await tool().execute("c-direct", {
      basisSource: "AgentJudgment",
      confirmed: true,
      subjectScope: "Institution",
      judgment,
      links: ["https://www.xiaohongshu.com/a"],
      classifications: [
        {
          link: "https://www.xiaohongshu.com/a",
          taxonomyVersionId: 23,
          categoryCode: "false_information",
          subCategoryCode: "false_rumor",
        },
      ],
    });

    expect(mockGetJson).not.toHaveBeenCalled();
    const [, path, fields] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/legal/save-complaint-job");
    expect(fields).toMatchObject({
      id: 0,
      basisSource: "AgentJudgment",
      confirmed: 1,
      subjectScope: "Institution",
      judgment,
      role: "Personal",
      links: JSON.stringify(["https://www.xiaohongshu.com/a"]),
      classifications: JSON.stringify([
        {
          link: "https://www.xiaohongshu.com/a",
          taxonomyVersionId: 23,
          categoryCode: "false_information",
          subCategoryCode: "false_rumor",
        },
      ]),
    });
  });

  it("returns the current platform taxonomy before a direct judgment is submitted", async () => {
    const judgment = "夙衡逐项研判确认该内容包含虚构事实，并对应现行规则，建议立即举报。";
    mockGetJson.mockResolvedValue({
      code: "success",
      taxonomies: [
        {
          link: "https://weibo.com/1/a",
          platform: "Weibo",
          taxonomyVersionId: 31,
          categories: [
            {
              code: "false_information",
              label: "不实信息",
              children: [{ code: "false_rumor", label: "造谣传谣" }],
            },
          ],
        },
      ],
    });

    const res = parse(
      await tool().execute("c-taxonomy", {
        basisSource: "AgentJudgment",
        confirmed: true,
        subjectScope: "Institution",
        judgment,
        links: ["https://weibo.com/1/a"],
      }),
    );

    expect(mockPostForm).not.toHaveBeenCalled();
    expect(mockGetJson).toHaveBeenCalledWith(
      expect.anything(),
      "/legal/fetch-complaint-taxonomy",
      { links: ["https://weibo.com/1/a"] },
      "sk_test1749",
    );
    expect(res).toMatchObject({
      success: false,
      classificationRequired: true,
      taxonomies: expect.any(Array),
    });
  });

  it("fails closed when a direct report link has no published selectable taxonomy", async () => {
    const link = "https://weibo.com/1/missing";
    mockGetJson.mockResolvedValue({ code: "success", taxonomies: [], unsupportedLinks: [link] });

    const res = parse(
      await tool().execute("c-no-taxonomy", {
        basisSource: "AgentJudgment",
        confirmed: true,
        subjectScope: "Institution",
        judgment: "夙衡逐项研判确认该内容包含虚构事实，并对应现行规则，建议立即举报。",
        links: [link],
      }),
    );

    expect(mockPostForm).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      success: false,
      classificationRequired: false,
      unsupportedLinks: [link],
    });
    expect(res.error).toContain("分类目录");
  });

  it("rejects an agent judgment report without explicit confirmation", async () => {
    const res = parse(
      await tool().execute("c-unconfirmed", {
        basisSource: "AgentJudgment",
        subjectScope: "Institution",
        judgment: "夙衡逐项研判确认该内容包含虚构事实，并对应现行规则，建议立即举报。",
        links: ["https://www.xiaohongshu.com/a"],
      }),
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain("明确确认");
    expect(mockGetJson).not.toHaveBeenCalled();
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("errors without a backend call when there is no recent job", async () => {
    mockGetJson.mockResolvedValue({ jobs: [] });
    const res = parse(await tool().execute("c3", {}));
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("errors when the job has no link and none provided", async () => {
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6072 }] });
    const res = parse(await tool().execute("c4", {}));
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("surfaces the backend 'unsupported link' error", async () => {
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6073, link: "https://unsupported.example/x" }] });
    mockPostForm.mockResolvedValue({
      code: "error",
      message: "一键举报功能当前暂不支持您提供的链接",
    });
    const res = parse(await tool().execute("c5", {}));
    expect(res).toMatchObject({ success: false, error: "一键举报功能当前暂不支持您提供的链接" });
  });
});

describe("infringe_profile_list", () => {
  it("is hidden from non-rabbitmq agents", () => {
    expect(
      createInfringeProfileListToolFactory(fakeApi, resolver)({ agentId: "telegram-1" }),
    ).toBeNull();
  });

  it("summarizes profiles with subject/type/委托书 labels", async () => {
    const tool = createInfringeProfileListToolFactory(
      fakeApi,
      resolver,
    )({
      agentId: "rabbitmq-1749",
    })!;
    mockGetJson.mockResolvedValue({
      code: "success",
      list: [
        {
          id: 12,
          label: "张三名誉",
          name: "张三",
          subjectType: "Personal",
          defaultInfringeType: "Reputation",
          powerOfAttorney: "",
          contactName: "张三",
          contactEmail: "a@b.com",
        },
      ],
    });
    const res = parse(await tool.execute("p1", {}));
    const [, path] = mockGetJson.mock.calls[0] as [unknown, string];
    expect(path).toBe("/infringe-complaint/fetch-profiles");
    expect(res).toMatchObject({ success: true, total: 1 });
    expect((res.list as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 12,
      subjectTypeLabel: "个人",
      defaultInfringeTypeLabel: "名誉权",
      hasPowerOfAttorney: false,
    });
  });
});

describe("infringe_complaint_submit", () => {
  const tool = () =>
    createInfringeComplaintSubmitToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;

  it("is hidden from non-rabbitmq agents", () => {
    expect(
      createInfringeComplaintSubmitToolFactory(fakeApi, resolver)({ agentId: "telegram-1" }),
    ).toBeNull();
  });

  it("posts save-complaint-job with explicit profile + stamped letter, reusing the job link", async () => {
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6080, link: "https://www.douyin.com/video/1" }] });
    mockPostForm.mockResolvedValue({
      code: "success",
      taskId: 55,
      count: 1,
      message: "已提交 1 条投诉，请耐心等待",
    });
    const res = parse(
      await tool().execute("i1", { profileId: 12, stampedComplaint: "oss/stamp.pdf" }),
    );
    const [, path, fields] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/infringe-complaint/save-complaint-job");
    expect(fields).toMatchObject({
      profileId: 12,
      infringeType: "Reputation",
      links: JSON.stringify(["https://www.douyin.com/video/1"]),
      stampedComplaint: "oss/stamp.pdf",
      jobId: 6080,
    });
    expect(res).toMatchObject({ success: true, submitted: true, taskId: 55, count: 1 });
  });

  it("passes a file_share OSS URL through as stampedComplaint", async () => {
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6084, link: "https://weibo.com/x" }] });
    mockPostForm.mockResolvedValue({ code: "success", message: "ok" });
    const stampedComplaint =
      "https://oss.ibtai.com/ibtai/assistant-agent/outputs/2026/08/stamped.pdf";

    await tool().execute("i-url", { profileId: 12, stampedComplaint });

    const [, , fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(fields.stampedComplaint).toBe(stampedComplaint);
  });

  it("auto-selects the sole profile when profileId is omitted", async () => {
    mockGetJson.mockImplementation((...args: unknown[]) =>
      args[1] === "/infringe-complaint/fetch-profiles"
        ? Promise.resolve({ list: [{ id: 9 }] })
        : Promise.resolve({ jobs: [{ id: 6081, link: "https://weibo.com/x" }] }),
    );
    mockPostForm.mockResolvedValue({ code: "success", message: "ok" });
    await tool().execute("i2", { stampedComplaint: "oss/s.pdf", infringeType: "Goodwill" });
    const [, , fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(fields).toMatchObject({ profileId: 9, infringeType: "Goodwill" });
  });

  it("submits a confirmed enterprise judgment without attaching a stale detection job", async () => {
    mockPostForm.mockResolvedValue({ code: "success", taskId: 56, count: 1, message: "ok" });
    const judgment = "夙衡逐句研判确认相关事实主张缺乏依据，已构成企业商誉侵权。";

    await tool().execute("i-direct", {
      profileId: 12,
      stampedComplaint: "oss/s.pdf",
      basisSource: "AgentJudgment",
      confirmed: true,
      subjectScope: "Enterprise",
      judgment,
      links: ["https://weibo.com/x"],
      factReason: judgment,
    });

    expect(mockGetJson).not.toHaveBeenCalled();
    const [, path, fields] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/infringe-complaint/save-complaint-job");
    expect(fields).toMatchObject({
      jobId: 0,
      basisSource: "AgentJudgment",
      confirmed: 1,
      subjectScope: "Enterprise",
      judgment,
      links: JSON.stringify(["https://weibo.com/x"]),
    });
  });

  it("rejects a direct complaint for a non-enterprise subject", async () => {
    const res = parse(
      await tool().execute("i-institution", {
        basisSource: "AgentJudgment",
        confirmed: true,
        subjectScope: "Institution",
        judgment: "夙衡逐项研判确认该机构相关内容存在违规事实，但不属于企业侵权投诉范围。",
        links: ["https://weibo.com/x"],
      }),
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain("非企业主体不能投诉");
    expect(mockGetJson).not.toHaveBeenCalled();
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("asks for a profileId when the account has multiple profiles", async () => {
    mockGetJson.mockResolvedValue({ list: [{ id: 1 }, { id: 2 }] });
    const res = parse(await tool().execute("i3", { stampedComplaint: "oss/s.pdf" }));
    expect(res.success).toBe(false);
    expect((res.profiles as unknown[]).length).toBe(2);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("errors when there is no profile at all", async () => {
    mockGetJson.mockResolvedValue({ list: [] });
    const res = parse(await tool().execute("i4", { stampedComplaint: "oss/s.pdf" }));
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("blocks (no backend call) when the stamped complaint letter is missing", async () => {
    const res = parse(await tool().execute("i5", { profileId: 12 }));
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("盖章");
    expect(String(res.error)).toContain("file_share");
    expect(String(res.error)).toContain("OSS key 或 URL");
    expect(String(res.error)).not.toContain("网页端");
    expect(mockGetJson).not.toHaveBeenCalled();
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("surfaces the backend gate (agent complaint without 委托书)", async () => {
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6082, link: "https://www.douyin.com/v/1" }] });
    mockPostForm.mockResolvedValue({
      code: "danger",
      message: "代理投诉需先在该主体档案上传「授权委托书」",
    });
    const res = parse(
      await tool().execute("i6", { profileId: 12, stampedComplaint: "oss/s.pdf", agentId: 3 }),
    );
    const [, , fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(fields).toMatchObject({ agentId: 3 });
    expect(res).toMatchObject({
      success: false,
      error: "代理投诉需先在该主体档案上传「授权委托书」",
    });
  });

  it("turns the misleading agent-profile backend error into actionable prerequisites", async () => {
    mockGetJson.mockResolvedValue({ jobs: [{ id: 6083, link: "https://www.douyin.com/v/2" }] });
    mockPostForm.mockResolvedValue({
      code: "danger",
      message: "代理人档案不存在或无权限",
    });

    const res = parse(
      await tool().execute("i7", { profileId: 12, stampedComplaint: "oss/s.pdf", agentId: 4 }),
    );

    expect(String(res.error)).toContain("代理人档案不可用");
    expect(String(res.error)).toContain("身份证明");
    expect(String(res.error)).toContain("授权委托书");
    expect(String(res.error)).toContain("代理人档案不存在或无权限");
  });
});

describe("infringe_profile_save", () => {
  const tool = () =>
    createInfringeProfileSaveToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;

  it("is hidden from non-rabbitmq agents", () => {
    expect(
      createInfringeProfileSaveToolFactory(fakeApi, resolver)({ agentId: "telegram-1" }),
    ).toBeNull();
  });

  it("creates a personal profile and reports the ID docs still needed", async () => {
    mockPostForm.mockResolvedValue({ code: "success", id: 77, message: "保存成功" });
    const res = parse(
      await tool().execute("ps1", {
        subjectType: "Personal",
        name: "张三",
        idNumber: "11010119900101xxxx",
        contactEmail: "z@e.com",
      }),
    );
    const [, path, fields] = mockPostForm.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/infringe-complaint/save-profile");
    expect(fields).toMatchObject({
      subjectType: "Personal",
      name: "张三",
      idNumber: "11010119900101xxxx",
      defaultInfringeType: "Reputation",
    });
    expect(res).toMatchObject({ success: true, profileId: 77 });
    expect(res.missingDocs).toEqual(["身份证正面", "身份证反面"]);
    expect(String(res.agentInstruction)).toContain("聊天附件");
    expect(String(res.agentInstruction)).toContain("ossKey");
    expect(String(res.agentInstruction)).not.toContain("网页端");
  });

  it("reports enterprise docs and passes id when updating", async () => {
    mockPostForm.mockResolvedValue({ code: "success", id: 90 });
    const res = parse(
      await tool().execute("ps2", {
        profileId: 90,
        subjectType: "Enterprise",
        name: "某公司",
        businessLicense: "oss/lic.jpg",
      }),
    );
    const [, , fields] = mockPostForm.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(fields).toMatchObject({
      id: 90,
      subjectType: "Enterprise",
      businessLicense: "oss/lic.jpg",
    });
    // 已传营业执照，只差公章
    expect(res.missingDocs).toEqual(["公章"]);
  });

  it("rejects an invalid subjectType without a backend call", async () => {
    const res = parse(await tool().execute("ps3", { subjectType: "Robot", name: "x" }));
    expect(res.success).toBe(false);
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("surfaces the backend error", async () => {
    mockPostForm.mockResolvedValue({ code: "danger", message: "请填写主体名称" });
    const res = parse(await tool().execute("ps4", { subjectType: "Personal", name: "占位" }));
    expect(res).toMatchObject({ success: false, error: "请填写主体名称" });
  });
});

describe("complaint taxonomy discovery", () => {
  async function tool() {
    const { createComplaintTaxonomyToolFactory } =
      await import("../complaint/complaint-taxonomy-tool.js");
    return createComplaintTaxonomyToolFactory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
  }

  it("queries live platforms without submitting a task", async () => {
    mockGetJson.mockResolvedValue({
      code: "success",
      platforms: [{ platform: "Netease", contentTypes: ["article"] }],
      taxonomies: [],
      unsupportedLinks: [],
    });
    const result = parse(await (await tool()).execute("platforms", {}));
    expect(result.success).toBe(true);
    expect(result.platforms).toEqual([{ platform: "Netease", contentTypes: ["article"] }]);
    expect(mockGetJson).toHaveBeenCalledWith(
      expect.anything(),
      "/legal/fetch-complaint-taxonomy",
      {},
      "sk_test1749",
    );
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("passes every link to the backend instead of applying an old platform list", async () => {
    const links = [
      "https://www.163.com/dy/article/example.html",
      "https://example.com/unsupported",
    ];
    mockGetJson.mockResolvedValue({
      code: "success",
      taxonomies: [{ link: links[0], platform: "Netease", taxonomyVersionId: 16 }],
      unsupportedLinks: [links[1]],
    });
    const result = parse(await (await tool()).execute("links", { links }));
    expect(result.success).toBe(true);
    expect(result.unsupportedLinks).toEqual([links[1]]);
    expect(mockGetJson).toHaveBeenCalledWith(
      expect.anything(),
      "/legal/fetch-complaint-taxonomy",
      { links },
      "sk_test1749",
    );
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it.each([
    { code: "success", taxonomies: [], unsupportedLinks: [] },
    { code: "danger", message: "目录暂不可用" },
    { login: true },
  ])("does not confuse unavailable discovery with unsupported platforms", async (response) => {
    mockGetJson.mockResolvedValue(response);
    const result = parse(await (await tool()).execute("unavailable", {}));
    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty("platforms");
    expect(result).not.toHaveProperty("unsupportedLinks");
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("rejects invalid links before requesting the backend", async () => {
    const result = parse(await (await tool()).execute("invalid", { links: [42] }));
    expect(result.success).toBe(false);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it("removes stale platform claims from both submission schemas", () => {
    for (const factory of [
      createComplaintSubmitToolFactory,
      createInfringeComplaintSubmitToolFactory,
    ]) {
      const submit = factory(fakeApi, resolver)({ agentId: "rabbitmq-1749" })!;
      const description = submit.description + JSON.stringify(submit.parameters);
      expect(description).not.toContain("仅支持");
      expect(description).not.toContain("其他平台链接会被");
      expect(description).toContain("complaint_taxonomy");
    }
  });
});

describe("taxonomy query failure handling", () => {
  it("does not turn an authentication failure during submission preflight into unsupported links", async () => {
    mockGetJson.mockResolvedValue({ login: true });
    const submit = createComplaintSubmitToolFactory(
      fakeApi,
      resolver,
    )({ agentId: "rabbitmq-1749" })!;
    const result = parse(
      await submit.execute("failed-preflight", {
        basisSource: "AgentJudgment",
        confirmed: true,
        subjectScope: "Enterprise",
        judgment: "根据用户提供的证据逐项研判，这些内容涉嫌侵权，用户已明确要求发起举报。",
        links: ["https://www.163.com/dy/article/example.html"],
      }),
    );
    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty("unsupportedLinks");
    expect(mockPostForm).not.toHaveBeenCalled();
  });

  it("keeps taxonomy discovery scoped to rabbitmq users", async () => {
    const { createComplaintTaxonomyToolFactory } =
      await import("../complaint/complaint-taxonomy-tool.js");
    expect(
      createComplaintTaxonomyToolFactory(fakeApi, resolver)({ agentId: "telegram-1749" }),
    ).toBeNull();
  });
});
