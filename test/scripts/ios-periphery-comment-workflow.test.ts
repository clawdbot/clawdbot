import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { markdownToIR } from "../../packages/markdown-core/src/ir.js";

const WORKFLOW_PATH = ".github/workflows/ios-periphery-comment.yml";
const PRODUCER_WORKFLOW_PATH = ".github/workflows/ios-periphery.yml";
const MACOS_PRODUCER_WORKFLOW_PATH = ".github/workflows/macos-periphery.yml";
const SHARED_PRODUCER_WORKFLOW_PATH = ".github/workflows/shared-openclawkit-periphery.yml";
const ARTIFACT_NAME = "ios-periphery-dead-code-12345-2";

type WorkflowStep = {
  if?: string;
  id?: string;
  name?: string;
  uses?: string;
  with?: {
    "if-no-files-found"?: string;
    name?: string;
    path?: string;
    script?: string;
  };
};

type Workflow = {
  jobs?: {
    comment?: {
      steps?: WorkflowStep[];
    };
  };
};

type ProducerWorkflow = {
  name: string;
  "run-name": string;
  on?: {
    pull_request?: {
      paths?: string[];
      types?: string[];
    };
  };
  jobs?: {
    scope?: {
      steps?: WorkflowStep[];
    };
    scan?: {
      "runs-on"?: string;
      steps?: WorkflowStep[];
    };
    "scan-ios"?: {
      "runs-on"?: string;
    };
    "scan-macos"?: {
      "runs-on"?: string;
    };
  };
};

type Artifact = {
  expired: boolean;
  id: number;
  name: string;
  size_in_bytes?: number;
};

type ExistingComment = {
  body?: string;
  id: number;
  user?: {
    login?: string;
    type?: string;
  };
};

type WorkflowRun = {
  display_title?: string | null;
  event: string;
  name: string;
  repository: { full_name: string };
  status?: string;
  head_sha: string;
  id: number;
  pull_requests?: Array<{ number: number }>;
  run_attempt: number;
  run_number: number;
  workflow_id: number;
};

type ProducerEvent = {
  eventName: "pull_request" | "workflow_dispatch";
  action?: string;
  draft?: boolean;
};

function producerRunMetadata(
  platform: "iOS" | "macOS",
  source: ProducerEvent = { eventName: "pull_request", action: "ready_for_review", draft: false },
) {
  const file = platform === "iOS" ? PRODUCER_WORKFLOW_PATH : MACOS_PRODUCER_WORKFLOW_PATH;
  const workflow = parse(readFileSync(file, "utf8")) as ProducerWorkflow;
  const github = {
    workflow: workflow.name,
    event_name: source.eventName,
    event:
      source.eventName === "pull_request"
        ? {
            action: source.action,
            pull_request: {
              draft: source.draft,
              title: "Untrusted PR title [report]",
              body: "Untrusted body",
            },
          }
        : {},
  };
  // These expressions use only typed booleans, strings, equality, and &&/||,
  // whose semantics match JavaScript for the explicit event contexts below.
  const display_title = workflow["run-name"].replace(
    /\$\{\{([\s\S]*?)\}\}/gu,
    (_match, expression: string) =>
      String(compileFunction(`return (${expression});`, ["github"])(github)),
  );
  return { name: workflow.name, event: source.eventName, display_title };
}

function readCommenterScript(): string {
  const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
  const step = workflow.jobs?.comment?.steps?.find(
    (candidate) => candidate.name === "Upsert Periphery PR comment",
  );
  const script = step?.with?.script;
  if (!script) {
    throw new Error("missing iOS Periphery commenter script");
  }
  return script;
}

const commenterScript = readCommenterScript();
const executeCommenter = compileFunction(`return (async () => {\n${commenterScript}\n})();`, [
  "require",
  "context",
  "core",
  "github",
]) as (require: NodeJS.Require, context: unknown, core: unknown, github: unknown) => Promise<void>;

async function runCommenter(
  artifact: Artifact,
  archiveData: Buffer,
  options: {
    platform?: "iOS" | "macOS";
    sourceEvent?: ProducerEvent;
    run?: Partial<WorkflowRun>;
    liveDraft?: boolean;
    liveDraftAfter?: boolean;
    liveStateAfter?: string;
    liveRepositoryAfter?: string;
    existingComments?: ExistingComment[];
    commentErrorStatus?: number;
    liveHeadSha?: string;
    liveHeadShaAfter?: string;
    runHeadSha?: string;
    runAttempt?: number;
    scanJobConclusion?: string;
    scopeJobConclusion?: string;
    workflowRuns?: Partial<WorkflowRun>[];
  } = {},
) {
  const platform = options.platform ?? "iOS";
  const run: WorkflowRun = {
    ...producerRunMetadata(platform, options.sourceEvent),
    head_sha: options.runHeadSha ?? "head-sha",
    id: 12345,
    pull_requests: [{ number: 123 }],
    repository: { full_name: "openclaw/openclaw" },
    run_attempt: options.runAttempt ?? 2,
    run_number: 8,
    workflow_id: 999,
    ...options.run,
  };
  const apiCalls: string[] = [];
  const core = {
    infos: [] as string[],
    warnings: [] as string[],
    info(message: string) {
      this.infos.push(message);
    },
    warning(message: string) {
      this.warnings.push(message);
    },
  };
  let downloadCount = 0;
  let artifactListCount = 0;
  let jobListCount = 0;
  let pullGetCount = 0;
  const createdBodies: string[] = [];
  const updatedBodies: string[] = [];
  const github = {
    rest: {
      actions: {
        listJobsForWorkflowRun() {},
        listWorkflowRunArtifacts() {},
        listWorkflowRuns() {},
        async downloadArtifact() {
          apiCalls.push("downloadArtifact");
          downloadCount += 1;
          return { data: archiveData };
        },
      },
      issues: {
        listComments() {},
        async createComment(params: { body: string }) {
          if (options.commentErrorStatus) {
            throw Object.assign(new Error("comment write failed"), {
              status: options.commentErrorStatus,
            });
          }
          apiCalls.push("createComment");
          createdBodies.push(params.body);
          options.existingComments?.push({
            id: 100,
            body: params.body,
            user: { login: "github-actions[bot]" },
          });
        },
        async updateComment(params: { body: string; comment_id: number }) {
          if (options.commentErrorStatus) {
            throw Object.assign(new Error("comment write failed"), {
              status: options.commentErrorStatus,
            });
          }
          apiCalls.push("updateComment");
          updatedBodies.push(params.body);
          const existing = options.existingComments?.find(
            (comment) => comment.id === params.comment_id,
          );
          if (existing) {
            existing.body = params.body;
          }
        },
      },
      pulls: {
        async get() {
          apiCalls.push("getPull");
          pullGetCount += 1;
          return {
            data: {
              base: {
                repo: {
                  full_name:
                    pullGetCount > 1
                      ? (options.liveRepositoryAfter ?? "openclaw/openclaw")
                      : "openclaw/openclaw",
                },
              },
              draft:
                pullGetCount > 1
                  ? (options.liveDraftAfter ?? options.liveDraft ?? false)
                  : (options.liveDraft ?? false),
              head: {
                sha:
                  pullGetCount > 1
                    ? (options.liveHeadShaAfter ?? options.liveHeadSha ?? "head-sha")
                    : (options.liveHeadSha ?? "head-sha"),
              },
              number: 123,
              state: pullGetCount > 1 ? (options.liveStateAfter ?? "open") : "open",
            },
          };
        },
      },
    },
    async paginate(request: unknown, params: Record<string, unknown>) {
      if (request === github.rest.actions.listJobsForWorkflowRun) {
        apiCalls.push("listJobs");
        expect(params).toMatchObject({ run_id: run.id, filter: "latest" });
        jobListCount += 1;
        return [
          {
            conclusion: options.scopeJobConclusion ?? "success",
            name: `Detect ${platform} scan scope`,
          },
          {
            conclusion: options.scanJobConclusion ?? "success",
            name: `Scan ${platform} dead code`,
          },
        ];
      }
      if (request === github.rest.actions.listWorkflowRunArtifacts) {
        apiCalls.push("listArtifacts");
        expect(params.run_id).toBe(run.id);
        artifactListCount += 1;
        return [
          {
            ...artifact,
            name:
              artifact.name ||
              `${platform.toLowerCase()}-periphery-dead-code-${run.id}-${run.run_attempt}`,
          },
        ];
      }
      if (request === github.rest.actions.listWorkflowRuns) {
        apiCalls.push("listRuns");
        expect(params).toMatchObject({
          workflow_id: run.workflow_id,
          event: "pull_request",
          head_sha: run.head_sha,
        });
        return options.workflowRuns?.map((candidate) => Object.assign({}, run, candidate)) ?? [run];
      }
      if (params.issue_number === 123) {
        apiCalls.push("listComments");
        return options.existingComments ?? [];
      }
      throw new Error(`unexpected paginate call: ${JSON.stringify(params)}`);
    },
  };
  const context = {
    payload: {
      workflow_run: run,
    },
    repo: {
      owner: "openclaw",
      repo: "openclaw",
    },
  };

  await executeCommenter(createRequire(import.meta.url), context, core, github);

  return {
    apiCalls,
    artifactListCount,
    core,
    createdBodies,
    downloadCount,
    jobListCount,
    pullGetCount,
    updatedBodies,
  };
}

function expectUnavailableComment(bodies: string[]): void {
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toContain("Periphery did not complete or its report could not be safely read.");
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function makeZip(
  files: Record<string, string>,
  options: { compressionMethod?: 0 | 8 } = {},
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const compressionMethod = options.compressionMethod ?? 0;

  for (const [name, contents] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const contentsBuffer = Buffer.from(contents, "utf8");
    const compressedBuffer =
      compressionMethod === 8 ? deflateRawSync(contentsBuffer) : contentsBuffer;
    const checksum = crc32(contentsBuffer);
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(compressionMethod),
      u16(0),
      u16(0),
      u32(checksum),
      u32(compressedBuffer.length),
      u32(contentsBuffer.length),
      u16(nameBuffer.length),
      u16(0),
      nameBuffer,
    ]);
    localParts.push(localHeader, compressedBuffer);
    centralParts.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(compressionMethod),
        u16(0),
        u16(0),
        u32(checksum),
        u32(compressedBuffer.length),
        u32(contentsBuffer.length),
        u16(nameBuffer.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32((0o100644 << 16) >>> 0),
        u32(offset),
        nameBuffer,
      ]),
    );
    offset += localHeader.length + compressedBuffer.length;
  }

  const localData = Buffer.concat(localParts);
  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(Object.keys(files).length),
    u16(Object.keys(files).length),
    u32(centralDirectory.length),
    u32(localData.length),
    u16(0),
  ]);

  return Buffer.concat([localData, centralDirectory, endOfCentralDirectory]);
}

function markFirstCentralDirectoryEntryEncrypted(archive: Buffer): Buffer {
  const result = Buffer.from(archive);
  const offset = result.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (offset < 0) {
    throw new Error("missing ZIP central directory entry");
  }
  result.writeUInt16LE(1, offset + 8);
  return result;
}

function setFirstEntryUncompressedSize(archive: Buffer, size: number): Buffer {
  const result = Buffer.from(archive);
  if (result.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("missing ZIP local file header");
  }
  result.writeUInt32LE(size, 22);
  const centralOffset = result.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (centralOffset < 0) {
    throw new Error("missing ZIP central directory entry");
  }
  result.writeUInt32LE(size, centralOffset + 24);
  return result;
}

describe("iOS Periphery comment workflow", () => {
  it("parses the workflow YAML and embedded github-script JavaScript", () => {
    const script = commenterScript;
    expect(script).not.toContain("node:child_process");
    expect(script).not.toContain("execFileSync");
    expect(() =>
      compileFunction(`return (async () => {\n${script}\n})();`, [
        "require",
        "context",
        "core",
        "github",
      ]),
    ).not.toThrow();
  });

  it("scopes the report artifact to the workflow attempt", () => {
    const workflow = parse(readFileSync(PRODUCER_WORKFLOW_PATH, "utf8")) as ProducerWorkflow;
    const upload = workflow.jobs?.scan?.steps?.find(
      (step) => step.name === "Upload Periphery report",
    );

    expect(upload?.with?.name).toBe(
      "ios-periphery-dead-code-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(upload?.if).toBe("always()");
    expect(upload?.with?.path).toBe("${{ runner.temp }}/ios-periphery");
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
  });

  it("uses hosted macOS capacity for scans", () => {
    const iosWorkflow = parse(readFileSync(PRODUCER_WORKFLOW_PATH, "utf8")) as ProducerWorkflow;
    const macosWorkflow = parse(
      readFileSync(MACOS_PRODUCER_WORKFLOW_PATH, "utf8"),
    ) as ProducerWorkflow;
    const sharedWorkflow = parse(
      readFileSync(SHARED_PRODUCER_WORKFLOW_PATH, "utf8"),
    ) as ProducerWorkflow;

    expect(iosWorkflow.jobs?.scan?.["runs-on"]).toBe("macos-26");
    expect(macosWorkflow.jobs?.scan?.["runs-on"]).toBe("macos-26");
    expect(sharedWorkflow.jobs?.["scan-ios"]?.["runs-on"]).toBe("macos-26");
    expect(sharedWorkflow.jobs?.["scan-macos"]?.["runs-on"]).toBe("macos-26");
  });
  it("accepts a valid small Periphery artifact", async () => {
    const archive = makeZip({
      "periphery.json": "[]\n",
      "periphery.status": "0\n",
    });
    const result = await runCommenter(
      {
        expired: false,
        id: 77,
        name: ARTIFACT_NAME,
        size_in_bytes: archive.length,
      },
      archive,
    );

    expect(result.downloadCount).toBe(1);
    expect(result.core.warnings).toEqual([]);
  });

  it("accepts deflated Periphery artifacts", async () => {
    const archive = makeZip(
      {
        "periphery.json": "[]\n",
        "periphery.status": "0\n",
      },
      { compressionMethod: 8 },
    );
    const result = await runCommenter(
      {
        expired: false,
        id: 77,
        name: ARTIFACT_NAME,
        size_in_bytes: archive.length,
      },
      archive,
    );

    expect(result.downloadCount).toBe(1);
    expect(result.core.warnings).toEqual([]);
  });

  it("rejects deflated entries that inflate past the per-file limit", async () => {
    const archive = setFirstEntryUncompressedSize(
      makeZip(
        {
          "periphery.json": `${" ".repeat(2 * 1024 * 1024 + 1)}[]\n`,
          "periphery.status": "0\n",
        },
        { compressionMethod: 8 },
      ),
      1,
    );
    const result = await runCommenter(
      {
        expired: false,
        id: 77,
        name: ARTIFACT_NAME,
        size_in_bytes: archive.length,
      },
      archive,
    );

    expectUnavailableComment(result.createdBodies);
    expect(result.core.warnings).toEqual([
      `Skipping ${ARTIFACT_NAME}; periphery.json exceeded the per-file size limit while reading.`,
    ]);
  });

  it("rejects oversized artifact metadata before download", async () => {
    const result = await runCommenter(
      {
        expired: false,
        id: 77,
        name: ARTIFACT_NAME,
        size_in_bytes: 1024 * 1024 + 1,
      },
      Buffer.alloc(0),
    );

    expect(result.downloadCount).toBe(0);
    expectUnavailableComment(result.createdBodies);
    expect(result.core.warnings).toEqual([
      `Skipping ${ARTIFACT_NAME}; compressed artifact size 1048577 exceeds the 1048576 byte limit.`,
    ]);
  });

  it("rejects unexpected artifact paths", async () => {
    const archive = makeZip({
      "../periphery.json": "[]\n",
      "periphery.status": "0\n",
    });
    const result = await runCommenter(
      {
        expired: false,
        id: 77,
        name: ARTIFACT_NAME,
        size_in_bytes: archive.length,
      },
      archive,
    );

    expectUnavailableComment(result.createdBodies);
    expect(result.core.warnings).toEqual([
      `Skipping ${ARTIFACT_NAME}; unexpected artifact entry ../periphery.json.`,
    ]);
  });

  it("rejects encrypted artifact entries", async () => {
    const archive = markFirstCentralDirectoryEntryEncrypted(
      makeZip({
        "periphery.json": "[]\n",
        "periphery.status": "0\n",
      }),
    );
    const result = await runCommenter(
      {
        expired: false,
        id: 77,
        name: ARTIFACT_NAME,
        size_in_bytes: archive.length,
      },
      archive,
    );

    expectUnavailableComment(result.createdBodies);
    expect(result.core.warnings).toEqual([
      `Skipping ${ARTIFACT_NAME}; periphery.json is encrypted.`,
    ]);
  });

  it("does not read artifacts from a stale workflow run", async () => {
    const result = await runCommenter(
      {
        expired: false,
        id: 77,
        name: ARTIFACT_NAME,
        size_in_bytes: 1,
      },
      Buffer.alloc(0),
      {
        liveHeadSha: "new-head",
        runHeadSha: "old-head",
      },
    );

    expect(result.artifactListCount).toBe(0);
    expect(result.downloadCount).toBe(0);
  });

  it("does not reuse an artifact from an earlier workflow attempt", async () => {
    const result = await runCommenter(
      {
        expired: false,
        id: 77,
        name: "ios-periphery-dead-code-12345-1",
        size_in_bytes: 1,
      },
      Buffer.alloc(0),
      {
        existingComments: [
          {
            body: "<!-- openclaw-ios-periphery-dead-code -->\nold findings",
            id: 99,
            user: { login: "github-actions[bot]", type: "Bot" },
          },
        ],
      },
    );

    expect(result.downloadCount).toBe(0);
    expect(result.core.warnings).toEqual([`No ${ARTIFACT_NAME} artifact found.`]);
    expect(result.updatedBodies).toHaveLength(1);
    expect(result.updatedBodies[0]).toContain(
      "Periphery did not complete or its report could not be safely read.",
    );
  });

  it("escapes finding text before creating a PR comment", async () => {
    const longName = `![click](https://example.invalid)\r\n@octocat|next${"a".repeat(260)}`;
    const archive = makeZip({
      "periphery.json": JSON.stringify([
        {
          kind: "<script>*bold*</script>",
          location: "Sources/Test.swift:12",
          name: longName,
        },
      ]),
      "periphery.status": "1\n",
    });
    const result = await runCommenter(
      {
        expired: false,
        id: 77,
        name: ARTIFACT_NAME,
        size_in_bytes: archive.length,
      },
      archive,
    );

    expect(result.createdBodies).toHaveLength(1);
    const body = result.createdBodies[0] ?? "";
    const parsed = markdownToIR(body, { linkify: true, tableMode: "bullets" });
    expect(body).not.toContain("\r");
    expect(parsed.text).toContain("<script>*bold*</script>");
    expect(parsed.text).toContain("![click](https://example.invalid) @octocat|next");
    expect(parsed.links).toEqual([]);
  });

  it("treats non-object finding entries as an unreadable report", async () => {
    const archive = makeZip({
      "periphery.json": "[null]\n",
      "periphery.status": "1\n",
    });
    const result = await runCommenter(
      {
        expired: false,
        id: 77,
        name: ARTIFACT_NAME,
        size_in_bytes: archive.length,
      },
      archive,
    );

    expectUnavailableComment(result.createdBodies);
  });

  it("bounds the rendered comment after escaping", async () => {
    const repeated = "{".repeat(500);
    const archive = makeZip({
      "periphery.json": JSON.stringify(
        Array.from({ length: 50 }, (_, index) => ({
          kind: repeated,
          location: `${repeated}${index}:${index}`,
          name: repeated,
        })),
      ),
      "periphery.status": "1\n",
    });
    const result = await runCommenter(
      {
        expired: false,
        id: 77,
        name: ARTIFACT_NAME,
        size_in_bytes: archive.length,
      },
      archive,
    );

    expect(result.createdBodies).toHaveLength(1);
    expect(result.createdBodies[0]?.length).toBeLessThanOrEqual(60_000);
  });

  it("warns without failing when workflow_run token cannot write comments", async () => {
    const archive = makeZip({
      "periphery.json": JSON.stringify([
        {
          kind: "function",
          location: "Sources/Test.swift:12",
          name: "unused",
        },
      ]),
      "periphery.status": "1\n",
    });
    const result = await runCommenter(
      {
        expired: false,
        id: 77,
        name: ARTIFACT_NAME,
        size_in_bytes: archive.length,
      },
      archive,
      {
        commentErrorStatus: 403,
      },
    );

    expect(result.createdBodies).toEqual([]);
    expect(result.updatedBodies).toEqual([]);
    expect(result.core.warnings).toContain(
      "Skipping Periphery PR comment for #123; GitHub token cannot write issue comments for this workflow_run.",
    );
  });

  it("does not overwrite a marker comment owned by another bot", async () => {
    const archive = makeZip({
      "periphery.json": JSON.stringify([
        {
          kind: "function",
          location: "Sources/Test.swift:12",
          name: "unused",
        },
      ]),
      "periphery.status": "1\n",
    });
    const result = await runCommenter(
      {
        expired: false,
        id: 77,
        name: ARTIFACT_NAME,
        size_in_bytes: archive.length,
      },
      archive,
      {
        existingComments: [
          {
            body: "<!-- openclaw-ios-periphery-dead-code -->",
            id: 99,
            user: { login: "another-app[bot]", type: "Bot" },
          },
        ],
      },
    );

    expect(result.updatedBodies).toEqual([]);
    expect(result.createdBodies).toHaveLength(1);
  });
});

describe.each(["iOS", "macOS"] as const)("%s Periphery publication admission", (platform) => {
  const name = `${platform} Periphery Dead Code`;
  const report = producerRunMetadata(platform);
  const passive = producerRunMetadata(platform, {
    eventName: "pull_request",
    action: "synchronize",
    draft: true,
  });
  const draft = producerRunMetadata(platform, {
    eventName: "pull_request",
    action: "converted_to_draft",
    draft: true,
  });
  const marker = `<!-- openclaw-${platform.toLowerCase()}-periphery-dead-code -->`;
  const archive = makeZip({
    "periphery.json": JSON.stringify([
      { kind: "function", location: "Sources/Test.swift:12", name: "unusedSyntheticFunction" },
    ]),
    "periphery.status": "1\n",
  });
  const publish = (options: Parameters<typeof runCommenter>[2] = {}) =>
    runCommenter({ expired: false, id: 77, name: "", size_in_bytes: archive.length }, archive, {
      platform,
      ...options,
    });
  const previousComments = (): [ExistingComment] => [
    { id: 99, body: `${marker}\nprevious findings`, user: { login: "github-actions[bot]" } },
  ];

  it.each([
    ["pull_request", "opened", false, "report"],
    ["pull_request", "synchronize", false, "report"],
    ["pull_request", "reopened", false, "report"],
    ["pull_request", "ready_for_review", false, "report"],
    ["pull_request", "converted_to_draft", true, "draft"],
    ["pull_request", "opened", true, "passive"],
    ["pull_request", "synchronize", true, "passive"],
    ["pull_request", "reopened", true, "passive"],
    ["pull_request", "ready_for_review", true, "passive"],
    ["workflow_dispatch", undefined, undefined, "manual"],
  ] satisfies Array<[ProducerEvent["eventName"], string | undefined, boolean | undefined, string]>)(
    "publishes according to producer event %s/%s draft=%s (%s)",
    async (eventName, action, sourceDraft, intent) => {
      const sourceEvent = { eventName, action, draft: sourceDraft };
      const metadata = producerRunMetadata(platform, sourceEvent);
      expect(metadata.display_title).toBe(`${name} [${intent}]`);
      const result = await publish({
        sourceEvent,
        liveDraft: sourceDraft,
        existingComments: previousComments(),
        scanJobConclusion: sourceDraft ? "skipped" : "success",
      });
      if (intent === "report" || intent === "draft") {
        expect(result.updatedBodies).toHaveLength(1);
        expect(result.updatedBodies[0]).toContain(
          intent === "report" ? "unusedSyntheticFunction" : "pull request is a draft",
        );
      } else {
        expect(result.apiCalls).toEqual([]);
      }
    },
  );

  it.each(["ready then passive", "passive then ready"])(
    "preserves ready findings: %s",
    async (order) => {
      const existingComments = previousComments();
      const ready = { ...report, id: 201, run_number: 10, run_attempt: 1 };
      const delayedPassive = {
        ...passive,
        id: 202,
        run_number: 11,
        run_attempt: 1,
      };
      const callbacks =
        order === "ready then passive" ? [ready, delayedPassive] : [delayedPassive, ready];
      for (const run of callbacks) {
        const result = await publish({
          run,
          existingComments,
          workflowRuns: [delayedPassive, ready],
          scanJobConclusion: run === delayedPassive ? "skipped" : "success",
        });
        if (run === delayedPassive) {
          expect(result.apiCalls).toEqual([]);
          expect(result.createdBodies).toEqual([]);
          expect(result.updatedBodies).toEqual([]);
        } else {
          expect(result.updatedBodies).toHaveLength(1);
          expect(result.updatedBodies[0]).toContain("unusedSyntheticFunction");
          expect(result.apiCalls.slice(-2)).toEqual(["getPull", "updateComment"]);
        }
      }
      expect(existingComments[0].body).toContain("unusedSyntheticFunction");
    },
  );

  it.each([true, false])("explicit draft cleanup respects live draft=%s", async (liveDraft) => {
    const existingComments = previousComments();
    const result = await publish({
      run: draft,
      liveDraft,
      existingComments,
      scanJobConclusion: "skipped",
    });
    expect(result.artifactListCount).toBe(0);
    expect(result.jobListCount).toBe(0);
    expect(result.downloadCount).toBe(0);
    expect(result.createdBodies).toEqual([]);
    if (liveDraft) {
      expect(result.updatedBodies).toHaveLength(1);
      expect(existingComments[0].body).toContain("pull request is a draft");
      expect(existingComments[0].body).not.toContain("no longer touches");
    } else {
      expect(result.updatedBodies).toEqual([]);
      expect(existingComments[0].body).toContain("previous findings");
    }
  });

  it.each([
    ["passive", `${name} [passive]`],
    ["manual", `${name} [manual]`],
    ["missing", undefined],
    ["null", null],
    ["old PR title", "Fix Swift findings"],
    ["unknown intent", `${name} [unknown]`],
    ["trailing text", `${name} [report] extra`],
    ["wrong workflow", `Other Periphery Dead Code [report]`],
  ])("records %s metadata as a no-op without API work", async (_label, display_title) => {
    const result = await publish({
      run: { display_title },
      existingComments: previousComments(),
      scanJobConclusion: "skipped",
    });
    expect(result.apiCalls).toEqual([]);
    expect(result.core.infos.length).toBeGreaterThan(0);
    expect(result.updatedBodies).toEqual([]);
    expect(result.createdBodies).toEqual([]);
  });

  it.each([
    ["new report", { id: 54321, run_number: 9 }, true],
    ["pending report", { id: 54321, run_number: 9, status: "queued" }, true],
    ["new attempt", { run_attempt: 3 }, true],
    ["pending attempt", { run_attempt: 3, status: "in_progress" }, true],
    ["other PR", { id: 54321, run_number: 9, pull_requests: [{ number: 456 }] }, false],
    ["passive", { ...passive, id: 54321, run_number: 9 }, false],
    ["delayed converted_to_draft", { ...draft, id: 54321, run_number: 9 }, false],
    ["missing admission", { id: 54321, run_number: 9, display_title: undefined }, false],
    [
      "malformed admission",
      { id: 54321, run_number: 9, display_title: `${name} [report] suffix` },
      false,
    ],
  ] satisfies Array<[string, Partial<WorkflowRun>, boolean]>)(
    "supersession eligibility: %s",
    async (_label, candidate, supersedes) => {
      const result = await publish({ workflowRuns: [candidate] });
      expect(result.createdBodies).toHaveLength(supersedes ? 0 : 1);
      expect(result.updatedBodies).toEqual([]);
    },
  );

  it.each([
    ["new draft", draft, true],
    ["stale report", report, false],
    ["passive draft", passive, false],
  ])("draft cleanup supersession: %s", async (_label, candidate, supersedes) => {
    const result = await publish({
      run: draft,
      liveDraft: true,
      existingComments: previousComments(),
      workflowRuns: [{ ...candidate, id: 54321, run_number: 9, status: "queued" }],
    });
    expect(result.updatedBodies).toHaveLength(supersedes ? 0 : 1);
    expect(result.artifactListCount).toBe(0);
  });

  it.each([
    ["head", { liveHeadShaAfter: "new-head" }],
    ["draft", { liveDraftAfter: true }],
  ])("revalidates %s before creating a comment", async (_label, options) => {
    const result = await publish(options);
    expect(result.pullGetCount).toBe(2);
    expect(result.apiCalls.at(-1)).toBe("getPull");
    expect(result.createdBodies).toEqual([]);
  });

  it.each([
    ["head", { liveHeadShaAfter: "new-head" }],
    ["ready to draft", { liveDraftAfter: true }],
    [
      "draft to ready",
      {
        liveDraft: true,
        liveDraftAfter: false,
        run: draft,
        scanJobConclusion: "skipped",
      },
    ],
    ["closed", { liveStateAfter: "closed" }],
    ["repository", { liveRepositoryAfter: "other/repository" }],
  ] satisfies Array<[string, Parameters<typeof runCommenter>[2]]>)(
    "rejects %s changes before writing",
    async (_label, options) => {
      const result = await publish({ ...options, existingComments: previousComments() });
      expect(result.pullGetCount).toBe(2);
      expect(result.apiCalls.at(-1)).toBe("getPull");
      expect(result.updatedBodies).toEqual([]);
      expect(result.createdBodies).toEqual([]);
    },
  );

  it("does not consume an admitted report while the PR is draft", async () => {
    const result = await publish({ liveDraft: true });
    expect(result.jobListCount).toBe(0);
    expect(result.artifactListCount).toBe(0);
    expect(result.createdBodies).toEqual([]);
  });

  it("cleans up genuine scope loss on the report path", async () => {
    const result = await publish({
      existingComments: previousComments(),
      scanJobConclusion: "skipped",
    });
    expect(result.jobListCount).toBe(1);
    expect(result.artifactListCount).toBe(0);
    expect(result.updatedBodies).toHaveLength(1);
    expect(result.updatedBodies[0]).toContain(`no longer touches ${platform} scan scope`);
    expect(result.updatedBodies[0]).not.toContain("is a draft");
  });

  it.each([
    ["scope failure", "failure", "skipped"],
    ["scan failure", "success", "failure"],
  ])(
    "reports unavailable for %s without a report",
    async (_label, scopeJobConclusion, scanJobConclusion) => {
      const result = await runCommenter(
        { expired: false, id: 77, name: "wrong-attempt", size_in_bytes: 1 },
        Buffer.alloc(0),
        { platform, scopeJobConclusion, scanJobConclusion },
      );
      expectUnavailableComment(result.createdBodies);
    },
  );

  it.each(["success", "scope cleanup", "draft cleanup"])(
    "does not create a new comment for %s",
    async (outcome) => {
      const result = await runCommenter(
        { expired: false, id: 77, name: "", size_in_bytes: 1 },
        makeZip({ "periphery.json": "[]", "periphery.status": "0" }),
        {
          platform,
          scanJobConclusion: outcome === "success" ? "success" : "skipped",
          liveDraft: outcome === "draft cleanup",
          run: outcome === "draft cleanup" ? draft : report,
        },
      );
      expect(result.createdBodies).toEqual([]);
      expect(result.updatedBodies).toEqual([]);
    },
  );
});
