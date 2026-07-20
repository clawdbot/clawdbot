/**
 * Gateway agent-list RPC regression tests.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { listGatewayAgentsBasic } from "./agent-list.js";

describe("listGatewayAgentsBasic", () => {
  it("omits reserved system-agent state directories from the discovered roster", async () => {
    await withStateDirEnv("openclaw-agent-list-", async ({ stateDir }) => {
      await Promise.all(
        ["openclaw", "crestodian", "research"].map((id) =>
          fs.mkdir(path.join(stateDir, "agents", id), { recursive: true }),
        ),
      );

      const result = listGatewayAgentsBasic({});

      expect(result.agents.map((agent) => agent.id)).toEqual(["main", "research"]);
    });
  });

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
