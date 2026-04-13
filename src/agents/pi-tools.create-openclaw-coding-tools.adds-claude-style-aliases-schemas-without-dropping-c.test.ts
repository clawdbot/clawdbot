import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyXaiModelCompat,
  findUnsupportedSchemaKeywords,
  GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
  XAI_UNSUPPORTED_SCHEMA_KEYWORDS,
} from "../plugin-sdk/provider-tools.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

describe("createOpenClawCodingTools", () => {
  it("does not expose provider-specific message tools", () => {
    const tools = createOpenClawCodingTools({ messageProvider: "discord" });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("discord")).toBe(false);
    expect(names.has("slack")).toBe(false);
    expect(names.has("telegram")).toBe(false);
    expect(names.has("whatsapp")).toBe(false);
  });

  it("filters session tools for sub-agent sessions by default", () => {
    const tools = createOpenClawCodingTools({
      sessionKey: "agent:main:subagent:test",
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("sessions_list")).toBe(false);
    expect(names.has("sessions_history")).toBe(false);
    expect(names.has("sessions_send")).toBe(false);
    expect(names.has("sessions_spawn")).toBe(false);
    expect(names.has("subagents")).toBe(false);

    expect(names.has("read")).toBe(true);
    expect(names.has("exec")).toBe(true);
    expect(names.has("process")).toBe(true);
    expect(names.has("apply_patch")).toBe(false);
  });

  it("uses stored spawnDepth to apply leaf tool policy for flat depth-2 session keys", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-depth-policy-"));
    const storeTemplate = path.join(tmpDir, "sessions-{agentId}.json");
    const storePath = storeTemplate.replaceAll("{agentId}", "main");
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:subagent:flat": {
            sessionId: "session-flat-depth-2",
            updatedAt: Date.now(),
            spawnDepth: 2,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const tools = createOpenClawCodingTools({
      sessionKey: "agent:main:subagent:flat",
      config: {
        session: {
          store: storeTemplate,
        },
        agents: {
          defaults: {
            subagents: {
              maxSpawnDepth: 2,
            },
          },
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("sessions_spawn")).toBe(false);
    expect(names.has("sessions_list")).toBe(false);
    expect(names.has("sessions_history")).toBe(false);
    expect(names.has("subagents")).toBe(false);
  });

  it("supports allow-only sub-agent tool policy", () => {
    const tools = createOpenClawCodingTools({
      sessionKey: "agent:main:subagent:test",
      config: {
        tools: {
          subagents: {
            tools: {
              allow: ["read"],
            },
          },
        },
      },
    });
    expect(tools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("applies tool profiles before allow/deny policies", () => {
    const tools = createOpenClawCodingTools({
      config: { tools: { profile: "messaging" } },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("message")).toBe(true);
    expect(names.has("sessions_send")).toBe(true);
    expect(names.has("sessions_spawn")).toBe(false);
    expect(names.has("exec")).toBe(false);
    expect(names.has("browser")).toBe(false);
  });

  it("expands group shorthands in global tool policy", () => {
    const tools = createOpenClawCodingTools({
      config: { tools: { allow: ["group:fs"] } },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("read")).toBe(true);
    expect(names.has("write")).toBe(true);
    expect(names.has("edit")).toBe(true);
    expect(names.has("exec")).toBe(false);
    expect(names.has("browser")).toBe(false);
  });

  it("expands group shorthands in global tool deny policy", () => {
    const tools = createOpenClawCodingTools({
      config: { tools: { deny: ["group:fs"] } },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("read")).toBe(false);
    expect(names.has("write")).toBe(false);
    expect(names.has("edit")).toBe(false);
    expect(names.has("exec")).toBe(true);
  });

  it("lets agent profiles override global profiles", () => {
    const tools = createOpenClawCodingTools({
      sessionKey: "agent:work:main",
      config: {
        tools: { profile: "coding" },
        agents: {
          list: [{ id: "work", tools: { profile: "messaging" } }],
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("message")).toBe(true);
    expect(names.has("exec")).toBe(false);
    expect(names.has("read")).toBe(false);
  });

  it("removes unsupported JSON Schema keywords for Cloud Code Assist API compatibility", () => {
    const googleTools = createOpenClawCodingTools({
      modelProvider: "google",
      senderIsOwner: true,
    });
    for (const tool of googleTools) {
      const violations = findUnsupportedSchemaKeywords(
        tool.parameters,
        `${tool.name}.parameters`,
        GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
      );
      expect(violations).toEqual([]);
    }
  });

  it("applies xai model compat for direct Grok tool cleanup", () => {
    const xaiTools = createOpenClawCodingTools({
      modelProvider: "xai",
      modelCompat: applyXaiModelCompat({ compat: {} }).compat,
      senderIsOwner: true,
    });

    expect(xaiTools.some((tool) => tool.name === "web_search")).toBe(false);
    for (const tool of xaiTools) {
      const violations = findUnsupportedSchemaKeywords(
        tool.parameters,
        `${tool.name}.parameters`,
        XAI_UNSUPPORTED_SCHEMA_KEYWORDS,
      );
      expect(
        violations.filter((violation) => {
          const keyword = violation.split(".").at(-1) ?? "";
          return XAI_UNSUPPORTED_SCHEMA_KEYWORDS.has(keyword);
        }),
      ).toEqual([]);
    }
  });
});
