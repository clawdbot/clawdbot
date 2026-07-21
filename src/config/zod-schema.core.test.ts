import { describe, expect, it } from "vitest";
import { GroupChatSchema } from "./zod-schema.core.js";

describe("GroupChatSchema", () => {
  it("accepts historyLimit: 0", () => {
    const result = GroupChatSchema.unwrap().safeParse({ historyLimit: 0 });
    expect(result.success).toBe(true);
  });

  it("accepts a positive historyLimit", () => {
    const result = GroupChatSchema.unwrap().safeParse({ historyLimit: 50 });
    expect(result.success).toBe(true);
  });

  it("rejects a negative historyLimit", () => {
    const result = GroupChatSchema.unwrap().safeParse({ historyLimit: -1 });
    expect(result.success).toBe(false);
  });
});
