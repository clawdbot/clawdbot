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
  it("retains disk agents and applies owner-contributed kinds", async () => {
    await withStateDirEnv("openclaw-agent-list-", async ({ stateDir }) => {
      await Promise.all(
        ["openclaw", "crestodian", "research"].map((id) =>
          fs.mkdir(path.join(stateDir, "agents", id), { recursive: true }),
        ),
      );

      const result = listGatewayAgentsBasic({});

      expect(result.agents).toEqual([
        { id: "main", kind: "agent", name: undefined },
        { id: "crestodian", kind: "system", name: undefined },
        { id: "openclaw", kind: "system", name: undefined },
        { id: "research", kind: "agent", name: undefined },
      ]);
    });
  });

  it("does not add owner entries without a roster membership source", async () => {
    await withStateDirEnv("openclaw-agent-list-", async () => {
      expect(listGatewayAgentsBasic({}).agents).toEqual([
        { id: "main", kind: "agent", name: undefined },
      ]);
    });
  });

  it("lets configured ownership override disk system metadata", async () => {
    await withStateDirEnv("openclaw-agent-list-", async ({ stateDir }) => {
      await fs.mkdir(path.join(stateDir, "agents", "openclaw"), { recursive: true });
      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", default: true },
            { id: "openclaw", name: "OpenClaw" },
          ],
        },
      };

      expect(listGatewayAgentsBasic(cfg).agents).toEqual([
        { id: "main", kind: "agent", name: undefined },
        { id: "openclaw", kind: "agent", name: "OpenClaw" },
      ]);
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

    expect(result.agents).toEqual([{ id: "main", kind: "agent", name: "小金" }]);
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

    expect(result.agents).toEqual([{ id: "main", kind: "agent", name: "Ops" }]);
  });

  it("leaves the name unset when neither agents.list[].name nor identity.name is present", () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "main" },
      agents: {
        list: [{ id: "main", default: true, identity: {} }],
      },
    };

    const result = listGatewayAgentsBasic(cfg);

    expect(result.agents).toEqual([{ id: "main", kind: "agent", name: undefined }]);
  });
});
