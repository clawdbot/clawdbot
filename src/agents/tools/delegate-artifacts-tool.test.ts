import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  DELEGATE_ARTIFACT_OUTPUT_ROOT,
  DELEGATE_ARTIFACT_MAX_BYTES,
  createDelegateArtifactPolicy,
  finalizeDelegateArtifacts,
  recordDelegateArtifactDelivery,
} from "../delegate-artifacts.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { createDelegateArtifactTools } from "./delegate-artifacts-tool.js";

const config = {
  agents: {
    defaults: {
      continuation: {
        enabled: true,
        crossSessionTargeting: "enabled" as const,
      },
    },
  },
};

function parseResult(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.find((entry) => entry.type === "text")?.text;
  if (!text) {
    throw new Error("missing JSON tool result");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function acknowledgeProjection(
  projection: Parameters<typeof recordDelegateArtifactDelivery>[0]["projection"],
  statePath: string,
) {
  recordDelegateArtifactDelivery({
    projection,
    phase: "attempt",
    options: { path: statePath },
  });
  recordDelegateArtifactDelivery({
    projection,
    phase: "acknowledged",
    options: { path: statePath },
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openclaw-delegate-artifact-tool-"));
  const workspace = join(root, "workspace");
  const output = join(workspace, DELEGATE_ARTIFACT_OUTPUT_ROOT);
  mkdirSync(output, { recursive: true });
  const statePath = join(root, "openclaw.sqlite");
  const now = Date.now();
  const sessionKey = "agent:main:subagent:continuation-child";
  const sessionId = "child-session-1";
  const runId = "continuation-delegate-run-1";
  createDelegateArtifactPolicy(
    {
      flowId: "flow-1",
      producerSessionKey: sessionKey,
      producerRunId: runId,
      originParentSessionKey: "agent:main:parent",
      originParentSessionId: "parent-session-1",
      dispatchRevision: 2,
      dispatchAcceptedAt: now,
      artifactMode: "required",
      recipients: [
        {
          sessionKey: "agent:main:parent",
          sessionId: "parent-session-1",
          relation: "parent",
        },
      ],
      route: { kind: "parent" },
    },
    { path: statePath },
  );
  const tools = createDelegateArtifactTools({
    config,
    getRuntimeConfig: () => config,
    resolveSessionId: () => sessionId,
    agentSessionKey: sessionKey,
    sessionId,
    runId,
    workspaceDir: workspace,
    stateOptions: { path: statePath },
  });
  return {
    now,
    workspace,
    output,
    statePath,
    sessionKey,
    sessionId,
    runId,
    publish: tools.find((tool) => tool.name === "delegate_artifacts_publish")!,
    operations: tools.find((tool) => tool.name === "delegate_artifacts")!,
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("delegate artifact tools", () => {
  it("uses a flat provider-safe action enum", () => {
    const actionSchema = (
      fixture().operations.parameters as {
        properties?: { action?: Record<string, unknown> };
      }
    ).properties?.action;

    expect(actionSchema).toMatchObject({
      type: "string",
      enum: ["list", "inspect", "materialize", "discard"],
    });
    expect(actionSchema).not.toHaveProperty("anyOf");
  });

  it("publishes only validated regular files under the approved output root", async () => {
    const test = fixture();
    writeFileSync(join(test.output, "report.pdf"), "%PDF-1.7 managed report");

    const published = parseResult(
      await test.publish.execute("tool-call-1", { paths: ["report.pdf"] }),
    );
    expect(published).toEqual({ status: "published", count: 1 });
    expect(JSON.stringify(published)).not.toContain("report.pdf");
    expect(JSON.stringify(published)).not.toContain("%PDF");

    for (const candidate of ["../outside.txt", "/tmp/outside.txt", "https://example.test/a"]) {
      const rejected = parseResult(
        await test.publish.execute(`tool-call-${candidate}`, { paths: [candidate] }),
      );
      expect(rejected).toEqual({ status: "rejected", reason: "invalid_candidate" });
      expect(JSON.stringify(rejected)).not.toContain(candidate);
    }
  });

  it("rejects symlinks, missing files, raw inputs, and publication without policy", async () => {
    const test = fixture();
    const outside = join(test.workspace, "outside.txt");
    writeFileSync(outside, "private bytes");
    writeFileSync(join(test.output, "plain.txt"), "text");
    symlinkSync(outside, join(test.output, "linked.txt"));
    linkSync(outside, join(test.output, "hardlinked.txt"));
    writeFileSync(join(test.output, "oversized.bin"), "");
    truncateSync(join(test.output, "oversized.bin"), DELEGATE_ARTIFACT_MAX_BYTES + 1);
    let runtimeEnabled = false;
    let currentSessionId = test.sessionId;
    const guarded = createDelegateArtifactTools({
      config,
      getRuntimeConfig: () =>
        runtimeEnabled ? config : { agents: { defaults: { continuation: { enabled: false } } } },
      resolveSessionId: () => currentSessionId,
      agentSessionKey: test.sessionKey,
      sessionId: test.sessionId,
      runId: test.runId,
      workspaceDir: test.workspace,
      stateOptions: { path: test.statePath },
    }).find((tool) => tool.name === "delegate_artifacts_publish")!;
    expect(parseResult(await guarded.execute("disabled", { paths: ["plain.txt"] }))).toEqual({
      status: "rejected",
      reason: "runtime_disabled",
    });
    runtimeEnabled = true;
    currentSessionId = "replacement-session";
    expect(parseResult(await guarded.execute("stale", { paths: ["plain.txt"] }))).toEqual({
      status: "rejected",
      reason: "forbidden",
    });

    for (const paths of [["linked.txt"], ["hardlinked.txt"], ["oversized.bin"], ["missing.txt"]]) {
      expect(parseResult(await test.publish.execute("tool-call-rejected", { paths }))).toEqual({
        status: "rejected",
        reason: "invalid_candidate",
      });
    }
    await expect(
      test.publish.execute("tool-call-raw", {
        data: Buffer.from("raw").toString("base64"),
        url: "https://example.test",
        sha256: "0".repeat(64),
      }),
    ).rejects.toThrow("paths must be a bounded list");

    const unbound = createDelegateArtifactTools({
      config,
      getRuntimeConfig: () => config,
      resolveSessionId: () => "unbound-session",
      agentSessionKey: "agent:main:unbound",
      sessionId: "unbound-session",
      runId: "unbound-run",
      workspaceDir: test.workspace,
      stateOptions: { path: test.statePath },
    }).find((tool) => tool.name === "delegate_artifacts_publish")!;
    expect(
      parseResult(await unbound.execute("tool-call-unbound", { paths: ["plain.txt"] })),
    ).toEqual({
      status: "rejected",
      reason: "forbidden",
    });
  });

  it("lists, inspects, materializes, and discards through the recipient binding only", async () => {
    const test = fixture();
    writeFileSync(join(test.output, "report.pdf"), "%PDF-1.7 managed report");
    await test.publish.execute("tool-call-1", { paths: ["report.pdf"] });
    rmSync(join(test.output, "report.pdf"));
    const finalized = finalizeDelegateArtifacts({
      producerSessionKey: test.sessionKey,
      producerSessionId: test.sessionId,
      producerRunId: test.runId,
      completionId: "completion-1",
      finalizationKey: "finalization-1",
      completionStatus: "ok",
      completedAt: test.now + 100,
      silent: false,
      runtimeEnabled: true,
      crossSessionEnabled: true,
      resolveSessionId: (sessionKey) =>
        sessionKey === "agent:main:parent" ? "parent-session-1" : undefined,
      now: test.now + 200,
      options: { path: test.statePath },
    });
    if (finalized.status !== "finalized") {
      throw new Error("expected finalized claim");
    }
    const projection = finalized.projections.get("agent:main:parent")!;
    acknowledgeProjection(projection, test.statePath);
    const claimId = projection.artifacts[0]!.id;
    const recipientWorkspace = join(test.workspace, "recipient");
    mkdirSync(recipientWorkspace);
    let runtimeEnabled = false;
    let currentSessionId = "parent-session-1";
    const operations = createDelegateArtifactTools({
      config,
      getRuntimeConfig: () =>
        runtimeEnabled ? config : { agents: { defaults: { continuation: { enabled: false } } } },
      resolveSessionId: () => currentSessionId,
      agentSessionKey: "agent:main:parent",
      sessionId: "parent-session-1",
      runId: "parent-run",
      workspaceDir: recipientWorkspace,
      stateOptions: { path: test.statePath },
    }).find((tool) => tool.name === "delegate_artifacts")!;

    expect(parseResult(await operations.execute("list-disabled", { action: "list" }))).toEqual({
      outcome: "unauthorized",
    });
    runtimeEnabled = true;
    currentSessionId = "replacement-session";
    expect(parseResult(await operations.execute("list-stale", { action: "list" }))).toEqual({
      outcome: "unauthorized",
    });
    currentSessionId = "parent-session-1";
    const listed = parseResult(await operations.execute("list-1", { action: "list" }));
    expect(listed).toMatchObject({
      outcome: "available",
      artifacts: [{ id: claimId, download: { mode: "unsupported" } }],
    });
    expect(JSON.stringify(listed)).not.toMatch(/%PDF|sha256|path|url|data/i);

    expect(
      parseResult(await operations.execute("inspect-1", { action: "inspect", claimId })),
    ).toMatchObject({
      outcome: "available",
      artifact: { id: claimId, source: "delegate-return" },
    });
    expect(
      parseResult(
        await operations.execute("materialize-1", {
          action: "materialize",
          claimId,
          destination: "accepted.pdf",
        }),
      ),
    ).toEqual({ outcome: "available", materialized: true });
    expect(readFileSync(join(recipientWorkspace, "accepted.pdf"), "utf8")).toBe(
      "%PDF-1.7 managed report",
    );
    expect(
      openOpenClawStateDatabase({ path: test.statePath })
        .db.prepare(
          "SELECT destination FROM delegate_artifact_audit WHERE action = 'materialize' ORDER BY sequence DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ destination: "accepted.pdf" });

    expect(
      parseResult(await operations.execute("discard-1", { action: "discard", claimId })),
    ).toEqual({ outcome: "available" });
    expect(
      parseResult(await operations.execute("inspect-2", { action: "inspect", claimId })),
    ).toEqual({ outcome: "revoked" });
  });

  it("publishes and materializes through the sandbox filesystem bridge", async () => {
    const test = fixture();
    const remoteOnlyBridge = createHostSandboxFsBridge(test.workspace);
    const resolveRemotePath = remoteOnlyBridge.resolvePath.bind(remoteOnlyBridge);
    remoteOnlyBridge.resolvePath = (params) => {
      const resolved = resolveRemotePath(params);
      return {
        relativePath: resolved.relativePath,
        containerPath: resolved.containerPath,
      };
    };
    remoteOnlyBridge.readFile = async () => {
      throw new Error("remote sandbox publication must not use unbounded reads");
    };
    writeFileSync(join(test.output, "sandboxed.txt"), "sandbox-only bytes");
    const remotePublish = createDelegateArtifactTools({
      config,
      getRuntimeConfig: () => config,
      resolveSessionId: () => test.sessionId,
      agentSessionKey: test.sessionKey,
      sessionId: test.sessionId,
      runId: test.runId,
      workspaceDir: join(test.workspace, "host-path-not-used"),
      sandboxRoot: test.workspace,
      sandboxFsBridge: remoteOnlyBridge,
      stateOptions: { path: test.statePath },
    }).find((tool) => tool.name === "delegate_artifacts_publish")!;
    expect(
      parseResult(await remotePublish.execute("remote-publication", { paths: ["sandboxed.txt"] })),
    ).toEqual({ status: "rejected", reason: "invalid_candidate" });

    const bridge = createHostSandboxFsBridge(test.workspace);
    const resolvePath = bridge.resolvePath.bind(bridge);
    let invalidateAfterRead = true;
    let producerSessionId = test.sessionId;
    let invalidateAfterWrite = false;
    let currentSessionId = "parent-session-1";
    bridge.resolvePath = (params) => {
      const resolved = resolvePath(params);
      if (invalidateAfterRead && params.filePath.endsWith("sandboxed.txt")) {
        producerSessionId = "replacement-producer-session";
        invalidateAfterRead = false;
      }
      if (invalidateAfterWrite && params.filePath === test.workspace) {
        currentSessionId = "replacement-session";
        invalidateAfterWrite = false;
      }
      return resolved;
    };
    const publish = createDelegateArtifactTools({
      config,
      getRuntimeConfig: () => config,
      resolveSessionId: () => producerSessionId,
      agentSessionKey: test.sessionKey,
      sessionId: test.sessionId,
      runId: test.runId,
      workspaceDir: join(test.workspace, "host-path-not-used"),
      sandboxRoot: test.workspace,
      sandboxFsBridge: bridge,
      sandboxWritable: true,
      stateOptions: { path: test.statePath },
    }).find((tool) => tool.name === "delegate_artifacts_publish")!;

    expect(
      parseResult(await publish.execute("publication-race", { paths: ["sandboxed.txt"] })),
    ).toEqual({ status: "rejected", reason: "forbidden" });
    producerSessionId = test.sessionId;
    expect(
      parseResult(await publish.execute("sandbox-publication", { paths: ["sandboxed.txt"] })),
    ).toEqual({ status: "published", count: 1 });
    const finalized = finalizeDelegateArtifacts({
      producerSessionKey: test.sessionKey,
      producerSessionId: test.sessionId,
      producerRunId: test.runId,
      completionId: "completion-sandbox",
      finalizationKey: "finalization-sandbox",
      completionStatus: "ok",
      completedAt: test.now + 100,
      silent: false,
      runtimeEnabled: true,
      crossSessionEnabled: true,
      resolveSessionId: (sessionKey) =>
        sessionKey === "agent:main:parent" ? "parent-session-1" : undefined,
      now: test.now + 200,
      options: { path: test.statePath },
    });
    if (finalized.status !== "finalized") {
      throw new Error("expected finalized claim");
    }
    const projection = finalized.projections.get("agent:main:parent")!;
    acknowledgeProjection(projection, test.statePath);
    const claimId = projection.artifacts[0]!.id;
    const operations = createDelegateArtifactTools({
      config,
      getRuntimeConfig: () => config,
      resolveSessionId: () => currentSessionId,
      agentSessionKey: "agent:main:parent",
      sessionId: "parent-session-1",
      runId: "parent-run",
      workspaceDir: join(test.workspace, "host-path-not-used"),
      sandboxRoot: test.workspace,
      sandboxFsBridge: bridge,
      sandboxWritable: true,
      stateOptions: { path: test.statePath },
    }).find((tool) => tool.name === "delegate_artifacts")!;

    const readOnlyOperations = createDelegateArtifactTools({
      config,
      getRuntimeConfig: () => config,
      resolveSessionId: () => "parent-session-1",
      agentSessionKey: "agent:main:parent",
      sessionId: "parent-session-1",
      runId: "parent-run",
      workspaceDir: join(test.workspace, "host-path-not-used"),
      sandboxRoot: test.workspace,
      sandboxFsBridge: bridge,
      sandboxWritable: false,
      stateOptions: { path: test.statePath },
    }).find((tool) => tool.name === "delegate_artifacts")!;
    expect(
      parseResult(
        await readOnlyOperations.execute("sandbox-read-only-materialization", {
          action: "materialize",
          claimId,
          destination: "rejected-read-only.txt",
        }),
      ),
    ).toEqual({ outcome: "unauthorized" });
    expect(existsSync(join(test.workspace, "rejected-read-only.txt"))).toBe(false);

    expect(
      parseResult(
        await operations.execute("sandbox-materialization", {
          action: "materialize",
          claimId,
          destination: "accepted-sandboxed.txt",
        }),
      ),
    ).toEqual({ outcome: "available", materialized: true });
    expect(readFileSync(join(test.workspace, "accepted-sandboxed.txt"), "utf8")).toBe(
      "sandbox-only bytes",
    );
    invalidateAfterWrite = true;
    expect(
      parseResult(
        await operations.execute("sandbox-materialization-reset", {
          action: "materialize",
          claimId,
          destination: "rejected-after-reset.txt",
        }),
      ),
    ).toEqual({ outcome: "unauthorized" });
    expect(existsSync(join(test.workspace, "rejected-after-reset.txt"))).toBe(false);
  });
});
