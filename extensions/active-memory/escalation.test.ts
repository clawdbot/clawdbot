import { describe, expect, it } from "vitest";
import { hasRecallIntent, shouldEscalateRecall } from "./escalation.js";

describe("active-memory escalation", () => {
  it.each([
    "Do you remember what we decided?",
    "What did we discuss last time?",
    "Which database did we choose?",
    "Summarize the conversations from January",
    "¿Qué decidimos la última vez?",
    "¿Cuál fue la última vez que hablamos?",
    "Can you remind me what seat I prefer?",
    "You said earlier that the rollout was paused",
    "What happened two weeks ago?",
    "你还记得我们之前决定的事情吗？",
    "记得上次我们讨论了什么？",
    "我们聊过那个方案",
    "上次我们决定用哪个数据库？",
    "我们上次讨论了什么？",
    "帮我找一下之前的聊天记录",
    "总结一下我们之前的对话",
    "你还记得去年订的酒店吗",
    "上次我们去哪里吃饭了？",
    "之前我们商量过这个事",
    "我们上周讨论的方案你推进了吗",
    "咱们上次说要买新服务器",
    "帮我看看以前的聊天记录里有没有这个",
    "你以前提过这个问题吗",
    "我们之前聊的这个需求有进展吗",
    "上次我们说的那个方案你还没给我链接",
    "把上次讨论的结论整理一下",
    "上次买的那个东西到货了吗",
    "你還記得我們之前決定的事情嗎？",
    "記得上次我們討論了什麼？",
    "我們聊過那個方案",
    "上次我們決定用哪個資料庫？",
    "我們上次討論了什麼？",
    "幫我找一下之前的聊天紀錄",
    "總結一下我們之前的對話",
    "上次我們去哪裡吃飯了？",
    "之前我們商量過這個事",
    "我們上次討論的方案你推進了嗎",
    "上次買的那個東西到貨了嗎",
    "把上次討論的結論整理一下",
  ])("recognizes recall intent in %j", (message) => {
    expect(hasRecallIntent(message)).toBe(true);
  });

  it("requires recall intent and a weak deterministic lane in escalate mode", () => {
    expect(hasRecallIntent("How do I configure SQLite?")).toBe(false);
    expect(hasRecallIntent("Run the tests before merging")).toBe(false);
    expect(hasRecallIntent("Before we deploy, run the tests")).toBe(false);
    expect(hasRecallIntent("Remember to send the report")).toBe(false);
    expect(hasRecallIntent("Remind me tomorrow")).toBe(false);
    expect(hasRecallIntent("How does prior authorization work?")).toBe(false);
    expect(hasRecallIntent("帮我写一段 Python 代码")).toBe(false);
    expect(hasRecallIntent("把这个文件改一下格式")).toBe(false);
    expect(hasRecallIntent("记得把报告发给经理")).toBe(false);
    expect(hasRecallIntent("看看现在服务器状态怎么样")).toBe(false);
    expect(hasRecallIntent("帮我查一下今天上海天气")).toBe(false);
    expect(hasRecallIntent("我们公司叫啥来着")).toBe(false);
    expect(hasRecallIntent("你记得设置里的默认值吗")).toBe(false);
    expect(hasRecallIntent("今天开会了吗")).toBe(false);
    expect(hasRecallIntent("下午三点提醒我")).toBe(false);
    expect(hasRecallIntent("这个功能怎么用")).toBe(false);
    expect(hasRecallIntent("请把截图发我")).toBe(false);
    expect(hasRecallIntent("马上部署到生产")).toBe(false);
    expect(hasRecallIntent("别忘了我给你的任务")).toBe(false);
    expect(hasRecallIntent("你好呀")).toBe(false);
    expect(hasRecallIntent("谢谢")).toBe(false);
    expect(hasRecallIntent("再见")).toBe(false);
    expect(hasRecallIntent("今晚吃什么")).toBe(false);
    expect(hasRecallIntent("推荐一部电影")).toBe(false);
    expect(hasRecallIntent("给我讲个笑话")).toBe(false);
    expect(hasRecallIntent("日志在哪看")).toBe(false);
    expect(hasRecallIntent("帮我翻译这段")).toBe(false);
    expect(hasRecallIntent("发我一份报价单")).toBe(false);
    expect(hasRecallIntent("明天要开会吗")).toBe(false);
    expect(hasRecallIntent("服务器还正常吗")).toBe(false);
    expect(hasRecallIntent("帮我创建个新用户")).toBe(false);
    expect(hasRecallIntent("价格是多少")).toBe(false);
    expect(hasRecallIntent("什么时候上线")).toBe(false);
    expect(hasRecallIntent("先这样吧")).toBe(false);
    expect(hasRecallIntent("好的收到")).toBe(false);
    expect(hasRecallIntent("没问题")).toBe(false);
    expect(hasRecallIntent("辛苦啦")).toBe(false);
    expect(hasRecallIntent("明天早上提醒我")).toBe(false);
    expect(hasRecallIntent("帮我查下快递")).toBe(false);
    expect(hasRecallIntent("这个需求优先级不高")).toBe(false);
    expect(hasRecallIntent("我们进度到哪了")).toBe(false);
    expect(hasRecallIntent("测试通过了吗")).toBe(false);
    expect(hasRecallIntent("还有别的事吗")).toBe(false);
    expect(hasRecallIntent("可以结单")).toBe(false);
    expect(hasRecallIntent("記得发送报告")).toBe(false);
    expect(hasRecallIntent("部署之前先跑测试")).toBe(false);
    expect(hasRecallIntent("运行测试后合并")).toBe(false);
    expect(hasRecallIntent("記得吃飯")).toBe(false);
    expect(hasRecallIntent("幫我寫一段程式")).toBe(false);
    expect(hasRecallIntent("把這個檔案改一下格式")).toBe(false);
    expect(hasRecallIntent("記得把報告發給經理")).toBe(false);
    expect(hasRecallIntent("看看現在伺服器狀態怎麼樣")).toBe(false);
    expect(hasRecallIntent("幫我查一下今天天氣")).toBe(false);
    expect(hasRecallIntent("下午三點提醒我")).toBe(false);
    expect(hasRecallIntent("這個功能怎麼用")).toBe(false);
    expect(hasRecallIntent("把截圖發給我")).toBe(false);
    expect(
      shouldEscalateRecall({
        mode: "escalate",
        message: "上次我们决定用哪个数据库？",
        hasStrongLaneOneHit: false,
      }),
    ).toBe(true);
    expect(
      shouldEscalateRecall({
        mode: "escalate",
        message: "上次我们决定用哪个数据库？",
        hasStrongLaneOneHit: true,
      }),
    ).toBe(false);
    expect(
      shouldEscalateRecall({
        mode: "escalate",
        message: "帮我写一段 Python 代码",
        hasStrongLaneOneHit: false,
      }),
    ).toBe(false);
    expect(
      shouldEscalateRecall({
        mode: "escalate",
        message: "What did we decide last time?",
        hasStrongLaneOneHit: false,
      }),
    ).toBe(true);
    expect(
      shouldEscalateRecall({
        mode: "escalate",
        message: "What did we decide last time?",
        hasStrongLaneOneHit: true,
      }),
    ).toBe(false);
    expect(
      shouldEscalateRecall({
        mode: "escalate",
        message: "Explain the current configuration",
        hasStrongLaneOneHit: false,
      }),
    ).toBe(false);
  });

  it("preserves always mode and disables escalation in off mode", () => {
    expect(
      shouldEscalateRecall({
        mode: "always",
        message: "No recall phrasing here",
        hasStrongLaneOneHit: true,
      }),
    ).toBe(true);
    expect(
      shouldEscalateRecall({
        mode: "off",
        message: "Do you remember this?",
        hasStrongLaneOneHit: false,
      }),
    ).toBe(false);
  });
});
