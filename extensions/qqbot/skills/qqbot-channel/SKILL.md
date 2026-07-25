---
name: qqbot-channel
description: QQ channel management skill. Use qqbot_channel_api for explicit QQ channel-management requests; confirm write, delete, and bulk actions before calling authenticated QQ Open Platform endpoints.
metadata: { "openclaw": { "emoji": "📡", "requires": { "config": ["channels.qqbot"] } } }
---

# QQ 频道 API 请求指导

`qqbot_channel_api` 是一个 QQ 开放平台 HTTP 代理工具，**自动填充鉴权 Token**。你只需要指定 HTTP 方法、API 路径、请求体和查询参数。

## 📚 详细参考文档

每个接口的完整参数说明、返回值结构和枚举值定义：

- `references/api_references.md`

---

## 🔧 工具参数

| 参数            | 类型    | 必填 | 说明                                                                         |
| --------------- | ------- | ---- | ---------------------------------------------------------------------------- |
| `method`        | string  | 是   | HTTP 方法：`GET`, `POST`, `PUT`, `PATCH`, `DELETE`                           |
| `path`          | string  | 是   | API 路径（不含域名），如 `/guilds/{guild_id}/channels`，需替换占位符为实际值 |
| `body`          | object  | 否   | 请求体 JSON（POST/PUT/PATCH 使用）                                           |
| `query`         | object  | 否   | URL 查询参数键值对，值为字符串类型                                           |
| `confirmed`     | boolean | 否   | `DELETE` 必须传 `true`，表示用户已确认精确删除目标                           |
| `bulkConfirmed` | boolean | 否   | 批量 `DELETE`（如删除全部公告）必须额外传 `true`                             |

> 基础 URL：`https://api.sgroup.qq.com`，鉴权头 `Authorization: QQBot {token}` 由工具自动填充。

## 🛡️ 安全边界

- 只在用户明确要求管理 QQ 频道、子频道、公告、论坛帖子或日程时调用写入接口。
- `POST`、`PUT`、`PATCH` 和 `DELETE` 会修改真实 QQ 资源。调用前先复述目标频道/子频道/帖子/日程和预期改动；删除、批量删除、公告覆盖等不可逆或大范围操作必须等用户确认后再执行。
- 删除前优先用 `GET`/列表接口查出候选项，让用户选择具体 ID；不要根据模糊名称猜测删除目标。
- `DELETE` 请求必须传 `confirmed: true`，否则工具会拒绝执行。`announces/all` 这样的批量操作还必须传 `bulkConfirmed: true`，只有在用户明确说要删除全部公告并再次确认后才可使用。
- 成员资料、头像 URL、频道图标等属于用户/群组资料。默认只总结必要字段；只有用户要求查看头像/图标或视觉比对时才内联展示图片，不要无关转发头像 URL。

---

## ⭐ 接口速查

### 频道（Guild）

| 操作              | 方法  | 路径                                | 参数说明                                   |
| ----------------- | ----- | ----------------------------------- | ------------------------------------------ |
| 获取频道列表      | `GET` | `/users/@me/guilds`                 | query: `before`, `after`, `limit`(最大100) |
| 获取频道 API 权限 | `GET` | `/guilds/{guild_id}/api_permission` | —                                          |

### 子频道（Channel）

| 操作           | 方法    | 路径                          | 参数说明                                                                                                                                  |
| -------------- | ------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 获取子频道列表 | `GET`   | `/guilds/{guild_id}/channels` | —                                                                                                                                         |
| 获取子频道详情 | `GET`   | `/channels/{channel_id}`      | —                                                                                                                                         |
| 创建子频道     | `POST`  | `/guilds/{guild_id}/channels` | body: `name`\*, `type`\*, `position`\*, `sub_type`, `parent_id`, `private_type`, `private_user_ids`, `speak_permission`, `application_id` |
| 修改子频道     | `PATCH` | `/channels/{channel_id}`      | body: `name`, `position`, `parent_id`, `private_type`, `speak_permission`（至少一个）                                                     |
| 删除子频道     | —       | 见受确认保护的删除流程        | 破坏性操作；不要在未确认时调用                                                                                                            |

**子频道类型（type）**：`0`=文字, `2`=语音, `4`=分组(position≥2), `10005`=直播, `10006`=应用, `10007`=论坛

### 成员（Member）

| 操作               | 方法  | 路径                                         | 参数说明                                      |
| ------------------ | ----- | -------------------------------------------- | --------------------------------------------- |
| 获取成员列表       | `GET` | `/guilds/{guild_id}/members`                 | query: `after`(首次填0), `limit`(1-400)       |
| 获取成员详情       | `GET` | `/guilds/{guild_id}/members/{user_id}`       | —                                             |
| 获取身份组成员列表 | `GET` | `/guilds/{guild_id}/roles/{role_id}/members` | query: `start_index`(首次填0), `limit`(1-400) |
| 获取在线成员数     | `GET` | `/channels/{channel_id}/online_nums`         | —                                             |

### 公告（Announces）

| 操作     | 方法   | 路径                           | 参数说明                                                                                         |
| -------- | ------ | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| 创建公告 | `POST` | `/guilds/{guild_id}/announces` | body: `message_id`, `channel_id`, `announces_type`(0=成员,1=欢迎), `recommend_channels`(最多3条) |
| 删除公告 | —      | 见受确认保护的删除流程         | 破坏性操作；批量删除需二次确认                                                                   |

### 论坛（Forum）— 仅私域机器人

| 操作         | 方法   | 路径                                                 | 参数说明                                                                       |
| ------------ | ------ | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| 获取帖子列表 | `GET`  | `/channels/{channel_id}/threads`                     | —                                                                              |
| 获取帖子详情 | `GET`  | `/channels/{channel_id}/threads/{thread_id}`         | —                                                                              |
| 发表帖子     | `PUT`  | `/channels/{channel_id}/threads`                     | body: `title`\*, `content`\*, `format`(1=文本,2=HTML,3=Markdown,4=JSON，默认3) |
| 删除帖子     | —      | 见受确认保护的删除流程                               | 破坏性操作；不要在未确认时调用                                                 |
| 发表评论     | `POST` | `/channels/{channel_id}/threads/{thread_id}/comment` | body: `thread_author`\*, `content`\*, `thread_create_time`, `image`            |

### 日程（Schedule）

| 操作     | 方法    | 路径                                             | 参数说明                                                                                        |
| -------- | ------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 创建日程 | `POST`  | `/channels/{channel_id}/schedules`               | body: `{ schedule: { name*, start_timestamp*, end_timestamp*, jump_channel_id, remind_type } }` |
| 修改日程 | `PATCH` | `/channels/{channel_id}/schedules/{schedule_id}` | body: `{ schedule: { name*, start_timestamp*, end_timestamp*, jump_channel_id, remind_type } }` |
| 删除日程 | —       | 见受确认保护的删除流程                           | 破坏性操作；不要在未确认时调用                                                                  |

**提醒类型（remind_type）**：`"0"`=不提醒, `"1"`=开始时, `"2"`=5分钟前, `"3"`=15分钟前, `"4"`=30分钟前, `"5"`=60分钟前

> `*` 表示必填参数

---

## 💡 调用示例

### 获取频道列表

```json
{
  "method": "GET",
  "path": "/users/@me/guilds",
  "query": { "limit": "100" }
}
```

### 获取子频道列表

```json
{
  "method": "GET",
  "path": "/guilds/123456/channels"
}
```

### 创建子频道

```json
{
  "method": "POST",
  "path": "/guilds/123456/channels",
  "body": {
    "name": "新频道",
    "type": 0,
    "position": 1,
    "sub_type": 0
  }
}
```

### 获取成员列表（分页）

```json
{
  "method": "GET",
  "path": "/guilds/123456/members",
  "query": { "after": "0", "limit": "100" }
}
```

### 发表论坛帖子

```json
{
  "method": "PUT",
  "path": "/channels/789012/threads",
  "body": {
    "title": "公告标题",
    "content": "# 标题\n\n公告内容",
    "format": 3
  }
}
```

### 创建日程

```json
{
  "method": "POST",
  "path": "/channels/456789/schedules",
  "body": {
    "schedule": {
      "name": "周会",
      "start_timestamp": "1770733800000",
      "end_timestamp": "1770737400000",
      "remind_type": "2"
    }
  }
}
```

### 创建推荐子频道公告

```json
{
  "method": "POST",
  "path": "/guilds/123456/announces",
  "body": {
    "announces_type": 0,
    "recommend_channels": [{ "channel_id": "789012", "introduce": "欢迎来到攻略频道" }]
  }
}
```

### 受确认保护的删除流程

删除类 QQ API 不作为普通速查示例暴露。若用户明确要求删除资源，先读取并复述目标对象，确认后再调用 `qqbot_channel_api`：`method` 设为 `"DELETE"`，`confirmed` 设为 `true`，`path` 使用已确认对象对应的资源路径。

| 删除对象 | 已确认后使用的 `path`                            | 额外要求                                 |
| -------- | ------------------------------------------------ | ---------------------------------------- |
| 子频道   | `/channels/{channel_id}`                         | 确认子频道 ID 和名称                     |
| 单条公告 | `/guilds/{guild_id}/announces/{message_id}`      | 确认公告 ID                              |
| 全部公告 | `/guilds/{guild_id}/announces/all`               | 用户再次确认后再传 `bulkConfirmed: true` |
| 帖子     | `/channels/{channel_id}/threads/{thread_id}`     | 确认帖子 ID、标题/作者                   |
| 日程     | `/channels/{channel_id}/schedules/{schedule_id}` | 确认日程 ID、名称/时间                   |

---

## 🔄 常用操作流程

### 获取频道和子频道信息

```
1. GET /users/@me/guilds → 获取频道列表，拿到 guild_id
2. GET /guilds/{guild_id}/channels → 获取子频道列表，拿到 channel_id
3. GET /channels/{channel_id} → 获取子频道详情
```

### 论坛发帖 + 评论

```
1. GET /guilds/{guild_id}/channels → 找到论坛子频道（type=10007）
2. PUT /channels/{channel_id}/threads → 发表帖子
3. GET /channels/{channel_id}/threads → 获取帖子列表
4. GET /channels/{channel_id}/threads/{thread_id} → 获取帖子详情（含 author_id）
5. POST /channels/{channel_id}/threads/{thread_id}/comment → 发表评论
```

### 成员管理

```
1. GET /users/@me/guilds → 获取 guild_id
2. GET /guilds/{guild_id}/members?after=0&limit=100 → 获取成员列表
   翻页：用上次最后一个 user.id 作为 after，直到返回空数组
3. GET /guilds/{guild_id}/members/{user_id} → 获取指定成员详情
```

### 展示成员头像

成员详情返回的 `user.avatar` 是头像 URL。默认只展示昵称、ID、加入时间等必要字段；当用户明确要求查看头像/图标或头像是当前任务的必要依据时，再用 Markdown 图片语法内联展示：

```
成员信息：
· 昵称：{nick}
· 头像：
![头像]({user.avatar})
```

不要无关输出原始头像 URL 或把头像作为普通链接转发。频道的 `icon` 字段同理：仅在用户明确需要查看时展示。

---

## 🚨 错误码处理

| 错误码     | 说明             | 解决方案                                                                              |
| ---------- | ---------------- | ------------------------------------------------------------------------------------- |
| **401**    | Token 鉴权失败   | 检查 AppID 和 ClientSecret 配置                                                       |
| **11241**  | 频道 API 无权限  | 前往 QQ 开放平台申请权限，或调用 `GET /guilds/{guild_id}/api_permission` 查看可用权限 |
| **11242**  | 仅私域机器人可用 | 需在 QQ 开放平台将机器人切换为私域模式                                                |
| **11243**  | 需要管理频道权限 | 确保机器人拥有管理权限                                                                |
| **11281**  | 日程频率限制     | 单管理员/天限 10 次，单频道/天限 100 次                                               |
| **304023** | 推荐子频道超限   | 推荐子频道最多 3 条                                                                   |

---

## ⚠️ 注意事项

1. **路径中的占位符**（如 `{guild_id}`、`{channel_id}`）必须替换为实际值
2. **query 参数的值必须为字符串类型**，如 `{ "limit": "100" }` 而非 `{ "limit": 100 }`
3. **成员列表翻页**时可能返回重复成员，需按 `user.id` 去重
4. **公告**的两种类型（消息公告和推荐子频道公告）会互相顶替
5. **日程**的时间戳为毫秒级字符串
6. **删除操作不可逆**，必须先确认精确目标并传 `confirmed: true`；批量删除需二次确认并传 `bulkConfirmed: true`
7. **论坛操作**仅私域机器人可用
8. **子频道分组**（type=4）的 `position` 必须 >= 2
9. **日程操作**有频率限制：单个管理员每天 10 次，单个频道每天 100 次
10. **头像/图标展示**：成员 `user.avatar` 和频道 `icon` 等图片 URL 属于资料信息；默认总结必要字段，只在用户明确需要查看图片时用 Markdown 图片语法 `![描述](URL)` 展示
