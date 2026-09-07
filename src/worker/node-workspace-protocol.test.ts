import { describe, expect, it } from "vitest";
import {
  NODE_WORKSPACE_DRAIN_COMMAND,
  parseNodeWorkerWorkspaceExecInput,
  parseNodeWorkerWorkspaceExecResult,
} from "./node-workspace-protocol.js";
import { WORKER_SKILL_RESOURCE_INPUT_MAX_BYTES } from "./skill-resource-protocol.js";
import {
  WORKSPACE_INSPECTION_COMMAND,
  WORKSPACE_INSPECTION_MAX_BYTES,
} from "./workspace-inspection-protocol.js";

const request = {
  gatewayNamespace: "gateway-1",
  environmentId: "environment-1",
  sessionId: "session-1",
  generation: 1,
  argv: ["openclaw-internal-workspace-seed"],
};
const key = "a".repeat(64);

it("admits workspace drain only without a mutation payload", () => {
  const drain = { ...request, argv: [NODE_WORKSPACE_DRAIN_COMMAND] };
  expect(parseNodeWorkerWorkspaceExecInput(JSON.stringify(drain))).toEqual(drain);
  for (const mutation of [
    { argv: [NODE_WORKSPACE_DRAIN_COMMAND, "extra"] },
    { input: "payload" },
    { resetWorkspace: true },
    { seed: { action: "apply", key } },
    { capture: { baseManifestRef: `sha256:${key}`, referenceManifestRef: `sha256:${key}` } },
    { skillResources: { operation: "init" } },
    { transfer: { direction: "download", token: "token", manifestRef: `sha256:${key}` } },
  ]) {
    expect(() =>
      parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...drain, ...mutation })),
    ).toThrow("workspace drain owns its operation");
  }
});

describe("node workspace seed protocol", () => {
  it("carries the exact prepared identity and session key", () => {
    const prepared = { ...request, preparationKey: key, sessionKey: "agent:test:prepared" };
    expect(parseNodeWorkerWorkspaceExecInput(JSON.stringify(prepared))).toEqual(prepared);
  });

  it.each(["../outside", "A".repeat(64), "", null])(
    "rejects malformed preparation identity %j",
    (preparationKey) => {
      expect(() =>
        parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, preparationKey })),
      ).toThrow("preparationKey");
    },
  );

  const download = {
    direction: "download",
    token: "token",
    manifestRef: `sha256:${key}`,
    seedKey: key,
  };

  it("accepts a prepared seed only as part of a workspace download", () => {
    expect(
      parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, transfer: download }))
        .transfer,
    ).toEqual(download);
  });

  it.each([
    { ...download, seedKey: "../outside" },
    { ...download, seedKey: "A".repeat(64) },
    { ...download, attachments: true },
    {
      direction: "upload",
      token: "token",
      baseManifestRef: download.manifestRef,
      referenceManifestRef: download.manifestRef,
      seedKey: key,
    },
  ])("rejects an invalid prepared seed transfer %#", (transfer) => {
    expect(() =>
      parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, transfer })),
    ).toThrow("INVALID_REQUEST:");
  });

  it.each([
    { action: "apply", key },
    { action: "store", key, maxAgeMs: 0 },
    { action: "store", key, maxAgeMs: Number.MAX_SAFE_INTEGER },
  ])("accepts $action with maxAgeMs=$maxAgeMs", (seed) => {
    expect(parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, seed }))).toEqual({
      ...request,
      seed,
    });
  });

  it.each([
    ["bad key", { seed: { action: "apply", key: "../outside" } }],
    ["uppercase key", { seed: { action: "apply", key: "A".repeat(64) } }],
    ["bad action", { seed: { action: "remove", key } }],
    ["extra apply key", { seed: { action: "apply", key, maxAgeMs: 0 } }],
    ["extra store key", { seed: { action: "store", key, maxAgeMs: 0, extra: true } }],
    ["missing age", { seed: { action: "store", key } }],
    ["negative age", { seed: { action: "store", key, maxAgeMs: -1 } }],
    ["unsafe age", { seed: { action: "store", key, maxAgeMs: Number.MAX_SAFE_INTEGER + 1 } }],
    ["fractional age", { seed: { action: "store", key, maxAgeMs: 0.5 } }],
    ["reset", { seed: { action: "apply", key }, resetWorkspace: true }],
    ["false reset", { seed: { action: "apply", key }, resetWorkspace: false }],
    [
      "transfer",
      {
        seed: { action: "store", key, maxAgeMs: 0 },
        transfer: { direction: "download", token: "transfer-token", manifestRef: `sha256:${key}` },
      },
    ],
  ])("rejects %s", (_name, invalid) => {
    expect(() =>
      parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, ...invalid })),
    ).toThrow("INVALID_REQUEST:");
  });
});

describe("node workspace manifest capture protocol", () => {
  const capture = {
    baseManifestRef: `sha256:${key}`,
    referenceManifestRef: `sha256:${"b".repeat(64)}`,
  };
  const captureRequest = { ...request, argv: ["openclaw-internal-workspace-manifest"], capture };
  it("carries only bound manifest references", () => {
    expect(parseNodeWorkerWorkspaceExecInput(JSON.stringify(captureRequest))).toEqual(
      captureRequest,
    );
  });
  it.each([
    { capture: { ...capture, baseManifestRef: "../outside" } },
    { capture: { ...capture, referenceManifestRef: "sha256:" } },
    { capture: { ...capture, memo: [] } },
    { argv: ["node"] },
    { input: "[]" },
    { seed: { action: "apply", key } },
    { transfer: { direction: "upload", token: "token", baseManifestRef: capture.baseManifestRef } },
    { resetWorkspace: false },
  ])("rejects malformed or mixed capture %#", (invalid) => {
    expect(() =>
      parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...captureRequest, ...invalid })),
    ).toThrow("workspace manifest capture is invalid");
  });
});

describe("node workspace skill resource protocol", () => {
  const resourceRequest = { ...request, argv: ["openclaw-internal-skill-resources"] };
  const identity = { resourceId: "b".repeat(32), identity: "1:18446744073709551615" };
  const write = {
    operation: "write",
    ...identity,
    path: "0/SKILL.md",
    offset: 0,
    sizeBytes: 3,
    sha256: key,
    executable: false,
  };

  it.each([
    { skillResources: { operation: "init" } },
    { skillResources: { operation: "cleanup", ...identity } },
    { skillResources: write, input: "YWJj" },
    { skillResources: { ...write, sizeBytes: 0 }, input: "" },
  ])("preserves a closed generation-bound operation %#", (operation) => {
    const input = { ...resourceRequest, ...operation };
    expect(parseNodeWorkerWorkspaceExecInput(JSON.stringify(input))).toEqual(input);
  });

  it.each([
    ["caller-selected root", { skillResources: { operation: "init", root: "/tmp/other" } }],
    ["cleanup root", { skillResources: { operation: "cleanup", ...identity, root: "/tmp/other" } }],
    ["traversing resource id", { skillResources: { ...write, resourceId: "../outside" } }],
    ["numeric inode", { skillResources: { ...write, identity: 1 } }],
    ["path traversal", { skillResources: { ...write, path: "0/../outside" } }],
    ["absolute path", { skillResources: { ...write, path: "/outside" } }],
    ["Windows path", { skillResources: { ...write, path: "C:/outside" } }],
    ["deep path", { skillResources: { ...write, path: "a/".repeat(17) + "file" } }],
    ["negative offset", { skillResources: { ...write, offset: -1 } }],
    ["oversize file", { skillResources: { ...write, sizeBytes: 1_048_577 } }],
    ["invalid digest", { skillResources: { ...write, sha256: "A".repeat(64) } }],
    ["extra write field", { skillResources: { ...write, command: ["node"] } }],
    ["ordinary argv", { argv: ["node", "-e", "process.exit()"] }],
    ["extra argv", { argv: [...resourceRequest.argv, "/outside"] }],
    ["missing chunk", { input: undefined }],
    ["noncanonical base64", { input: "YWJj\n" }],
    ["chunk over file bound", { input: "YWJjZA==" }],
    [
      "stdin over transport bound",
      { input: "a".repeat(WORKER_SKILL_RESOURCE_INPUT_MAX_BYTES + 1) },
    ],
    ["init with input", { skillResources: { operation: "init" }, input: "" }],
    ["cleanup with input", { skillResources: { operation: "cleanup", ...identity }, input: "" }],
    ["workspace reset", { resetWorkspace: false }],
    ["workspace seed", { seed: { action: "apply", key } }],
    [
      "workspace capture",
      { capture: { baseManifestRef: `sha256:${key}`, referenceManifestRef: `sha256:${key}` } },
    ],
    [
      "workspace transfer",
      { transfer: { direction: "upload", token: "token", baseManifestRef: `sha256:${key}` } },
    ],
  ])("rejects %s before filesystem dispatch", (_label, invalid) => {
    expect(() =>
      parseNodeWorkerWorkspaceExecInput(
        JSON.stringify({
          ...resourceRequest,
          skillResources: write,
          input: "YWJj",
          ...invalid,
        }),
      ),
    ).toThrow("INVALID_REQUEST:");
  });
});

describe("node workspace upload references", () => {
  const transfer = {
    direction: "upload",
    token: "token",
    baseManifestRef: `sha256:${"a".repeat(64)}`,
    referenceManifestRef: `sha256:${"b".repeat(64)}`,
  };

  it("preserves the accepted manifest independently of the immutable base", () => {
    expect(
      parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, transfer })).transfer,
    ).toEqual(transfer);
  });

  it.each([undefined, null, "", "../outside", `sha256:${"B".repeat(64)}`])(
    "rejects missing or invalid accepted references: %s",
    (referenceManifestRef) => {
      expect(() =>
        parseNodeWorkerWorkspaceExecInput(
          JSON.stringify({ ...request, transfer: { ...transfer, referenceManifestRef } }),
        ),
      ).toThrow("workspace transfer is invalid");
    },
  );
});

it("allows larger bounded inspection payloads without widening ordinary command limits", () => {
  const input = "x".repeat(192 * 1024);
  const argv = [WORKSPACE_INSPECTION_COMMAND];
  expect(parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, argv, input })).input).toBe(
    input,
  );
  expect(() => parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, input }))).toThrow(
    "bound",
  );
  const result = {
    workspaceDir: "/workspace",
    stdout: input,
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
  expect(parseNodeWorkerWorkspaceExecResult(result, argv)?.stdout).toBe(input);
  expect(parseNodeWorkerWorkspaceExecResult(result)).toBeNull();
  expect(
    parseNodeWorkerWorkspaceExecResult(
      { ...result, stdout: "x".repeat(WORKSPACE_INSPECTION_MAX_BYTES + 1) },
      argv,
    ),
  ).toBeNull();
});

it.each([
  { argv: [WORKSPACE_INSPECTION_COMMAND, "extra"] },
  {
    argv: [WORKSPACE_INSPECTION_COMMAND],
    capture: { baseManifestRef: `sha256:${key}`, referenceManifestRef: `sha256:${key}` },
  },
  { argv: [WORKSPACE_INSPECTION_COMMAND], skillResources: { operation: "init" } },
  { argv: [WORKSPACE_INSPECTION_COMMAND], resetWorkspace: false },
  { argv: [WORKSPACE_INSPECTION_COMMAND], seed: { action: "apply", key } },
  {
    argv: [WORKSPACE_INSPECTION_COMMAND],
    transfer: {
      direction: "upload",
      token: "token",
      baseManifestRef: `sha256:${key}`,
      referenceManifestRef: `sha256:${key}`,
    },
  },
])("rejects mixed inspection authority %#", (fields) => {
  expect(() =>
    parseNodeWorkerWorkspaceExecInput(JSON.stringify({ ...request, ...fields })),
  ).toThrow("inspection owns its operation");
});
