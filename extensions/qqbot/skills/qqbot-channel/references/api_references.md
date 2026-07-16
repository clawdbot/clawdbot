# QQ 频道 API 完整参考

本文档包含 QQ 开放平台频道相关所有接口的详细参数说明、返回值结构和枚举值定义。

通过 `qqbot_channel_api` 工具代理请求，工具自动处理鉴权。

---

## 📌 通用说明

### 基础 URL

`https://api.sgroup.qq.com`

### 鉴权（自动处理）

工具自动填充以下请求头，无需手动设置：

```
Authorization: QQBot {access_token}
Content-Type: application/json
```

### 错误返回格式

```json
{
  "message": "错误描述",
  "code": 错误码
}
```

---

## 📦 返回值类型定义

### Guild（频道）

```typescript
interface Guild {
  id: string; // 频道 ID
  name: string; // 频道名称
  icon: string; // 频道头像 URL
  owner_id: string; // 频道拥有者 ID
  owner: boolean; // 机器人是否为频道拥有者
  joined_at: string; // 机器人加入时间（ISO 8601）
  member_count: number; // 频道成员数
  max_members: number; // 频道最大成员数
  description: string; // 频道描述
}
```

### Channel（子频道）

```typescript
interface Channel {
  id: string; // 子频道 ID
  guild_id: string; // 所属频道 ID
  name: string; // 子频道名称
  type: number; // 子频道类型（见枚举）
  position: number; // 排序位置
  parent_id: string; // 所属分组 ID
  owner_id: string; // 创建者 ID
  sub_type: number; // 子类型（见枚举）
  private_type?: number; // 私密类型（见枚举）
  speak_permission?: number; // 发言权限（见枚举）
  application_id?: string; // 应用子频道 AppID
}
```

### User（用户）

```typescript
interface User {
  id: string; // 用户 ID
  username: string; // 用户名
  avatar: string; // 头像 URL
  bot: boolean; // 是否为机器人
  union_openid?: string; // 特殊关联应用的 openid
  union_user_account?: string; // 特殊关联应用的用户信息
}
```

### Member（成员）

```typescript
interface Member {
  user: User; // 用户基本信息
  nick: string; // 在频道中的昵称
  roles: string[]; // 身份组 ID 列表
  joined_at: string; // 加入频道时间（ISO 8601）
  deaf?: boolean; // 是否被禁言
  mute?: boolean; // 是否被闭麦
  pending?: boolean; // 是否待审核
}
```

### APIPermission（API 权限）

```typescript
interface APIPermission {
  path: string; // 接口路径
  method: string; // 请求方法
  desc: string; // 接口描述
  auth_status: number; // 授权状态：0=未授权, 1=已授权
}
```

### AnnouncesResult（公告结果）

```typescript
interface AnnouncesResult {
  guild_id: string;
  channel_id: string;
  message_id: string;
  announces_type: number;
  recommend_channels: RecommendChannel[];
}

interface RecommendChannel {
  channel_id: string; // 推荐的子频道 ID
  introduce: string; // 推荐语
}
```

### ThreadDetail（帖子详情）

```typescript
interface ThreadDetail {
  thread: {
    guild_id: string;
    channel_id: string;
    author_id: string;
    thread_info: {
      thread_id: string;
      title: string;
      content: string;
      date_time: string;
    };
  };
}
```

### ThreadListResult（帖子列表）

```typescript
interface ThreadListResult {
  threads: Array<{
    guild_id: string;
    channel_id: string;
    author_id: string;
    thread_info: {
      thread_id: string;
      title: string;
      content: string;
      date_time: string;
    };
  }>;
  is_finish: number; // 1=已到底, 0=还有更多
}
```

### Schedule（日程）

```typescript
interface Schedule {
  id?: string;
  name: string;
  start_timestamp: string; // 毫秒级时间戳
  end_timestamp: string;
  jump_channel_id?: string;
  remind_type?: string;
  creator?: {
    user: { id: string; username: string; bot: boolean };
    nick: string;
    joined_at: string;
  };
}
```

---

## 📋 枚举值定义

### 子频道类型（Channel type）

| 值      | 名称       | 说明                             |
| ------- | ---------- | -------------------------------- |
| `0`     | 文字子频道 | 普通文字聊天                     |
| `2`     | 语音子频道 | 语音聊天                         |
| `4`     | 子频道分组 | 组织子频道的分组（position ≥ 2） |
| `10005` | 直播子频道 | 直播功能                         |
| `10006` | 应用子频道 | 需 application_id                |
| `10007` | 论坛子频道 | 论坛功能                         |

### 子频道子类型（Channel sub_type）

| 值  | 名称 |
| --- | ---- |
| `0` | 闲聊 |
| `1` | 公告 |
| `2` | 攻略 |
| `3` | 开黑 |

### 子频道私密类型（Channel private_type）

| 值  | 说明                 |
| --- | -------------------- |
| `0` | 公开子频道           |
| `1` | 管理员和指定成员可见 |
| `2` | 仅管理员可见         |

### 子频道发言权限（Channel speak_permission）

| 值  | 说明                                       |
| --- | ------------------------------------------ |
| `0` | 无效（仅创建公告子频道时有效，此时为只读） |
| `1` | 所有人可发言                               |
| `2` | 仅管理员和指定成员可发言                   |

### 公告类型（announces_type）

| 值  | 说明     |
| --- | -------- |
| `0` | 成员公告 |
| `1` | 欢迎公告 |

### 帖子格式（format）

| 值  | 格式                 |
| --- | -------------------- |
| `1` | 纯文本               |
| `2` | HTML                 |
| `3` | Markdown（**默认**） |
| `4` | JSON（RichText）     |

### 日程提醒类型（remind_type）

| 值    | 说明           |
| ----- | -------------- |
| `"0"` | 不提醒         |
| `"1"` | 开始时提醒     |
| `"2"` | 开始前 5 分钟  |
| `"3"` | 开始前 15 分钟 |
| `"4"` | 开始前 30 分钟 |
| `"5"` | 开始前 60 分钟 |

### API 权限授权状态（auth_status）

| 值  | 说明   |
| --- | ------ |
| `0` | 未授权 |
| `1` | 已授权 |

---

## 📖 各接口详细说明

### GET /users/@me/guilds — 获取频道列表

**查询参数**:

| 参数     | 类型   | 必填 | 说明                                                 |
| -------- | ------ | ---- | ---------------------------------------------------- |
| `before` | string | 否   | 读此 guild id 之前的数据                             |
| `after`  | string | 否   | 读此 guild id 之后的数据（与 before 同时设置时无效） |
| `limit`  | string | 否   | 每次拉取条数，默认 100，最大 100                     |

**返回**: `Guild[]`

**调用示例**:

```json
{ "method": "GET", "path": "/users/@me/guilds", "query": { "limit": "100" } }
```

---

### GET /guilds/{guild_id}/api_permission — 获取频道 API 权限

**返回**: `{ apis: APIPermission[] }`

**调用示例**:

```json
{ "method": "GET", "path": "/guilds/123456/api_permission" }
```

---

### GET /guilds/{guild_id}/channels — 获取子频道列表

**返回**: `Channel[]`

**调用示例**:

```json
{ "method": "GET", "path": "/guilds/123456/channels" }
```

---

### GET /channels/{channel_id} — 获取子频道详情

**返回**: `Channel`

---

### POST /guilds/{guild_id}/channels — 创建子频道

> ⚠️ 仅私域机器人可用，需管理频道权限

**请求体**:

| 参数               | 类型     | 必填 | 说明                                  |
| ------------------ | -------- | ---- | ------------------------------------- |
| `name`             | string   | 是   | 子频道名称                            |
| `type`             | number   | 是   | 子频道类型                            |
| `position`         | number   | 是   | 排序位置（type=4 时 ≥ 2）             |
| `sub_type`         | number   | 否   | 子类型                                |
| `parent_id`        | string   | 否   | 所属分组 ID                           |
| `private_type`     | number   | 否   | 私密类型                              |
| `private_user_ids` | string[] | 否   | 私密成员列表（private_type=1 时有效） |
| `speak_permission` | number   | 否   | 发言权限                              |
| `application_id`   | string   | 否   | 应用 AppID（type=10006 时需要）       |

**返回**: `Channel`

---

### PATCH /channels/{channel_id} — 修改子频道

> ⚠️ 仅私域机器人可用

**请求体**（至少一个）:

| 参数               | 类型   | 说明     |
| ------------------ | ------ | -------- |
| `name`             | string | 名称     |
| `position`         | number | 排序位置 |
| `parent_id`        | string | 分组 ID  |
| `private_type`     | number | 私密类型 |
| `speak_permission` | number | 发言权限 |

**返回**: `Channel`

---

### DELETE /channels/{channel_id} — 删除子频道

> ⚠️ 不可逆！仅私域机器人可用

---

### GET /guilds/{guild_id}/members — 获取成员列表

> 仅私域机器人可用

**查询参数**:

| 参数    | 类型   | 说明                               |
| ------- | ------ | ---------------------------------- |
| `after` | string | 上次最后一个 user.id，首次填 `"0"` |
| `limit` | string | 分页大小 1-400，默认 1             |

**返回**: `Member[]`

> 翻页：用最后一个 `user.id` 作为 `after`，直到返回空数组。可能返回重复成员，需按 `user.id` 去重。

---

### GET /guilds/{guild_id}/members/{user_id} — 获取成员详情

**返回**: `Member`

---

### GET /guilds/{guild_id}/roles/{role_id}/members — 获取身份组成员列表

> 仅私域机器人可用

**查询参数**:

| 参数          | 类型   | 说明                   |
| ------------- | ------ | ---------------------- |
| `start_index` | string | 分页标识，首次填 `"0"` |
| `limit`       | string | 分页大小 1-400，默认 1 |

**返回**: `{ data: Member[], next: string }`

> 翻页：用 `next` 作为 `start_index`，直到 `data` 为空。

---

### GET /channels/{channel_id}/online_nums — 获取在线成员数

**返回**: `{ online_nums: number }`

---

### POST /guilds/{guild_id}/announces — 创建频道公告

**请求体**:

| 参数                 | 类型   | 必填 | 说明                                                |
| -------------------- | ------ | ---- | --------------------------------------------------- |
| `message_id`         | string | 否   | 消息 ID（有值时创建消息公告，此时 channel_id 必填） |
| `channel_id`         | string | 否   | 子频道 ID                                           |
| `announces_type`     | number | 否   | 0=成员公告，1=欢迎公告                              |
| `recommend_channels` | array  | 否   | 推荐子频道列表（最多 3 条，message_id 为空时生效）  |

> 两种公告类型会互相顶替

**返回**: `AnnouncesResult`

---

### DELETE /guilds/{guild_id}/announces/{message_id} — 删除公告

> `message_id` 设为 `all` 删除所有公告

---

### GET /channels/{channel_id}/threads — 获取帖子列表

> 仅私域机器人可用，channel_id 须为论坛子频道（type=10007）

**返回**: `ThreadListResult`

---

### GET /channels/{channel_id}/threads/{thread_id} — 获取帖子详情

> 仅私域机器人可用

**返回**: `ThreadDetail`

---

### PUT /channels/{channel_id}/threads — 发表帖子

> 仅私域机器人可用

**请求体**:

| 参数      | 类型   | 必填 | 说明                                       |
| --------- | ------ | ---- | ------------------------------------------ |
| `title`   | string | 是   | 帖子标题                                   |
| `content` | string | 是   | 帖子内容                                   |
| `format`  | number | 否   | 1=文本, 2=HTML, 3=Markdown（默认）, 4=JSON |

**返回**: `{ task_id: string, create_time: string }`

---

### DELETE /channels/{channel_id}/threads/{thread_id} — 删除帖子

> ⚠️ 不可逆！仅私域机器人可用

---

### POST /channels/{channel_id}/threads/{thread_id}/comment — 发表评论

> 仅私域机器人可用

**请求体**:

| 参数                 | 类型   | 必填 | 说明         |
| -------------------- | ------ | ---- | ------------ |
| `thread_author`      | string | 是   | 帖子作者 ID  |
| `content`            | string | 是   | 评论内容     |
| `thread_create_time` | string | 否   | 帖子创建时间 |
| `image`              | string | 否   | 图片链接     |

**返回**: `{ task_id: string, create_time: number }`

---

### POST /channels/{channel_id}/schedules — 创建日程

> 需要管理频道权限。单管理员/天限 10 次，单频道/天限 100 次。

**请求体**:

```json
{
  "schedule": {
    "name": "日程名称",
    "start_timestamp": "毫秒时间戳",
    "end_timestamp": "毫秒时间戳",
    "jump_channel_id": "0",
    "remind_type": "0"
  }
}
```

| 参数                       | 类型   | 必填 | 说明                      |
| -------------------------- | ------ | ---- | ------------------------- |
| `schedule.name`            | string | 是   | 日程名称                  |
| `schedule.start_timestamp` | string | 是   | 开始时间（毫秒）          |
| `schedule.end_timestamp`   | string | 是   | 结束时间（毫秒）          |
| `schedule.jump_channel_id` | string | 否   | 跳转子频道 ID，默认 `"0"` |
| `schedule.remind_type`     | string | 否   | 提醒类型，默认 `"0"`      |

**返回**: `Schedule`

---

### PATCH /channels/{channel_id}/schedules/{schedule_id} — 修改日程

> 需要管理频道权限

**请求体**：同创建日程

**返回**: `Schedule`

---

### DELETE /channels/{channel_id}/schedules/{schedule_id} — 删除日程

> ⚠️ 不可逆！需要管理频道权限
