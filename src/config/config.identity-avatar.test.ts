import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateConfigObject } from "./config.js";
import { withTempHome } from "./test-helpers.js";

describe("identity avatar validation", () => {
  it("accepts workspace-relative avatar paths", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "clawd");
      const res = validateConfigObject({
        agents: {
          list: [{ id: "main", workspace, identity: { avatar: "avatars/clawd.png" } }],
        },
      });
      expect(res.ok).toBe(true);
    });
  });

  it("accepts http(s) and data avatars", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "clawd");
      const httpRes = validateConfigObject({
        agents: {
          list: [{ id: "main", workspace, identity: { avatar: "https://example.com/avatar.png" } }],
        },
      });
      expect(httpRes.ok).toBe(true);

      const dataRes = validateConfigObject({
        agents: {
          list: [{ id: "main", workspace, identity: { avatar: "data:image/png;base64,AAA" } }],
        },
      });
      expect(dataRes.ok).toBe(true);
    });
  });

  it("rejects avatar paths outside workspace", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "clawd");
      const res = validateConfigObject({
        agents: {
          list: [{ id: "main", workspace, identity: { avatar: "../oops.png" } }],
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues[0]?.path).toBe("agents.list.0.identity.avatar");
      }
    });
  });
});
