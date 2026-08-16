import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  createPlanningKnowledgeCaptureTool,
  createPlanningKnowledgeMaintenanceTool,
  createPlanningKnowledgeSearchTool,
  planningKnowledgeCaptureParameters,
  planningKnowledgeConfigSchema,
  planningKnowledgeMaintenanceParameters,
  resolvePlanningKnowledgeConfig,
} from "./planning-knowledge-tool.js";

const execFileAsync = promisify(execFile);
type PlanningKnowledgeCommandRunner = NonNullable<
  Parameters<typeof createPlanningKnowledgeSearchTool>[1]
>;

const config = {
  scriptPath: "/opt/OneLibrary/Browser-Tracker/scripts/planning_knowledge_index.py",
  sourceRoot: "/tmp/goal-agent/notes/knowledge",
  indexPath: "/tmp/planning-personal.sqlite3",
  pythonExecutable: "python3",
  mode: "text" as const,
  timeoutMs: 5000,
};

const writerConfig = {
  ...config,
  writerScriptPath: "/opt/Goal_Agent/tools/planning/knowledge_notes.py",
};

const maintenanceConfig = {
  ...config,
  maintenanceScriptPath: "/opt/Goal_Agent/tools/planning/knowledge_maintenance.py",
};

const validHit = {
  canonical_ref: "note:notes/knowledge/input_output_balance",
  title: "Input Output Balance",
  snippet: "Learning should be followed by a concrete output.",
  score: 1.2,
  knowledge_type: "principle",
  status: "active",
  verification_status: "reviewed",
  domains: ["lernen"],
  topics: ["learning"],
  project_refs: [],
  goal_refs: [],
  source_type: "human",
  created_at: "2026-08-01",
  updated_at: "2026-08-01",
};

function runnerReturning(payload: unknown): PlanningKnowledgeCommandRunner {
  return vi.fn(async () => ({
    stdout: JSON.stringify(payload),
    exitCode: 0,
  }));
}

describe("planning-knowledge config", () => {
  it("requires an explicit notes/knowledge root before enabling search", () => {
    expect(resolvePlanningKnowledgeConfig({}, (value) => value)).toBeNull();
    expect(() =>
      resolvePlanningKnowledgeConfig(
        { ...config, sourceRoot: "/tmp/goal-agent/notes" },
        (value) => value,
      ),
    ).toThrow(/notes\/knowledge/);
  });

  it("keeps the derived index outside the canonical source", () => {
    expect(() =>
      resolvePlanningKnowledgeConfig(
        { ...config, indexPath: "/tmp/goal-agent/notes/knowledge/index.sqlite3" },
        (value) => value,
      ),
    ).toThrow(/outside/);
  });

  it("declares a strict configuration schema", () => {
    expect(planningKnowledgeConfigSchema).toMatchObject({ additionalProperties: false });
    expect(planningKnowledgeCaptureParameters).toMatchObject({ additionalProperties: false });
    expect(planningKnowledgeMaintenanceParameters).toMatchObject({ additionalProperties: false });
  });

  it("resolves absolute external paths without the plugin-local path resolver", () => {
    const resolvePath = vi.fn(() => undefined);
    const resolved = resolvePlanningKnowledgeConfig(config, resolvePath);

    expect(resolved).toMatchObject({
      scriptPath: config.scriptPath,
      sourceRoot: config.sourceRoot,
      indexPath: config.indexPath,
    });
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it("accepts an explicit Planning-owned writer path", () => {
    const resolved = resolvePlanningKnowledgeConfig(writerConfig, () => undefined);
    expect(resolved).toMatchObject({ writerScriptPath: writerConfig.writerScriptPath });
  });

  it("accepts an explicit read-only maintenance path", () => {
    const resolved = resolvePlanningKnowledgeConfig(maintenanceConfig, () => undefined);
    expect(resolved).toMatchObject({
      maintenanceScriptPath: maintenanceConfig.maintenanceScriptPath,
    });
  });

  it("fails closed when a relative path is outside the plugin resolver boundary", () => {
    expect(() =>
      resolvePlanningKnowledgeConfig(
        { ...config, sourceRoot: "../../../Goal_Agent_latest/notes/knowledge" },
        () => undefined,
      ),
    ).toThrow(/sourceRoot must be an absolute path/);
  });
});

describe("planning-knowledge search", () => {
  it("delegates to OneLibrary and returns only portable canonical citations", async () => {
    const runner = runnerReturning({ results: [validHit] });
    const tool = createPlanningKnowledgeSearchTool(config, runner);

    const result = await tool.execute("call-1", { query: "input output balance" });
    expect(result.details).toMatchObject({
      source_system: "planning",
      record_type: "knowledge",
      corpus: "planning_personal",
      security_scope: "personal",
      results: [{ canonical_ref: validHit.canonical_ref }],
    });
    expect(JSON.stringify(result)).not.toMatch(/vector|chunk_id|sqlite|\/tmp\//i);
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        executable: "python3",
        args: expect.arrayContaining([
          "search",
          "--root",
          config.sourceRoot,
          "--index",
          config.indexPath,
          "--query",
          "input output balance",
        ]),
      }),
    );
  });

  it("fails closed for no matches", async () => {
    const tool = createPlanningKnowledgeSearchTool(config, runnerReturning({ results: [] }));
    const result = await tool.execute("call-1", { query: "not stored" });
    expect(result.details).toMatchObject({
      count: 0,
      message: "No stored Planning Knowledge Note found for this query.",
    });
  });

  it("rejects invalid citations and ineligible results", async () => {
    const invalidRef = createPlanningKnowledgeSearchTool(
      config,
      runnerReturning({ results: [{ ...validHit, canonical_ref: "vector-123" }] }),
    );
    await expect(invalidRef.execute("call-1", { query: "x" })).rejects.toThrow(
      /canonical note ref/,
    );

    const archived = createPlanningKnowledgeSearchTool(
      config,
      runnerReturning({ results: [{ ...validHit, status: "archived" }] }),
    );
    await expect(archived.execute("call-1", { query: "x" })).rejects.toThrow(/ineligible/);
  });

  it("does not use a shell and propagates the caller signal", async () => {
    const runner = runnerReturning({ results: [] });
    const tool = createPlanningKnowledgeSearchTool(config, runner);
    const signal = new AbortController().signal;
    await tool.execute("call-1", { query: "x" }, signal);
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ signal }));
    expect(vi.mocked(runner).mock.calls[0]?.[0].args).not.toContain("/bin/sh");
  });

  it.skipIf(!process.env.OPENCLAW_PLANNING_KNOWLEDGE_CLI)(
    "canary-runs the configured OneLibrary CLI against a synthetic note",
    async () => {
      const cliPath = process.env.OPENCLAW_PLANNING_KNOWLEDGE_CLI;
      const pythonExecutable = process.env.OPENCLAW_PLANNING_KNOWLEDGE_PYTHON ?? "python3";
      if (!cliPath) {
        throw new Error("OneLibrary CLI canary requires OPENCLAW_PLANNING_KNOWLEDGE_CLI");
      }
      const tempRoot = await mkdtemp(join(tmpdir(), "openclaw-planning-knowledge-"));
      const sourceRoot = join(tempRoot, "notes", "knowledge");
      const notePath = join(sourceRoot, "input_output_balance.md");
      const indexPath = join(tempRoot, "planning-personal.sqlite3");
      try {
        await mkdir(sourceRoot, { recursive: true });
        await writeFile(
          notePath,
          `---
schema: planning_knowledge_note
schema_version: 1
id: "note:notes/knowledge/input_output_balance"
title: "Input Output Balance"
knowledge_type: principle
status: active
created_at: "2026-08-01"
updated_at: "2026-08-01"
source_type: human
verification_status: reviewed
domains: ["lernen"]
topics: ["learning"]
goal_refs: []
project_refs: []
related_note_refs: []
source_refs: []
supersedes: []
---

## Essence

No major input without a concrete output.

## Knowledge

Output after learning improves retention.
`,
          "utf8",
        );
        const configured = resolvePlanningKnowledgeConfig(
          {
            ...config,
            scriptPath: cliPath,
            sourceRoot,
            indexPath,
            pythonExecutable,
          },
          (value) => value,
        );
        expect(configured).not.toBeNull();
        await execFileAsync(
          pythonExecutable,
          [cliPath, "sync", "--root", sourceRoot, "--index", indexPath, "--mode", "text"],
          { env: process.env },
        );
        const tool = createPlanningKnowledgeSearchTool(configured!);
        const result = await tool.execute("call-1", { query: "input output balance" });
        expect(result.details).toMatchObject({
          corpus: "planning_personal",
          results: [{ canonical_ref: "note:notes/knowledge/input_output_balance" }],
        });
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );
});

describe("planning-knowledge capture in PLN-500A", () => {
  it("recognizes explicit capture without writing or creating a task", async () => {
    const result = await createPlanningKnowledgeCaptureTool().execute("call-1", {
      content: "No major input without an output.",
    });
    expect(result.details).toEqual({
      intent: "knowledge_capture",
      status: "capture_not_enabled_in_pln_500a",
      write_performed: false,
      canonical_owner: "planning",
      operational_follow_up: "none",
    });
  });

  it("keeps a mixed operational follow-up separate", async () => {
    const result = await createPlanningKnowledgeCaptureTool().execute("call-1", {
      content: "No major input without an output.",
      operationalFollowUp: "Remind me tomorrow",
    });
    expect(result.details).toMatchObject({
      intent: "knowledge_capture",
      status: "capture_not_enabled_in_pln_500a",
      operational_follow_up: "route_separately",
      write_performed: false,
    });
  });
});

describe("planning-knowledge capture in PLN-500C", () => {
  it("calls only the Planning writer and derived sync, returning the canonical ref", async () => {
    const responses = [
      {
        stdout: JSON.stringify({
          status: "created",
          title: "Input Output Balance",
          canonical_ref: "note:notes/knowledge/input_output_balance",
        }),
        exitCode: 0,
      },
      {
        stdout: JSON.stringify({
          inserted_records: 1,
          updated_records: 0,
          unchanged_records: 0,
        }),
        exitCode: 0,
      },
    ];
    const calls: Array<Parameters<PlanningKnowledgeCommandRunner>[0]> = [];
    const runner: PlanningKnowledgeCommandRunner = vi.fn(async (request) => {
      calls.push(request);
      return responses.shift() ?? { stdout: "{}", exitCode: 0 };
    });
    const tool = createPlanningKnowledgeCaptureTool(writerConfig, runner);

    const result = await tool.execute("call-1", {
      title: "Input Output Balance",
      knowledgeType: "principle",
      sourceType: "human",
      verificationStatus: "reviewed",
      content: "Output after learning improves retention.",
      essence: "Input should be followed by active output.",
      knowledge: "Output after learning improves retention.",
      operationalFollowUp: "Remind me tomorrow",
    });

    expect(result.details).toMatchObject({
      status: "created",
      write_performed: true,
      canonical_ref: "note:notes/knowledge/input_output_balance",
      corpus: "planning_personal",
      derived_sync: "completed",
      operational_follow_up: "route_separately",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual([
      writerConfig.writerScriptPath,
      "create",
      "--root",
      "/tmp/goal-agent",
      "--input",
      "-",
    ]);
    expect(JSON.parse(calls[0]?.stdin ?? "{}")).toMatchObject({
      title: "Input Output Balance",
      knowledge_type: "principle",
      source_type: "human",
      verification_status: "reviewed",
    });
    expect(calls[1]?.args).toEqual([
      writerConfig.scriptPath,
      "sync",
      "--root",
      writerConfig.sourceRoot,
      "--index",
      writerConfig.indexPath,
      "--mode",
      "text",
    ]);
  });

  it("fails closed on a writer collision and does not sync", async () => {
    const runner: PlanningKnowledgeCommandRunner = vi.fn(async () => ({
      stdout: JSON.stringify({
        status: "error",
        error_code: "collision",
        message: "Knowledge target already contains different content",
      }),
      exitCode: 2,
    }));
    const tool = createPlanningKnowledgeCaptureTool(writerConfig, runner);

    await expect(
      tool.execute("call-1", {
        title: "Input Output Balance",
        knowledgeType: "principle",
        sourceType: "human",
        verificationStatus: "reviewed",
        content: "A conflicting proposition.",
      }),
    ).rejects.toThrow(/different content/);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it.skipIf(
    !process.env.OPENCLAW_PLANNING_KNOWLEDGE_CLI || !process.env.OPENCLAW_PLANNING_KNOWLEDGE_WRITER,
  )("runs the real writer → sync → retrieval cycle in an isolated fixture", async () => {
    const cliPath = process.env.OPENCLAW_PLANNING_KNOWLEDGE_CLI;
    const writerPath = process.env.OPENCLAW_PLANNING_KNOWLEDGE_WRITER;
    const pythonExecutable = process.env.OPENCLAW_PLANNING_KNOWLEDGE_PYTHON ?? "python3";
    if (!cliPath || !writerPath) {
      throw new Error("PLN-500C canary requires both Planning and OneLibrary CLIs");
    }
    const tempRoot = await mkdtemp(join(tmpdir(), "openclaw-pln-500c-"));
    const sourceRoot = join(tempRoot, "notes", "knowledge");
    const indexPath = join(tempRoot, "planning-personal.sqlite3");
    try {
      await mkdir(sourceRoot, { recursive: true });
      const configured = resolvePlanningKnowledgeConfig(
        {
          ...config,
          scriptPath: cliPath,
          writerScriptPath: writerPath,
          sourceRoot,
          indexPath,
          pythonExecutable,
        },
        (value) => value,
      );
      expect(configured).not.toBeNull();
      const capture = createPlanningKnowledgeCaptureTool(configured!);
      const payload = {
        title: "Input Output Balance",
        knowledgeType: "principle" as const,
        sourceType: "human" as const,
        verificationStatus: "reviewed" as const,
        content: "Output after learning improves retention.",
        essence: "Input should be followed by active output.",
        knowledge: "Output after learning improves retention.",
      };

      const created = await capture.execute("call-1", payload);
      expect(created.details).toMatchObject({
        status: "created",
        canonical_ref: "note:notes/knowledge/input_output_balance",
        derived_sync: "completed",
      });
      await execFileAsync(pythonExecutable, [writerPath, "validate-all", "--root", tempRoot]);

      const search = createPlanningKnowledgeSearchTool(configured!);
      const retrieved = await search.execute("call-2", {
        query: "Input Output Balance",
      });
      expect(retrieved.details).toMatchObject({
        corpus: "planning_personal",
        results: [{ canonical_ref: "note:notes/knowledge/input_output_balance" }],
      });

      const retry = await capture.execute("call-3", payload);
      expect(retry.details).toMatchObject({ status: "already_exists", write_performed: false });
      expect(await readdir(sourceRoot)).toHaveLength(1);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("planning-knowledge bounded maintenance", () => {
  it("runs only the fixed Level-A read-only command and returns its portable contract", async () => {
    const runner = runnerReturning({
      schema: "planning_knowledge_maintenance",
      schema_version: 1,
      read_only: true,
      result: "completed",
      writes: { canonical_knowledge: 0, derived_index: 0 },
    });
    const tool = createPlanningKnowledgeMaintenanceTool(maintenanceConfig, runner);

    const result = await tool.execute("call-1", { trigger: "scheduled" });

    expect(result.details).toMatchObject({
      schema: "planning_knowledge_maintenance",
      schema_version: 1,
      read_only: true,
      result: "completed",
    });
    const request = vi.mocked(runner).mock.calls[0]?.[0];
    expect(request?.args).toEqual([
      maintenanceConfig.maintenanceScriptPath,
      "run",
      "--root",
      "/tmp/goal-agent",
      "--onelibrary-script",
      config.scriptPath,
      "--index",
      config.indexPath,
      "--python",
      config.pythonExecutable,
      "--trigger",
      "scheduled",
      "--runtime-tool-visible",
    ]);
    expect(request?.args).not.toContain("--repair");
  });

  it("fails closed when the maintenance capability is not authorized", async () => {
    const tool = createPlanningKnowledgeMaintenanceTool(maintenanceConfig, runnerReturning({}), {
      authorized: false,
    });
    await expect(tool.execute("call-1", {})).rejects.toThrow(/access denied/);
  });

  it("rejects a non-read-only or path-bearing maintenance result", async () => {
    const writable = createPlanningKnowledgeMaintenanceTool(
      maintenanceConfig,
      runnerReturning({
        schema: "planning_knowledge_maintenance",
        schema_version: 1,
        read_only: false,
      }),
    );
    await expect(writable.execute("call-1", {})).rejects.toThrow(/invalid contract/);

    const pathBearing = createPlanningKnowledgeMaintenanceTool(
      maintenanceConfig,
      runnerReturning({
        schema: "planning_knowledge_maintenance",
        schema_version: 1,
        read_only: true,
        output: "/Users/private/secret",
      }),
    );
    await expect(pathBearing.execute("call-1", {})).rejects.toThrow(/local path/);
  });
});
