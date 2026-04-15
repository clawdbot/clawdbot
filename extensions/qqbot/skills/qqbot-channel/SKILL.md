---
name: qqbot-channel
description: QQ 频道管理技能。查询频道列表、子频道、成员、发帖、公告、日程等操作。使用 qqbot_channel_api 工具代理 QQ 开放平台 HTTP 接口，自动处理 Token 鉴权。当用户需要查看频道、管理子频道、查询成员、发布帖子/公告/日程时使用。
metadata: { "openclaw": { "emoji": "📡", "requires": { "config": ["channels.qqbot"] } } }
---

# QQ 频道 API 请求指导

`qqbot_channel_api` 是一个 QQ 开放平台 HTTP 代理工具，**自动填充鉴权 Token**。你只需要指定 HTTP 方法、API 路径、请求体和查询参数。

## 📚 详细参考文档

每个接口的完整参数说明、返回值结构和枚举值定义：

- `references/api_references.md`

---

## 🔧 工具参数

| 参数     | 类型   | 必填 | 说明                                                                         |
| -------- | ------ | ---- | ---------------------------------------------------------------------------- |
| `method` | string | 是   | HTTP 方法：`GET`, `POST`, `PUT`, `PATCH`, `DELETE`                           |
| `path`   | string | 是   | API 路径（不含域名），如 `/guilds/{guild_id}/channels`，需替换占位符为实际值 |
| `body`   | object | 否   | 请求体 JSON（POST/PUT/PATCH 使用）                                           |
| `query`  | object | 否   | URL 查询参数键值对，值为字符串类型                                           |

> 基础 URL：`https://api.sgroup.qq.com`，鉴权头 `Authorization: QQBot {token}` 由工具自动填充。

---

## ⭐ 接口速查

### 频道（Guild）

| 操作              | 方法  | 路径                                | 参数说明                                   |
| ----------------- | ----- | ----------------------------------- | ------------------------------------------ |
| 获取频道列表      | `GET` | `/users/@me/guilds`                 | query: `before`, `after`, `limit`(最大100) |
| 获取频道 API 权限 | `GET` | `/guilds/{guild_id}/api_permission` | —                                          |

### 子频道（Channel）

| 操作           | 方法     | 路径                          | 参数说明                                                                                                                                  |
| -------------- | -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 获取子频道列表 | `GET`    | `/guilds/{guild_id}/channels` | —                                                                                                                                         |
| 获取子频道详情 | `GET`    | `/channels/{channel_id}`      | —                                                                                                                                         |
| 创建子频道     | `POST`   | `/guilds/{guild_id}/channels` | body: `name`\*, `type`\*, `position`\*, `sub_type`, `parent_id`, `private_type`, `private_user_ids`, `speak_permission`, `application_id` |
| 修改子频道     | `PATCH`  | `/channels/{channel_id}`      | body: `name`, `position`, `parent_id`, `private_type`, `speak_permission`（至少一个）                                                     |
| 删除子频道     | `DELETE` | `/channels/{channel_id}`      | ⚠️ 不可逆                                                                                                                                 |

**子频道类型（type）**：`0`=文字, `2`=语音, `4`=分组(position≥2), `10005`=直播, `10006`=应用, `10007`=论坛

### 成员（Member）

| 操作               | 方法  | 路径                                         | 参数说明                                      |
| ------------------ | ----- | -------------------------------------------- | --------------------------------------------- |
| 获取成员列表       | `GET` | `/guilds/{guild_id}/members`                 | query: `after`(首次填0), `limit`(1-400)       |
| 获取成员详情       | `GET` | `/guilds/{guild_id}/members/{user_id}`       | —                                             |
| 获取身份组成员列表 | `GET` | `/guilds/{guild_id}/roles/{role_id}/members` | query: `start_index`(首次填0), `limit`(1-400) |
| 获取在线成员数     | `GET` | `/channels/{channel_id}/online_nums`         | —                                             |

### 公告（Announces）

| 操作     | 方法     | 路径                                        | 参数说明                                                                                         |
| -------- | -------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 创建公告 | `POST`   | `/guilds/{guild_id}/announces`              | body: `message_id`, `channel_id`, `announces_type`(0=成员,1=欢迎), `recommend_channels`(最多3条) |
| 删除公告 | `DELETE` | `/guilds/{guild_id}/announces/{message_id}` | message_id 设 `all` 删除所有                                                                     |

### 论坛（Forum）— 仅私域机器人

| 操作         | 方法     | 路径                                                 | 参数说明                                                                       |
| ------------ | -------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| 获取帖子列表 | `GET`    | `/channels/{channel_id}/threads`                     | —                                                                              |
| 获取帖子详情 | `GET`    | `/channels/{channel_id}/threads/{thread_id}`         | —                                                                              |
| 发表帖子     | `PUT`    | `/channels/{channel_id}/threads`                     | body: `title`\*, `content`\*, `format`(1=文本,2=HTML,3=Markdown,4=JSON，默认3) |
| 删除帖子     | `DELETE` | `/channels/{channel_id}/threads/{thread_id}`         | ⚠️ 不可逆                                                                      |
| 发表评论     | `POST`   | `/channels/{channel_id}/threads/{thread_id}/comment` | body: `thread_author`\*, `content`\*, `thread_create_time`, `image`            |

### 日程（Schedule）

| 操作     | 方法     | 路径                                             | 参数说明                                                                                        |
| -------- | -------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 创建日程 | `POST`   | `/channels/{channel_id}/schedules`               | body: `{ schedule: { name*, start_timestamp*, end_timestamp*, jump_channel_id, remind_type } }` |
| 修改日程 | `PATCH`  | `/channels/{channel_id}/schedules/{schedule_id}` | body: `{ schedule: { name*, start_timestamp*, end_timestamp*, jump_channel_id, remind_type } }` |
| 删除日程 | `DELETE` | `/channels/{channel_id}/schedules/{schedule_id}` | ⚠️ 不可逆                                                                                       |

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

### 删除所有公告

```json
{
  "method": "DELETE",
  "path": "/guilds/123456/announces/all"
}
```

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

成员详情返回的 `user.avatar` 是头像 URL，**必须使用 Markdown 图片语法展示**，让用户直接看到头像图片，而非纯文本链接：

```
成员信息：
· 昵称：{nick}
· 头像：
![头像]({user.avatar})
```

> **禁止**将头像 URL 作为纯文本或超链接展示（如 `查看头像`），必须用 `![描述](URL)` 语法内联显示。频道的 `icon` 字段同理。

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
6. **删除操作不可逆**，请谨慎使用
7. **论坛操作**仅私域机器人可用
8. **子频道分组**（type=4）的 `position` 必须 >= 2
9. **日程操作**有频率限制：单个管理员每天 10 次，单个频道每天 100 次
10. **头像/图标展示**：成员 `user.avatar` 和频道 `icon` 等图片 URL 必须使用 Markdown 图片语法 `![描述](URL)` 展示，禁止作为纯文本或超链接展示
