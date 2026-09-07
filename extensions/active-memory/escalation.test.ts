import { describe, expect, it } from "vitest";
import { hasRecallIntent, resolveRecallEscalationDecision } from "./escalation.js";

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
    "Do you remember what we decided to deploy tomorrow?",
    "¿Qué decidimos para mañana?",
    "你还记得我们上次讨论的数据库配置吗？",
    "你还记得我们上周决定明天部署的方案吗？",
    "你還記得我們上次討論過的資料嗎？",
    "你還記得我們上週決定明天部署的方案嗎？",
    "你还记得我们上次讨论下周发布的配置吗？",
    "你還記得我們上個月討論下禮拜部署的方案嗎？",
    "你记得数据库配置吗？",
    "帮我找一下之前的聊天记录",
    "幫我找一下之前的聊天記錄",
    "我们之前讨论的那个方案",
    "我們之前討論的那個方案",
    "上次，讨论的那个方案",
    "之前  讨论过的那个方案",
    "我们之前决定过的部署方案是什么？",
    "我們之前決定過的部署方案是什麼？",
    "前回の会話で決めた設定を覚えてる？",
    "前回の会話で決めた設定を覚えていますか？",
    "この設定を覚えてますか？",
    "以前話した設定を覚えている？",
    "以前話していた設定は何ですか？",
    "前回決めた来週の設定を覚えてますか？",
    "先週相談した明日の予定を覚えてる？",
    "지난번에 우리가 논의했던 설정 기억나?",
    "지난 번에 우리가 이야기했던 설정은 뭐였어?",
    "저번에 우리가 결정했던 설정은?",
    "예전에 말했던 설정 기억나요?",
    "지난번에 우리가 결정했던 내일 배포 설정 기억나요?",
    "지난 주에 논의했던 다음 배포 일정 기억나죠?",
    "그 설정 기억나지?",
    "그 설정 기억나지요?",
    "그 설정 기억나죠?",
    "그 설정 기억나ㅋㅋ",
  ])("recognizes recall intent in %j", (message) => {
    expect(hasRecallIntent(message)).toBe(true);
  });

  it.each([
    "How do I configure SQLite?",
    "Run the tests before merging",
    "Before we deploy, run the tests",
    "Remember to send the report",
    "Remind me tomorrow",
    "How does prior authorization work?",
    "部署之前先运行测试",
    "部署之前先决定方案",
    "部署之前先讨论方案",
    "部署之前先记录方案",
    "部署之前需要记录的事项",
    "上线之前整理资料",
    "部署之前先整理聊天记录",
    "上线之前清理对话记录",
    "部署之前准备好聊天记录",
    "上线之前准备新的资料",
    "部署之前整理的资料",
    "部署之前整理的聊天记录",
    "记得明天发送报告",
    "你记得明天发送报告吗？",
    "你记得明早发送报告吗？",
    "你记得今晚发送报告吗？",
    "你记得今后发送报告吗？",
    "你記得今後發送報告嗎？",
    "你记得待会发送报告吗？",
    "你记得等会发送报告吗？",
    "你記得等會發送報告嗎？",
    "你记得等下发送报告吗？",
    "你记得下礼拜发送报告吗？",
    "你記得下禮拜發送報告嗎？",
    "你记得上周的报告明天发送吗？",
    "你還記得上週的報告明天發送嗎？",
    "記得明天發送報告",
    "你還記得明天發送報告嗎？",
    "记住这个配置",
    "記住這個",
    "医生说过敏反应很严重",
    "你说过敏反应怎么办",
    "我说过敏药在哪里",
    "我们说过敏症状",
    "讨论过期证书怎么更新",
    "我们讨论过期证书怎么更新",
    "你提过期资料了吗",
    "你讨论过期配置如何处理",
    "我谈过期合同",
    "我們討論過期證書怎麼更新",
    "你說過敏反應怎麼辦",
    "上次天气不错",
    "明日の予定を教えて",
    "この設定を覚えておいて",
    "前回は晴れだった",
    "以前より話しやすくなった",
    "以前より話したい",
    "以前のように話したくない",
    "前回より相談したい",
    "前回のように相談したくない",
    "以前より決めたい",
    "以前と同じように決めたくない",
    "以前より伝えたい",
    "前回のように伝えたくありません",
    "前回より話したい",
    "以前のように話したがる",
    "前回のように相談したがる",
    "以前と同じように決めたがる",
    "前回のように伝えたがる",
    "以前のように話したがらない",
    "前回のように相談したがりません",
    "前回会話したい",
    "以前会話したい",
    "前回のように会話したい",
    "以前のように会話したい",
    "以前のように会話が弾む",
    "以前とは違う会話をしたい",
    "以前話していただけますか",
    "前回のように話していただけますか",
    "以前話していただきたい",
    "前回話していただきたい",
    "この設定を覚えているように設定して",
    "この設定を覚えてるようにしてください",
    "覚えてますように",
    "この設定を覚えている状態にして",
    "この設定を覚えてる状態にしてください",
    "覚えていることにして",
    "覚えてるままにして",
    "明日その予定を思い出させて",
    "今晩覚えてますか？",
    "今夜覚えてる？",
    "あした覚えてますか？",
    "あす覚えてますか？",
    "後日覚えてますか？",
    "前回の設定を明日覚えてますか？",
    "あとで思い出して",
    "내일 보고서를 보내줘",
    "이 설정을 기억해줘",
    "내일 기억나요?",
    "오늘 밤 기억나죠?",
    "오늘 저녁 기억나지?",
    "오늘 오후 기억나지?",
    "차주 기억나요?",
    "글피 기억나죠?",
    "지난번 설정을 내일 기억나요?",
    "지난 주 일정을 내일 기억나죠?",
    "다음 회의 기억나죠?",
    "나중에 기억나지?",
    "지난번 날씨가 좋았어",
    "내일 기억나게 알려줘",
    "나중에 기억나도록 알림 설정해줘",
    "잊지 않게 내일 기억나게 해줘",
  ])("does not mistake ordinary or future-facing %j for recall intent", (message) => {
    expect(hasRecallIntent(message)).toBe(false);
  });

  it("requires recall intent and a weak deterministic lane in escalate mode", () => {
    expect(
      resolveRecallEscalationDecision({
        mode: "escalate",
        message: "What did we decide last time?",
        hasStrongLaneOneHit: false,
      }),
    ).toBe("recall");
    expect(
      resolveRecallEscalationDecision({
        mode: "escalate",
        message: "What did we decide last time?",
        hasStrongLaneOneHit: true,
      }),
    ).toBe("strong-lane-one-hit");
    expect(
      resolveRecallEscalationDecision({
        mode: "escalate",
        message: "Explain the current configuration",
        hasStrongLaneOneHit: false,
      }),
    ).toBe("no-recall-intent");
    expect(
      resolveRecallEscalationDecision({
        mode: "escalate",
        message: "你还记得我们上次讨论的数据库配置吗？",
        hasStrongLaneOneHit: false,
      }),
    ).toBe("recall");
    expect(
      resolveRecallEscalationDecision({
        mode: "escalate",
        message: "你还记得我们上次讨论的数据库配置吗？",
        hasStrongLaneOneHit: true,
      }),
    ).toBe("strong-lane-one-hit");
  });

  it("preserves always mode and disables escalation in off mode", () => {
    expect(
      resolveRecallEscalationDecision({
        mode: "always",
        message: "No recall phrasing here",
        hasStrongLaneOneHit: true,
      }),
    ).toBe("recall");
    expect(
      resolveRecallEscalationDecision({
        mode: "off",
        message: "Do you remember this?",
        hasStrongLaneOneHit: false,
      }),
    ).toBe("mode-off");
    expect(
      resolveRecallEscalationDecision({
        mode: "always",
        message: "记住这个配置",
        hasStrongLaneOneHit: true,
      }),
    ).toBe("recall");
    expect(
      resolveRecallEscalationDecision({
        mode: "off",
        message: "你还记得我们上次讨论的数据库配置吗？",
        hasStrongLaneOneHit: false,
      }),
    ).toBe("mode-off");
  });
});
