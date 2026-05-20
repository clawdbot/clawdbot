import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { listGatewayAgentsBasic } from "./agent-list.js";

describe("listGatewayAgentsBasic", () => {
  it("falls back to identity.name when the configured agent name is missing", () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "main" },
      agents: {
        list: [{ id: "main", default: true, identity: { name: "小金" } }],
      },
    };

    const result = listGatewayAgentsBasic(cfg);

    expect(result.agents).toEqual([{ id: "main", name: "小金" }]);
  });

  it("prefers the explicit configured name over identity.name", () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "main" },
      agents: {
        list: [
          {
            id: "main",
            default: true,
            name: "Ops",
            identity: { name: "开发助手" },
          },
        ],
      },
    };

    const result = listGatewayAgentsBasic(cfg);

    expect(result.agents).toEqual([{ id: "main", name: "Ops" }]);
  });

  it("leaves the name unset when neither agents.list[].name nor identity.name is present", () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "main" },
      agents: {
        list: [{ id: "main", default: true, identity: {} }],
      },
    };

    const result = listGatewayAgentsBasic(cfg);

    expect(result.agents).toEqual([{ id: "main", name: undefined }]);
  });
});
