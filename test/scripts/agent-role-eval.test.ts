import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_ROLE_CONTRACTS,
  AGENT_ROLE_CONTRACT_BY_ID,
  DEFAULT_SELF_CONTAINED_LIVE_PARAMS,
  DEFAULT_SELF_CONTAINED_LIVE_MODEL,
  createSelfContainedLiveEvalEnvironment,
  defaultConfigPath,
  evaluateAgentLiveText,
  evaluateAgentRoleContractCatalog,
  evaluateAgentStaticContracts,
} from "../../scripts/lib/agent-role-evals.mjs";
import { createScriptTestHarness } from "./test-helpers.ts";

function writeAgentWorkspace(root: string, id: string, body: string) {
  const workspace = path.join(root, `workspace-${id}`);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), body);
  fs.writeFileSync(path.join(workspace, "IDENTITY.md"), body);
  return workspace;
}

function writeAgentDir(root: string, id: string) {
  const agentDir = path.join(root, "state", "agents", id, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

function baseConfig(root: string, agent: Record<string, unknown>) {
  return {
    models: {
      providers: {
        ollama: {
          models: [{ id: "qwen3.5:4b" }, { id: "qwen3.5:9b-q4_K_M" }],
        },
      },
    },
    agents: {
      defaults: {
        model: { primary: "ollama/qwen3.5:4b", fallbacks: [] },
        workspace: path.join(root, "workspace"),
      },
      list: [agent],
    },
  };
}

describe("agent role eval harness", () => {
  const harness = createScriptTestHarness();

  it("keeps role contracts unique and covers critical agents", () => {
    const ids = AGENT_ROLE_CONTRACTS.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(AGENT_ROLE_CONTRACT_BY_ID.has("main")).toBe(true);
    expect(AGENT_ROLE_CONTRACT_BY_ID.has("judge")).toBe(true);
    expect(AGENT_ROLE_CONTRACT_BY_ID.has("memory-knowledge-curator")).toBe(true);
    expect(AGENT_ROLE_CONTRACT_BY_ID.has("session-steward")).toBe(true);
    expect(AGENT_ROLE_CONTRACT_BY_ID.has("credential-steward")).toBe(true);
    expect(AGENT_ROLE_CONTRACT_BY_ID.has("openbrain-local-smoke")).toBe(true);
  });

  it("passes the deterministic checked-in contract catalog gate", () => {
    const result = evaluateAgentRoleContractCatalog();

    expect(result).toMatchObject({
      ok: true,
      contractCount: AGENT_ROLE_CONTRACTS.length,
      criticalContractCount: 10,
      issues: [],
    });
  });

  it("prompts Session Steward evals to enforce session boundaries", () => {
    const contract = AGENT_ROLE_CONTRACT_BY_ID.get("session-steward")!;

    expect(contract.prompt).toContain("session");
    expect(contract.prompt).toContain("boundary");
    expect(contract.prompt).toContain("approval");
    expect(contract.prompt).toContain("redact");
    expect(contract.prompt).toContain("telemetry");
    expect(contract.prompt).toContain("Unknown");
    expect(contract.prompt).toContain("exact session-boundary decision");
    expect(contract.prompt).toContain("cross-session mutation");
  });

  it("prompts Credential Steward evals to enforce credential redaction", () => {
    const contract = AGENT_ROLE_CONTRACT_BY_ID.get("credential-steward")!;

    expect(contract.prompt).toContain("credential");
    expect(contract.prompt).toContain("secret");
    expect(contract.prompt).toContain("token");
    expect(contract.prompt).toContain("redact");
    expect(contract.prompt).toContain("approval");
    expect(contract.prompt).toContain("telemetry");
    expect(contract.prompt).toContain("Unknown");
    expect(contract.prompt).toContain("exact credential-exposure decision");
    expect(contract.prompt).toContain("avoid raw credential material");
  });

  it("prompts live evals to emit exact role signals", () => {
    const contract = AGENT_ROLE_CONTRACT_BY_ID.get("program-manager")!;

    expect(contract.prompt).toContain("Use at least two exact role signal terms");
    expect(contract.prompt).toContain("Put one exact role signal in ROLE");
    expect(contract.prompt).toContain("do not use slash commands as content");
    expect(contract.prompt).toContain("BLOCKED: <reason>");
    expect(contract.prompt).toContain(
      "Copy these five non-empty lines with each label on its own line",
    );
    expect(contract.prompt).toContain("Stop immediately after the BLOCK_OR_ESCALATE line");
    expect(contract.prompt).toContain("milestone, owner, acceptance, status, dependency");
  });

  it("creates a self-contained live eval state that passes static checks", () => {
    const contract = AGENT_ROLE_CONTRACT_BY_ID.get("judge")!;
    const fixture = createSelfContainedLiveEvalEnvironment([contract], {
      modelRef: DEFAULT_SELF_CONTAINED_LIVE_MODEL,
      keep: true,
    });
    harness.trackTempDir(fixture.root);

    expect(fs.existsSync(fixture.configPath)).toBe(true);
    expect(fixture.env.OPENCLAW_CONFIG_PATH).toBe(fixture.configPath);
    expect(fixture.env.OPENCLAW_STATE_DIR).toBe(fixture.stateDir);
    expect(fixture.config.agents.list[0]?.params).toEqual(DEFAULT_SELF_CONTAINED_LIVE_PARAMS);

    const result = evaluateAgentStaticContracts(fixture.config, {
      stateDir: fixture.stateDir,
    });
    expect(result).toMatchObject({ ok: true, agentCount: 1, issues: [] });
  });

  it("creates self-contained live eval agents using aliased runtime ids", () => {
    const contract = AGENT_ROLE_CONTRACT_BY_ID.get(
      "browser-session-credential-steward-safety-boundary",
    )!;
    const fixture = createSelfContainedLiveEvalEnvironment([contract], {
      modelRef: DEFAULT_SELF_CONTAINED_LIVE_MODEL,
      keep: true,
    });
    harness.trackTempDir(fixture.root);

    expect(fixture.config.agents.list).toHaveLength(1);
    expect(fixture.config.agents.list[0]?.id).toBe("browser-session-credential-steward");
    expect(fixture.config.agents.list[0]?.workspace).toContain(
      "browser-session-credential-steward",
    );

    const result = evaluateAgentStaticContracts(fixture.config, {
      stateDir: fixture.stateDir,
    });
    expect(result).toMatchObject({ ok: true, agentCount: 1, issues: [] });
  });

  it("defaults agent eval config lookup to the canonical OpenClaw config path", () => {
    expect(defaultConfigPath("/tmp/home", {})).toBe("/tmp/home/.openclaw/openclaw.json");
    expect(defaultConfigPath("/tmp/home", { OPENCLAW_STATE_DIR: "/tmp/state" })).toBe(
      "/tmp/state/openclaw.json",
    );
    expect(
      defaultConfigPath("/tmp/home", {
        OPENCLAW_CONFIG_PATH: "/tmp/custom/openclaw.json",
        OPENCLAW_STATE_DIR: "/tmp/state",
      }),
    ).toBe("/tmp/custom/openclaw.json");
  });

  it("passes a configured agent with docs, runtime dir, model, and callable tools", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const id = "program-manager";
    const workspace = writeAgentWorkspace(
      root,
      id,
      "Program Manager owns milestone planning, owners, acceptance criteria, dependencies, and status.",
    );
    const agentDir = writeAgentDir(root, id);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id,
        name: "Program Manager",
        workspace,
        agentDir,
        model: { primary: "ollama/qwen3.5:4b", fallbacks: [] },
      }),
      { stateDir: path.join(root, "state") },
    );

    expect(result).toMatchObject({ ok: true, agentCount: 1, issues: [] });
  });

  it("uses canonical OpenClaw state dir for omitted agentDir", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const homeDir = path.join(root, "home");
    const id = "program-manager";
    const workspace = writeAgentWorkspace(
      root,
      id,
      "Program Manager owns milestone planning, owners, acceptance criteria, dependencies, and status.",
    );
    fs.mkdirSync(path.join(homeDir, ".openclaw", "agents", id, "agent"), { recursive: true });

    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id,
        name: "Program Manager",
        workspace,
        model: { primary: "ollama/qwen3.5:4b", fallbacks: [] },
      }),
      { homeDir },
    );

    expect(result.issues).not.toContainEqual(
      expect.objectContaining({ agentId: id, code: "agent_dir_missing" }),
    );
    expect(result).toMatchObject({ ok: true, agentCount: 1, issues: [] });
  });

  it("fails unknown agents so every configured role needs an eval contract", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const id = "new-agent-without-contract";
    const workspace = writeAgentWorkspace(root, id, "New Agent Without Contract");
    const agentDir = writeAgentDir(root, id);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id,
        name: "New Agent Without Contract",
        workspace,
        agentDir,
      }),
      { stateDir: path.join(root, "state") },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ agentId: id, code: "contract_missing" }),
    );
  });

  it("fails unconfigured primary model references", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const id = "program-manager";
    const workspace = writeAgentWorkspace(
      root,
      id,
      "Program Manager owns milestone planning, owners, acceptance criteria, dependencies, and status.",
    );
    const agentDir = writeAgentDir(root, id);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id,
        name: "Program Manager",
        workspace,
        agentDir,
        model: { primary: "ollama/not-configured", fallbacks: [] },
      }),
      { stateDir: path.join(root, "state") },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ agentId: id, code: "primary_model_unconfigured" }),
    );
  });

  it("detects tool policies that remove every callable tool", () => {
    const root = harness.createTempDir("openclaw-agent-eval-");
    const id = "openbrain-local-smoke";
    const workspace = writeAgentWorkspace(
      root,
      id,
      "OpenBrain Local Smoke verifies local model session smoke.",
    );
    const agentDir = writeAgentDir(root, id);
    const result = evaluateAgentStaticContracts(
      baseConfig(root, {
        id,
        name: "OpenBrain Local Smoke",
        workspace,
        agentDir,
        model: { primary: "ollama/qwen3.5:4b", fallbacks: [] },
        tools: { profile: "minimal", deny: ["session_status"] },
      }),
      { stateDir: path.join(root, "state") },
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ agentId: id, code: "tool_policy_empty" }),
    );
  });

  it("scores live response text against role and truthfulness signals", () => {
    const contract = AGENT_ROLE_CONTRACT_BY_ID.get("judge")!;

    expect(
      evaluateAgentLiveText(
        contract,
        [
          "ROLE: verdict evidence",
          "EVIDENCE: evidence was reviewed",
          "RISK: risk remains until the claim is verified",
          "NEXT_ACTION: approve or reject after review",
          "BLOCK_OR_ESCALATE: CLEAR",
        ].join("\n"),
      ).ok,
    ).toBe(true);
    expect(evaluateAgentLiveText(contract, "I do not know my role.").ok).toBe(false);
  });

  it("rejects live responses with slash-command label content", () => {
    const contract = AGENT_ROLE_CONTRACT_BY_ID.get("program-manager")!;
    const result = evaluateAgentLiveText(
      contract,
      [
        "ROLE: milestone owner",
        "EVIDENCE: evidence is pending",
        "RISK: risk remains",
        "NEXT_ACTION: acceptance status",
        "BLOCK_OR_ESCALATE: /no_think",
      ].join("\n"),
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContain("slash command content is not allowed in BLOCK_OR_ESCALATE:");
  });

  it("rejects duplicated live response labels", () => {
    const contract = AGENT_ROLE_CONTRACT_BY_ID.get("program-manager")!;
    const result = evaluateAgentLiveText(
      contract,
      [
        "ROLE: milestone owner",
        "EVIDENCE: evidence is pending",
        "RISK: risk remains",
        "NEXT_ACTION: acceptance status",
        "BLOCK_OR_ESCALATE: CLEAR",
        "ROLE: dependency owner",
      ].join("\n"),
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toContain("live response must be exactly 5 non-empty lines");
    expect(result.issues).toContain("duplicate live response label: ROLE:");
  });
});
