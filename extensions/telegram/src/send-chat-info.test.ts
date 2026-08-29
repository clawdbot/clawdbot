// Telegram tests cover read-only chat introspection projection behavior.
import { describe, expect, it } from "vitest";
import {
  boundTelegramAdministrators,
  projectTelegramChatInfo,
  projectTelegramChatMember,
} from "./send-chat-info.js";

describe("projectTelegramChatInfo", () => {
  it("projects only the allowlisted chat fields and drops PII", () => {
    const projection = projectTelegramChatInfo({
      id: -1001,
      type: "supergroup",
      title: "Ops Group",
      username: "ops_group",
      members_count: 42,
      is_forum: true,
      bio: "should not appear",
      description: "also should not appear",
      pinned_message: { message_id: 5, text: "Read the runbook", date: 1 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(projection).toEqual({
      id: -1001,
      type: "supergroup",
      title: "Ops Group",
      username: "ops_group",
      membersCount: 42,
      isForum: true,
      pinnedMessageText: "Read the runbook",
    });
    expect(JSON.stringify(projection)).not.toContain("bio");
    expect(JSON.stringify(projection)).not.toContain("description");
  });

  it("bounds title and pinned message text length", () => {
    const longTitle = "x".repeat(500);
    const longPinned = "y".repeat(500);
    const projection = projectTelegramChatInfo({
      id: 1,
      type: "group",
      title: longTitle,
      pinned_message: { message_id: 1, text: longPinned, date: 1 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(projection.title?.length).toBeLessThanOrEqual(200);
    expect(projection.pinnedMessageText?.length).toBeLessThanOrEqual(200);
  });

  it("omits optional fields when the source chat lacks them", () => {
    const projection = projectTelegramChatInfo({
      id: 7,
      type: "private",
      first_name: "Alice",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(projection).toEqual({ id: 7, type: "private" });
  });
});

describe("projectTelegramChatMember", () => {
  it("projects a member with only allowlisted user fields", () => {
    const projection = projectTelegramChatMember({
      status: "member",
      user: {
        id: 999,
        is_bot: false,
        first_name: "Alice",
        last_name: "Smith",
        username: "alice",
        language_code: "en",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(projection).toEqual({
      status: "member",
      userId: 999,
      isBot: false,
      displayName: "Alice Smith",
    });
    expect(JSON.stringify(projection)).not.toContain("username");
    expect(JSON.stringify(projection)).not.toContain("language_code");
  });

  it("surfaces administrator privileges and custom title", () => {
    const projection = projectTelegramChatMember({
      status: "administrator",
      user: { id: 2, is_bot: true, first_name: "Bot" },
      is_anonymous: false,
      custom_title: "Relay",
      can_manage_chat: true,
      can_delete_messages: true,
      can_restrict_members: false,
      can_promote_members: false,
      can_change_info: true,
      can_invite_users: true,
      can_pin_messages: undefined,
      can_manage_topics: undefined,
      can_post_messages: undefined,
      can_edit_messages: undefined,
      can_be_edited: true,
      can_manage_video_chats: false,
      can_post_stories: true,
      can_edit_stories: false,
      can_delete_stories: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(projection.status).toBe("administrator");
    expect(projection.isAnonymous).toBe(false);
    expect(projection.customTitle).toBe("Relay");
    expect(projection.privileges).toEqual({
      can_manage_chat: true,
      can_delete_messages: true,
      can_restrict_members: false,
      can_promote_members: false,
      can_change_info: true,
      can_invite_users: true,
    });
    // Non-allowlisted admin booleans are not surfaced.
    expect(JSON.stringify(projection.privileges)).not.toContain("can_post_stories");
    expect(JSON.stringify(projection.privileges)).not.toContain("can_be_edited");
  });
});

describe("boundTelegramAdministrators", () => {
  it("returns the full roster when it fits the cap", () => {
    const administrators = [
      { status: "creator", user: { id: 1, is_bot: false, first_name: "Owner" } },
    ];
    const result = boundTelegramAdministrators(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      administrators as any,
    );

    expect(result.members).toHaveLength(1);
    expect(result.truncatedCount).toBe(0);
  });

  it("truncates an oversized roster and reports the dropped count", () => {
    // Telegram groups can carry large admin lists; the projection owner must
    // bound the collection, not just per-field strings.
    const administrators = Array.from({ length: 50 }, (_, index) => ({
      status: "administrator",
      user: { id: index + 1, is_bot: false, first_name: `Admin ${index + 1}` },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;

    const result = boundTelegramAdministrators(administrators);

    expect(result.members.length).toBeLessThanOrEqual(20);
    expect(result.truncatedCount).toBe(30);
    // Only the first 20 administrators are surfaced; the rest are dropped.
    expect(result.members[0].userId).toBe(1);
    expect(result.members[19].userId).toBe(20);
  });
});
