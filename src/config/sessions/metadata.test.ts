import { describe, expect, it } from "vitest";

import { deriveSessionMetaPatch } from "./metadata.js";

describe("deriveSessionMetaPatch", () => {
  it("captures origin + group metadata", () => {
    const patch = deriveSessionMetaPatch({
      ctx: {
        Provider: "whatsapp",
        ChatType: "group",
        GroupSubject: "Family",
        From: "123@g.us",
      },
      sessionKey: "agent:main:whatsapp:group:123@g.us",
    });

    expect(patch?.origin?.label).toBe("Family id:123@g.us");
    expect(patch?.origin?.provider).toBe("whatsapp");
    expect(patch?.subject).toBe("Family");
    expect(patch?.channel).toBe("whatsapp");
    expect(patch?.groupId).toBe("123@g.us");
  });
});
