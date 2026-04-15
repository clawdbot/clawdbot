import { describe, expect, it } from "vitest";
import { zaloMessageActions } from "./actions.js";
import type { OpenClawConfig } from "./runtime-api.js";

describe("zaloMessageActions.describeMessageTool", () => {
  it("honors the selected Zalo account during discovery", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zalo: {
          enabled: true,
          botToken: "root-token",
          accounts: {
            default: {
              enabled: false,
              botToken: "default-token",
            },
            work: {
              enabled: true,
              botToken: "work-token",
            },
          },
        },
      },
    };

    expect(zaloMessageActions.describeMessageTool?.({ cfg, accountId: "default" })).toBeNull();
    expect(zaloMessageActions.describeMessageTool?.({ cfg, accountId: "work" })).toEqual({
      actions: ["send"],
      capabilities: [],
    });
  });
});
