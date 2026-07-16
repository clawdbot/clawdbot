---
name: qqbot-remind
description: QQBot 定时提醒。支持一次性和周期性提醒的创建、查询、取消。当通过 QQ 通道通信且涉及提醒/定时任务时使用。
metadata: { "openclaw": { "emoji": "⏰", "requires": { "config": ["channels.qqbot"] } } }
---

# QQ Bot 定时提醒

## ⚠️ 强制规则

**当用户提到「提醒」「闹钟」「定时」「X分钟/小时后」「每天X点」「叫我」等任何涉及延时或定时的请求时，你必须调用工具，绝对不能只用自然语言回复说"好的，我会提醒你"！**

你没有内存或后台线程，口头承诺"到时候提醒"是无效的——只有调用工具才能真正注册定时任务。

---

## 推荐流程（优先使用 `qqbot_remind` 工具）

**第一步**：调用 `qqbot_remind` 工具，传入简单参数：

| 参数      | 说明                                         | 示例                               |
| --------- | -------------------------------------------- | ---------------------------------- |
| `action`  | 操作类型                                     | `"add"` / `"list"` / `"remove"`    |
| `content` | 提醒内容                                     | `"喝水"`                           |
| `to`      | 目标地址（可选，系统自动获取，通常无需填写） | —                                  |
| `time`    | 时间（相对时间或 cron 表达式）               | `"5m"` / `"1h30m"` / `"0 8 * * *"` |
| `jobId`   | 任务 ID（仅 remove）                         | `"xxx"`                            |

**第二步**：`qqbot_remind` 会返回 `cronParams`，你必须**立即**将 `cronParams` 的值作为参数调用 `cron` 工具。

**第三步**：根据 `cron` 工具的返回结果，回复用户。

### 示例

用户说："5分钟后提醒我喝水"

1. 调用 `qqbot_remind`：`{ "action": "add", "content": "喝水", "time": "5m" }`
2. 收到返回的 `cronParams` → 立即调用 `cron` 工具，参数为该 `cronParams`
3. 回复用户：`⏰ 好的，5分钟后提醒你喝水~`

---

## 备用方案（直接使用 `cron` 工具）

> 仅当 `qqbot_remind` 工具不可用时使用以下方式。

### 核心规则

> **payload.kind 必须是 `"agentTurn"`，绝对不能用 `"systemEvent"`！**
> `systemEvent` 只在 AI 会话内部注入文本，用户收不到 QQ 消息。

**5 个不可更改字段**：

| 字段              | 固定值        | 原因                         |
| ----------------- | ------------- | ---------------------------- |
| `payload.kind`    | `"agentTurn"` | `systemEvent` 不会发 QQ 消息 |
| `payload.deliver` | `true`        | 否则不投递                   |
| `payload.channel` | `"qqbot"`     | QQ 通道标识                  |
| `payload.to`      | 用户 openid   | 从 `To` 字段获取             |
| `sessionTarget`   | `"isolated"`  | 隔离会话避免污染             |

> `schedule.atMs` 必须是**绝对毫秒时间戳**（如 `1770733800000`），不支持 `"5m"` 等相对字符串。
> 计算方式：`当前时间戳ms + 延迟毫秒`。

### 一次性提醒（schedule.kind = "at"）

```json
{
  "action": "add",
  "job": {
    "name": "{任务名}",
    "schedule": { "kind": "at", "atMs": "{当前时间戳ms + N*60000}" },
    "sessionTarget": "isolated",
    "wakeMode": "now",
    "deleteAfterRun": true,
    "payload": {
      "kind": "agentTurn",
      "message": "你是一个暖心的提醒助手。请用温暖、有趣的方式提醒用户：{提醒内容}。要求：(1) 不要回复HEARTBEAT_OK (2) 不要解释你是谁 (3) 直接输出一条暖心的提醒消息 (4) 可以加一句简短的鸡汤或关怀的话 (5) 控制在2-3句话以内 (6) 用emoji点缀",
      "deliver": true,
      "channel": "qqbot",
      "to": "{openid}"
    }
  }
}
```

### 周期提醒（schedule.kind = "cron"）

```json
{
  "action": "add",
  "job": {
    "name": "{任务名}",
    "schedule": { "kind": "cron", "expr": "0 8 * * *", "tz": "Asia/Shanghai" },
    "sessionTarget": "isolated",
    "wakeMode": "now",
    "payload": {
      "kind": "agentTurn",
      "message": "你是一个暖心的提醒助手。请用温暖、有趣的方式提醒用户：{提醒内容}。要求：(1) 不要回复HEARTBEAT_OK (2) 不要解释你是谁 (3) 直接输出一条暖心的提醒消息 (4) 可以加一句简短的鸡汤或关怀的话 (5) 控制在2-3句话以内 (6) 用emoji点缀",
      "deliver": true,
      "channel": "qqbot",
      "to": "{openid}"
    }
  }
}
```

> 周期任务**不加** `deleteAfterRun`。群聊 `to` 格式为 `"group:{group_openid}"`。

---

## cron 表达式速查

| 场景           | expr             |
| -------------- | ---------------- |
| 每天早上8点    | `"0 8 * * *"`    |
| 每天晚上10点   | `"0 22 * * *"`   |
| 工作日早上9点  | `"0 9 * * 1-5"`  |
| 每周一早上9点  | `"0 9 * * 1"`    |
| 每周末上午10点 | `"0 10 * * 0,6"` |
| 每小时整点     | `"0 * * * *"`    |

> 周期提醒必须加 `"tz": "Asia/Shanghai"`。

---

## AI 决策指南

| 用户说法            | action           | time 格式       |
| ------------------- | ---------------- | --------------- |
| "5分钟后提醒我喝水" | `add`            | `"5m"`          |
| "1小时后提醒开会"   | `add`            | `"1h"`          |
| "每天8点提醒我打卡" | `add`            | `"0 8 * * *"`   |
| "工作日早上9点提醒" | `add`            | `"0 9 * * 1-5"` |
| "我有哪些提醒"      | `list`           | —               |
| "取消喝水提醒"      | `remove`         | —               |
| "修改提醒时间"      | `remove` → `add` | —               |
| "提醒我"（无时间）  | **需追问**       | —               |

纯相对时间（"5分钟后"、"1小时后"）可直接计算，无需确认。时间模糊或缺失时需追问。

---

## 回复模板

- 一次性：`⏰ 好的，{时间}后提醒你{内容}~`
- 周期：`⏰ 收到，{周期}提醒你{内容}~`
- 查询无结果：`📋 目前没有提醒哦~ 说"5分钟后提醒我xxx"试试？`
- 删除成功：`✅ 已取消"{名称}"`
