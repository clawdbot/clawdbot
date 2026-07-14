import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { markdownToIR } from "../../packages/markdown-core/src/ir.js";

const WORKFLOW_PATH = ".github/workflows/ios-periphery-comment.yml";
const PRODUCER_WORKFLOW_PATH = ".github/workflows/ios-periphery.yml";
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
      steps?: WorkflowStep[];
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
  head_sha: string;
  id: number;
  pull_requests?: Array<{ number: number }>;
  run_attempt: number;
  run_number: number;
  workflow_id: number;
};

function commenterScript(): string {
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

function scopeScript(): string {
  const workflow = parse(readFileSync(PRODUCER_WORKFLOW_PATH, "utf8")) as ProducerWorkflow;
  const step = workflow.jobs?.scope?.steps?.find((candidate) => candidate.id === "scope");
  const script = step?.with?.script;
  if (!script) {
    throw new Error("missing iOS Periphery scope script");
  }
  return script;
}

async function runScope(options: {
  diffExitCode?: number;
  draft?: boolean;
  eventName?: string;
  files?: Array<string | { filename: string; previous_filename?: string }>;
}): Promise<string | undefined> {
  const outputs = new Map<string, string>();
  const core = {
    setOutput(name: string, value: string) {
      outputs.set(name, value);
    },
  };
  const context = {
    eventName: options.eventName ?? "pull_request",
    payload: {
      pull_request: {
        base: { sha: "base-sha" },
        draft: options.draft ?? false,
        number: 123,
      },
    },
    repo: {
      owner: "openclaw",
      repo: "openclaw",
    },
  };
  const exec = {
    async getExecOutput(command: string, args: string[]) {
      if (command !== "git" || args.slice(0, 5).join(" ") !== "diff --quiet base-sha HEAD --") {
        throw new Error(`unexpected scope command: ${command} ${args.join(" ")}`);
      }
      if (options.diffExitCode !== undefined) {
        return { exitCode: options.diffExitCode };
      }
      const pathspecs = args.slice(5);
      const filenames = (options.files ?? []).flatMap((file) =>
        typeof file === "string"
          ? [file]
          : [file.filename, file.previous_filename].filter((name): name is string => Boolean(name)),
      );
      const changed = filenames.some((filename) =>
        pathspecs.some((pathspec) =>
          pathspec.endsWith("/") ? filename.startsWith(pathspec) : filename === pathspec,
        ),
      );
      return { exitCode: changed ? 1 : 0 };
    },
  };
  const execute = compileFunction(`return (async () => {\n${scopeScript()}\n})();`, [
    "context",
    "core",
    "exec",
  ]) as (context: unknown, core: unknown, exec: unknown) => Promise<void>;

  await execute(context, core, exec);
  return outputs.get("should-scan");
}

async function runCommenter(
  artifact: Artifact,
  archiveData: Buffer,
  options: {
    existingComments?: ExistingComment[];
    commentErrorStatus?: number;
    liveHeadSha?: string;
    liveHeadShaAfter?: string;
    runHeadSha?: string;
    runAttempt?: number;
    scanJobConclusion?: string;
    scopeJobConclusion?: string;
    workflowRuns?: WorkflowRun[];
  } = {},
) {
  const script = commenterScript();
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
          createdBodies.push(params.body);
        },
        async updateComment(params: { body: string }) {
          if (options.commentErrorStatus) {
            throw Object.assign(new Error("comment write failed"), {
              status: options.commentErrorStatus,
            });
          }
          updatedBodies.push(params.body);
        },
      },
      pulls: {
        async get() {
          pullGetCount += 1;
          return {
            data: {
              base: { repo: { full_name: "openclaw/openclaw" } },
              head: {
                sha:
                  pullGetCount > 1
                    ? (options.liveHeadShaAfter ?? options.liveHeadSha ?? "head-sha")
                    : (options.liveHeadSha ?? "head-sha"),
              },
              number: 123,
              state: "open",
            },
          };
        },
      },
    },
    async paginate(_request: unknown, params: Record<string, unknown>) {
      if (params.run_id === 12345 && params.filter === "latest") {
        jobListCount += 1;
        return [
          {
            conclusion: options.scopeJobConclusion ?? "success",
            name: "Detect iOS scan scope",
          },
          {
            conclusion: options.scanJobConclusion ?? "success",
            name: "Scan iOS dead code",
          },
        ];
      }
      if (params.run_id === 12345) {
        artifactListCount += 1;
        return [{ ...artifact, name: artifact.name || ARTIFACT_NAME }];
      }
      if (params.workflow_id === 999) {
        return (
          options.workflowRuns ?? [
            {
              head_sha: options.runHeadSha ?? "head-sha",
              id: 12345,
              run_attempt: options.runAttempt ?? 2,
              run_number: 8,
              workflow_id: 999,
            },
          ]
        );
      }
      if (params.issue_number === 123) {
        return options.existingComments ?? [];
      }
      throw new Error(`unexpected paginate call: ${JSON.stringify(params)}`);
    },
  };
  const context = {
    payload: {
      workflow_run: {
        event: "pull_request",
        head_sha: options.runHeadSha ?? "head-sha",
        id: 12345,
        name: "iOS Periphery Dead Code",
        pull_requests: [{ number: 123 }],
        repository: { full_name: "openclaw/openclaw" },
        run_attempt: options.runAttempt ?? 2,
        run_number: 8,
        workflow_id: 999,
      },
    },
    repo: {
      owner: "openclaw",
      repo: "openclaw",
    },
  };
  const execute = compileFunction(`return (async () => {\n${script}\n})();`, [
    "require",
    "context",
    "core",
    "github",
  ]) as (
    require: NodeJS.Require,
    context: unknown,
    core: unknown,
    github: unknown,
  ) => Promise<void>;

  await execute(createRequire(import.meta.url), context, core, github);

  return {
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

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
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
    const script = commenterScript();
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

  it("runs scope detection for PR transitions that can clear stale findings", () => {
    const workflow = parse(readFileSync(PRODUCER_WORKFLOW_PATH, "utf8")) as ProducerWorkflow;

    expect(workflow.on?.pull_request?.types).toContain("converted_to_draft");
    expect(workflow.on?.pull_request?.paths).toBeUndefined();
    expect(() =>
      compileFunction(`return (async () => {\n${scopeScript()}\n})();`, [
        "context",
        "core",
        "exec",
      ]),
    ).not.toThrow();
    expect(scopeScript()).toContain("exec.getExecOutput");
    expect(scopeScript()).not.toContain("pulls.listFiles");
  });

  it.each([
    {
      expected: "false",
      files: ["apps/ios/Sources/Test.swift"],
      name: "draft pull request",
      options: { draft: true },
    },
    {
      expected: "true",
      files: ["apps/ios/Sources/Test.swift"],
      name: "iOS change",
      options: {},
    },
    {
      expected: "false",
      files: ["docs/index.md"],
      name: "out-of-scope change",
      options: {},
    },
    {
      expected: "true",
      files: [
        {
          filename: "docs/Moved.swift",
          previous_filename: "apps/ios/Sources/Moved.swift",
        },
      ],
      name: "iOS file renamed out of scope",
      options: {},
    },
    {
      expected: "true",
      files: [],
      name: "manual dispatch",
      options: { eventName: "workflow_dispatch" },
    },
  ])("sets scope output for $name", async ({ expected, files, options }) => {
    await expect(runScope({ ...options, files })).resolves.toBe(expected);
  });

  it("fails closed when git cannot compare the base and head", async () => {
    await expect(runScope({ diffExitCode: 128 })).rejects.toThrow(
      "git diff failed with exit code 128",
    );
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

  it("replaces stale findings when the producer intentionally skips a scan", async () => {
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
            body: "<!-- openclaw-ios-periphery-dead-code -->\nprevious findings",
            id: 99,
            user: { login: "github-actions[bot]", type: "Bot" },
          },
        ],
        scanJobConclusion: "skipped",
      },
    );

    expect(result.jobListCount).toBe(1);
    expect(result.artifactListCount).toBe(0);
    expect(result.createdBodies).toEqual([]);
    expect(result.updatedBodies).toHaveLength(1);
    expect(result.updatedBodies[0]).toContain(
      "Periphery scan skipped because the pull request is a draft or no longer touches iOS scan scope.",
    );
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

  it("revalidates the PR head before creating a comment", async () => {
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
        liveHeadShaAfter: "new-head",
      },
    );

    expect(result.downloadCount).toBe(1);
    expect(result.pullGetCount).toBe(2);
    expect(result.createdBodies).toEqual([]);
    expect(result.updatedBodies).toEqual([]);
  });

  it("does not publish findings from a superseded workflow attempt", async () => {
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
        name: "ios-periphery-dead-code-12345-1",
        size_in_bytes: archive.length,
      },
      archive,
      {
        runAttempt: 1,
        workflowRuns: [
          {
            head_sha: "head-sha",
            id: 12345,
            run_attempt: 2,
            run_number: 8,
            workflow_id: 999,
          },
        ],
      },
    );

    expect(result.downloadCount).toBe(1);
    expect(result.pullGetCount).toBe(2);
    expect(result.createdBodies).toEqual([]);
    expect(result.updatedBodies).toEqual([]);
  });

  it("does not publish findings from a newer run for the same pull request", async () => {
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
        workflowRuns: [
          {
            head_sha: "head-sha",
            id: 54321,
            pull_requests: [{ number: 123 }],
            run_attempt: 1,
            run_number: 9,
            workflow_id: 999,
          },
        ],
      },
    );

    expect(result.createdBodies).toEqual([]);
    expect(result.updatedBodies).toEqual([]);
  });

  it("does not treat a run for another pull request as superseding", async () => {
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
        workflowRuns: [
          {
            head_sha: "head-sha",
            id: 54321,
            pull_requests: [{ number: 456 }],
            run_attempt: 1,
            run_number: 9,
            workflow_id: 999,
          },
        ],
      },
    );

    expect(result.createdBodies).toHaveLength(1);
    expect(result.updatedBodies).toEqual([]);
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
