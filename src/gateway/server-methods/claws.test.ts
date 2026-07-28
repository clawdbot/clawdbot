import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateClawLifecycleApplyResult,
  validateClawLifecyclePlanResult,
  validateClawsAddPlanParams,
  validateClawsCatalogDetailResult,
  validateClawsConfigureApplyParams,
  validateClawsDoctorResult,
  validateClawsStatusResult,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ClawStatusRecord } from "../../claws/lifecycle-state.js";
import { clawsHandlers, projectClawsDoctor, projectClawsStatus } from "./claws.js";
import type { RespondFn } from "./types.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Claw gateway projections", () => {
  it("keeps catalog and lifecycle payloads closed against source or config leakage", () => {
    expect(
      validateClawsCatalogDetailResult({
        schemaVersion: "openclaw.clawsCatalogDetail.v1",
        detail: {
          packageName: "financial-analyst",
          displayName: "Financial Analyst",
          channel: "official",
          official: true,
          version: "1.2.0",
          workspaceFiles: 1,
          skills: 1,
          plugins: 1,
          mcpServers: 1,
          scheduledJobs: 1,
          manifestPath: "/secret/claw.json",
        },
      }),
    ).toBe(false);
    expect(
      validateClawLifecyclePlanResult({
        schemaVersion: "openclaw.clawsGatewayPlan.v1",
        operation: "add",
        planIntegrity: "sha256:preview",
        target: { agentId: "analyst" },
        actions: [],
        capabilities: [],
        blockers: [],
        riskAcknowledgementRequired: false,
        sourceRoot: "/secret/package",
      }),
    ).toBe(false);
    expect(
      validateClawLifecycleApplyResult({
        schemaVersion: "openclaw.clawsGatewayApply.v1",
        operation: "add",
        status: "complete",
        agentId: "analyst",
        message: "Claw agent added.",
      }),
    ).toBe(true);
  });

  it("accepts bounded setup answers and configure consent", () => {
    expect(
      validateClawsAddPlanParams({
        source: { packageName: "financial-analyst", version: "1.2.0" },
        answers: { timezone: "America/Los_Angeles", topics: ["markets"] },
      }),
    ).toBe(true);
    expect(
      validateClawsConfigureApplyParams({
        target: "analyst",
        answers: { timezone: "America/Los_Angeles" },
        regenerateSeeds: ["PREFERENCES.md"],
        planIntegrity: "sha256:preview",
      }),
    ).toBe(true);
    expect(
      validateClawsAddPlanParams({
        source: { packageName: "financial-analyst", version: "1.2.0" },
        answers: { unsafe: { nested: true } },
      }),
    ).toBe(false);
  });

  it("keeps inventory and ownership while omitting secret-bearing lifecycle fields", () => {
    const record = {
      install: {
        claw: {
          kind: "package",
          name: "analyst",
          version: "1.0.0",
          packageRoot: "/secret/package",
          manifestPath: "/secret/package/claw.json",
          integrityKind: "artifact",
          integrity: "sha256:secret",
          byteLength: 123,
        },
        agentId: "analyst",
        workspace: "/secret/workspace",
        status: "complete",
        addedAtMs: 1,
        updatedAtMs: 2,
      },
      agentState: "present",
      workspaceFiles: [
        {
          path: "SOUL.md",
          sourcePath: "/secret/package/SOUL.md",
          contentDigest: "sha256:file-secret",
          state: "unchanged",
        },
      ],
      packages: [
        {
          kind: "plugin",
          ref: "@openclaw/markets",
          version: "2.0.0",
          integrity: "sha256:plugin-secret",
          relationship: "referenced",
          origin: "pre-existing",
          independentOwner: true,
          state: "present",
        },
      ],
      mcpServers: [
        {
          name: "markets",
          configDigest: "sha256:mcp-secret",
          relationship: "managed",
          origin: "claw-introduced",
          independentOwner: false,
          state: "present",
        },
      ],
      cronJobs: [
        {
          manifestId: "morning-brief",
          status: "complete",
          job: { message: "private cron prompt" },
        },
      ],
      setup: {
        status: "complete",
        answers: [{ id: "timezone", value: "America/Los_Angeles", source: "explicit" }],
        seeds: [{ destination: "PREFERENCES.md", status: "complete" }],
      },
    } as unknown as ClawStatusRecord;

    const result = projectClawsStatus([record]);
    expect(validateClawsStatusResult(result)).toBe(true);
    expect(result.summary).toMatchObject({ claws: 1, healthy: 1, managed: 4, referenced: 1 });
    expect(result.records[0]?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "plugin",
          id: "@openclaw/markets@2.0.0",
          relationship: "referenced",
          origin: "pre-existing",
          independentOwner: true,
        }),
      ]),
    );
    expect(result.records[0]?.personalization).toEqual({
      status: "complete",
      answers: [{ id: "timezone", value: "America/Los_Angeles", source: "explicit" }],
      seeds: [{ destination: "PREFERENCES.md", status: "complete" }],
      updatePending: false,
    });
    const pending = projectClawsStatus([
      {
        ...record,
        setupUpdate: {
          status: "pending",
          answers: [{ id: "timezone", value: "UTC", source: "explicit" }],
          seeds: [{ destination: "PREFERENCES.md", status: "pending" }],
        },
      } as unknown as ClawStatusRecord,
    ]);
    expect(pending.summary).toMatchObject({ healthy: 0, attention: 1 });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/secret/");
    expect(serialized).not.toContain("sha256:");
    expect(serialized).not.toContain("private cron prompt");
  });

  it("omits diagnostic targets and source metadata", () => {
    const result = projectClawsDoctor([
      {
        checkId: "core/doctor/claws-state",
        severity: "warning",
        message: "Workspace file changed at /secret/workspace.",
        path: "claws.analyst.workspace.SOUL.md",
        requirement: "Workspace state should match.",
        fixHint: "Inspect the file.",
        target: "/secret/workspace:SOUL.md",
        source: "doctor",
      },
    ]);

    expect(validateClawsDoctorResult(result)).toBe(true);
    expect(result.findings[0]).toEqual({
      severity: "warning",
      message: "Claw-managed workspace file needs attention.",
      path: "claws.analyst.workspace.SOUL.md",
      requirement: "Workspace state should match.",
      fixHint: "Inspect the file.",
    });
    expect(JSON.stringify(result)).not.toContain("/secret/workspace");
  });
});

describe("Claw gateway feature gate", () => {
  it("rejects direct requests while Claws are disabled", async () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    const calls: Parameters<RespondFn>[] = [];
    const respond: RespondFn = (...args) => calls.push(args);

    await expectDefined(
      clawsHandlers["claws.status"],
      "claws.status handler",
    )({
      req: { type: "req", id: "claws-disabled", method: "claws.status" },
      params: {},
      respond,
      context: {} as never,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(false);
    expect(calls[0]?.[2]?.message).toContain("experimental and disabled");
  });
});
