/**
 * Gateway agent-list RPC regression tests.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  listGatewayAgentsBasic,
  matchesLegacyGatewaySessionRoutingContract,
} from "./agent-list.js";

describe("listGatewayAgentsBasic", () => {
  it("projects sole, retained-legacy, and explicit fleet ownership honestly", async () => {
    await withStateDirEnv("openclaw-agent-list-", async () => {
      expect(listGatewayAgentsBasic({ agents: { entries: { ops: {} } } })).toMatchObject({
        defaultId: "ops",
        ownership: "sole",
        selectionRequired: false,
        sessionRoutingContract: "per-sender|main|ops",
      });

      const legacy = retainLegacyDefaultAgentId(
        { agents: { entries: { first: {}, retired: {}, research: {} } } },
        "retired",
      );
      expect(listGatewayAgentsBasic(legacy)).toMatchObject({
        defaultId: "retired",
        ownership: "legacy",
        selectionRequired: false,
        sessionRoutingContract: "per-sender|main|retired",
      });

      expect(
        listGatewayAgentsBasic({
          agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
        }),
      ).toMatchObject({
        defaultId: "ops",
        ownership: "explicit",
        selectionRequired: true,
        sessionRoutingContract: "per-sender|main|unowned",
      });
    });
  });

  it("accepts only the released projection for canonical explicit agent targets", () => {
    const cfg: OpenClawConfig = {
      session: { scope: "per-sender", mainKey: "main" },
      agents: { ownership: "explicit", entries: { main: {}, research: {} } },
    };

    for (const agentId of ["main", "research"]) {
      expect(
        matchesLegacyGatewaySessionRoutingContract({
          cfg,
          expectedContract: "per-sender|main|main",
          agentId,
          sessionKey: `agent:${agentId}:main`,
        }),
      ).toBe(true);
    }
    expect(
      matchesLegacyGatewaySessionRoutingContract({
        cfg,
        expectedContract: "per-sender|main|research",
        agentId: "research",
        sessionKey: "agent:research:main",
      }),
    ).toBe(false);
    expect(
      matchesLegacyGatewaySessionRoutingContract({
        cfg,
        expectedContract: "per-sender|main|main",
        agentId: "main",
        sessionKey: "main",
      }),
    ).toBe(false);
    expect(
      matchesLegacyGatewaySessionRoutingContract({
        cfg: { ...cfg, session: { scope: "global", mainKey: "main" } },
        expectedContract: "global|main|main",
        agentId: "main",
        sessionKey: "global",
      }),
    ).toBe(false);
    expect(
      matchesLegacyGatewaySessionRoutingContract({
        cfg: { ...cfg, session: { scope: "per-sender", mainKey: "next" } },
        expectedContract: "per-sender|main|main",
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    ).toBe(false);
    expect(
      matchesLegacyGatewaySessionRoutingContract({
        cfg: { agents: { entries: { main: { default: true } } } },
        expectedContract: "per-sender|main|main",
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    ).toBe(false);
    expect(
      matchesLegacyGatewaySessionRoutingContract({
        cfg,
        expectedContract: "per-sender|main|main",
        sessionKey: "agent:main:main",
      }),
    ).toBe(false);
    expect(
      matchesLegacyGatewaySessionRoutingContract({
        cfg: { agents: { ownership: "explicit", entries: { main: {} } } },
        expectedContract: "per-sender|main|main",
        agentId: "research",
        sessionKey: "agent:research:main",
      }),
    ).toBe(false);
  });

  it("retains disk system agents without treating regular disk dirs as roster members", async () => {
    await withStateDirEnv("openclaw-agent-list-", async ({ stateDir }) => {
      await Promise.all(
        ["openclaw", "crestodian", "research"].map((id) =>
          fs.mkdir(path.join(stateDir, "agents", id), { recursive: true }),
        ),
      );

      const result = listGatewayAgentsBasic({
        agents: { entries: { main: { default: true } } },
      });

      expect(result.agents).toEqual([
        { id: "main", kind: "agent", name: undefined },
        { id: "crestodian", kind: "system", name: undefined },
        { id: "openclaw", kind: "system", name: undefined },
      ]);
    });
  });

  it("does not add owner entries without a roster membership source", async () => {
    await withStateDirEnv("openclaw-agent-list-", async () => {
      expect(
        listGatewayAgentsBasic({
          agents: { entries: { main: { default: true } } },
        }).agents,
      ).toEqual([{ id: "main", kind: "agent", name: undefined }]);
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

  it("retains disk-backed system agents beside an explicit roster", async () => {
    await withStateDirEnv("openclaw-agent-list-", async ({ stateDir }) => {
      await Promise.all(
        ["openclaw", "research"].map((id) =>
          fs.mkdir(path.join(stateDir, "agents", id), { recursive: true }),
        ),
      );

      expect(
        listGatewayAgentsBasic({
          agents: { entries: { main: { default: true } } },
        }).agents,
      ).toEqual([
        { id: "main", kind: "agent", name: undefined },
        { id: "openclaw", kind: "system", name: undefined },
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
