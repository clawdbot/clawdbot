import { describe, expect, it } from "vitest";
import { parseCancel, parseMessage } from "./message-handler.js";

const buf = (obj: unknown): Buffer => Buffer.from(JSON.stringify(obj), "utf-8");

describe("parseMessage", () => {
  it("returns null for non-JSON input", () => {
    expect(parseMessage(Buffer.from("not json", "utf-8"))).toBeNull();
  });

  it("parses the flat format without a template_id (ordinary chat)", () => {
    const msg = parseMessage(buf({ id: 5, message: "hello", user_id: 42, session_id: "s1" }));
    expect(msg).not.toBeNull();
    expect(msg?.historyId).toBe(5);
    expect(msg?.message).toBe("hello");
    expect(msg?.userId).toBe("42");
    expect(msg?.templateId).toBeUndefined();
  });

  it("parses a numeric template_id in the flat format", () => {
    const msg = parseMessage(buf({ id: 5, message: "周报", user_id: 42, template_id: 7 }));
    expect(msg?.templateId).toBe(7);
  });

  it("coerces a numeric-string template_id (PHP/JSON producers vary)", () => {
    const msg = parseMessage(buf({ id: 5, message: "周报", user_id: 42, template_id: "7" }));
    expect(msg?.templateId).toBe(7);
  });

  it.each([0, -1, "", "abc", 3.5])("drops an invalid template_id %p", (value) => {
    const msg = parseMessage(buf({ id: 5, message: "x", user_id: 42, template_id: value }));
    expect(msg?.templateId).toBeUndefined();
  });

  it("reads template_id from the nested body (old format)", () => {
    const msg = parseMessage(
      buf({ id: 9, body: { message: "周报", user_id: 42, template_id: 12 } }),
    );
    expect(msg?.historyId).toBe(9);
    expect(msg?.message).toBe("周报");
    expect(msg?.templateId).toBe(12);
  });

  it("falls back to a top-level template_id when body omits it (old format)", () => {
    const msg = parseMessage(
      buf({ id: 9, template_id: 3, body: { message: "周报", user_id: 42 } }),
    );
    expect(msg?.templateId).toBe(3);
  });

  it("leaves skillIds undefined when absent (ordinary chat)", () => {
    const msg = parseMessage(buf({ id: 5, message: "hello", user_id: 42 }));
    expect(msg?.skillIds).toBeUndefined();
  });

  it("parses a numeric skill_ids array in the flat format", () => {
    const msg = parseMessage(buf({ id: 5, message: "x", user_id: 42, skill_ids: [7, 9] }));
    expect(msg?.skillIds).toEqual([7, 9]);
  });

  it("coerces numeric-string skill ids and preserves order", () => {
    const msg = parseMessage(buf({ id: 5, message: "x", user_id: 42, skill_ids: ["3", 1, "2"] }));
    expect(msg?.skillIds).toEqual([3, 1, 2]);
  });

  it("drops invalid skill ids and de-dupes, keeping valid ones", () => {
    const msg = parseMessage(
      buf({ id: 5, message: "x", user_id: 42, skill_ids: [7, 0, -1, "abc", 3.5, 7, 9] }),
    );
    expect(msg?.skillIds).toEqual([7, 9]);
  });

  it("leaves skillIds undefined when the array has no valid id", () => {
    const msg = parseMessage(buf({ id: 5, message: "x", user_id: 42, skill_ids: [0, "abc"] }));
    expect(msg?.skillIds).toBeUndefined();
  });

  it("caps skill_ids at 20", () => {
    const many = Array.from({ length: 30 }, (_, i) => i + 1);
    const msg = parseMessage(buf({ id: 5, message: "x", user_id: 42, skill_ids: many }));
    expect(msg?.skillIds).toHaveLength(20);
    expect(msg?.skillIds?.[0]).toBe(1);
    expect(msg?.skillIds?.[19]).toBe(20);
  });

  it("reads skill_ids from the nested body (old format)", () => {
    const msg = parseMessage(
      buf({ id: 9, body: { message: "x", user_id: 42, skill_ids: [12, 5] } }),
    );
    expect(msg?.skillIds).toEqual([12, 5]);
  });

  it("falls back to top-level skill_ids when body omits it (old format)", () => {
    const msg = parseMessage(buf({ id: 9, skill_ids: [4], body: { message: "x", user_id: 42 } }));
    expect(msg?.skillIds).toEqual([4]);
  });

  it("parses a selected bundled skill from flat and nested messages", () => {
    const flat = parseMessage(
      buf({
        id: 5,
        message: "诊断",
        user_id: 42,
        builtin_skill_name: "ai-collaboration-diagnostic",
      }),
    );
    const nested = parseMessage(
      buf({
        id: 9,
        body: {
          message: "速报",
          user_id: 42,
          builtin_skill_name: "ai-public-opinion-brief",
        },
      }),
    );
    expect(flat?.builtinSkillName).toBe("ai-collaboration-diagnostic");
    expect(nested?.builtinSkillName).toBe("ai-public-opinion-brief");
  });

  it("accepts administrator-created names without a transport allowlist", () => {
    const msg = parseMessage(
      buf({ id: 5, message: "hello", user_id: 42, builtin_skill_name: "new-public-skill" }),
    );
    expect(msg?.builtinSkillName).toBe("new-public-skill");
  });

  it("drops a malformed bundled skill name without dropping the turn", () => {
    const msg = parseMessage(
      buf({ id: 5, message: "hello", user_id: 42, builtin_skill_name: "../private" }),
    );
    expect(msg).not.toBeNull();
    expect(msg?.builtinSkillName).toBeUndefined();
  });

  it("defaults hasAttachment to false when absent", () => {
    const msg = parseMessage(buf({ id: 5, message: "hello", user_id: 42 }));
    expect(msg?.hasAttachment).toBe(false);
  });

  it("parses has_attachment from the flat format", () => {
    const msg = parseMessage(
      buf({ id: 5, message: "分析这份表", user_id: 42, has_attachment: true }),
    );
    expect(msg?.hasAttachment).toBe(true);
  });

  it("reads has_attachment from the nested body (old format)", () => {
    const msg = parseMessage(
      buf({ id: 9, body: { message: "分析这份表", user_id: 42, has_attachment: true } }),
    );
    expect(msg?.hasAttachment).toBe(true);
  });

  it("parses a valid OSS attachment ref", () => {
    const att = {
      fileId: "abc",
      filename: "data.xlsx",
      ext: "xlsx",
      kind: "spreadsheet",
      storage: "oss",
      ref: "https://oss.leadingnews.cn/ibtai/lobster/attachments/2026/06/abc.xlsx",
      totalDataRows: 1234,
    };
    const msg = parseMessage(buf({ id: 5, message: "分析", user_id: 42, attachments: [att] }));
    expect(msg?.attachments).toHaveLength(1);
    expect(msg?.attachments?.[0].ref).toContain("abc.xlsx");
  });

  it("keeps an original PDF document ref so the consumer can materialize it", () => {
    const att = {
      fileId: "pdf-1",
      filename: "大恒哥.pdf",
      ext: "pdf",
      kind: "document",
      storage: "oss",
      ref: "https://oss.leadingnews.cn/ibtai/lobster/attachments/2026/08/pdf-1.pdf",
      ossKey: "ibtai/lobster/attachments/2026/08/pdf-1.pdf",
    };

    const msg = parseMessage(
      buf({ id: 6, message: "用这份盖章材料发起企业投诉", user_id: 42, attachments: [att] }),
    );

    expect(msg?.attachments).toEqual([att]);
    expect(msg?.attachments?.[0].ossKey).toBe("ibtai/lobster/attachments/2026/08/pdf-1.pdf");
  });

  it("drops a malformed/stale attachment WITHOUT failing the whole message", () => {
    // Old inbox-format ref (storage:'inbox', non-url ref) must not drop the turn.
    const stale = {
      fileId: "x",
      filename: "f.xlsx",
      ext: "xlsx",
      kind: "spreadsheet",
      storage: "inbox",
      ref: "x.xlsx",
    };
    const msg = parseMessage(
      buf({ id: 5, message: "分析这份表", user_id: 42, attachments: [stale] }),
    );
    expect(msg).not.toBeNull();
    expect(msg?.message).toBe("分析这份表");
    expect(msg?.attachments).toBeUndefined();
  });

  it("parses a 证件 image attachment carrying an ossKey", () => {
    const att = {
      fileId: "img1",
      filename: "身份证正面.jpg",
      ext: "jpg",
      kind: "image",
      storage: "oss",
      ref: "https://oss.leadingnews.cn/ibtai/lobster/certs/2026/07/img1.jpg",
      ossKey: "ibtai/lobster/certs/2026/07/img1.jpg",
    };
    const msg = parseMessage(buf({ id: 7, message: "帮我建档", user_id: 42, attachments: [att] }));
    expect(msg?.attachments).toHaveLength(1);
    expect(msg?.attachments?.[0].kind).toBe("image");
    expect(msg?.attachments?.[0].ossKey).toBe("ibtai/lobster/certs/2026/07/img1.jpg");
  });

  it("drops an image attachment missing its ossKey (unusable for save-profile)", () => {
    const att = {
      fileId: "img2",
      filename: "no-key.png",
      ext: "png",
      kind: "image",
      storage: "oss",
      ref: "https://oss.leadingnews.cn/ibtai/lobster/certs/2026/07/img2.png",
    };
    const msg = parseMessage(buf({ id: 8, message: "建档", user_id: 42, attachments: [att] }));
    expect(msg).not.toBeNull();
    expect(msg?.attachments).toBeUndefined();
  });

  it("keeps valid attachments and drops invalid ones in the same message", () => {
    const good = {
      fileId: "g",
      filename: "g.xlsx",
      ext: "xlsx",
      kind: "spreadsheet",
      storage: "oss",
      ref: "https://oss.leadingnews.cn/g.xlsx",
      totalDataRows: 10,
    };
    const bad = { fileId: "b", storage: "inbox" };
    const msg = parseMessage(buf({ id: 5, message: "m", user_id: 42, attachments: [good, bad] }));
    expect(msg?.attachments).toHaveLength(1);
    expect(msg?.attachments?.[0].fileId).toBe("g");
  });
});

describe("parseCancel", () => {
  it("parses a stop envelope without treating it as a chat message", () => {
    const raw = buf({
      type: "cancel",
      id: 17,
      user_id: "42",
      session_id: "window-1",
    });

    expect(parseCancel(raw)).toEqual({
      historyId: 17,
      userId: "42",
      sessionId: "window-1",
    });
    expect(parseMessage(raw)).toBeNull();
  });

  it("rejects malformed stop envelopes", () => {
    expect(parseCancel(buf({ type: "cancel", id: 0, user_id: "42" }))).toBeNull();
    expect(parseCancel(buf({ type: "cancel", id: 17, user_id: "" }))).toBeNull();
  });
});
