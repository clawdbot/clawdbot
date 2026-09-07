// Public Gateway operations against task-owned hooks, repositories, and local speech fixtures.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import type {
  createQaChannelTransport,
  MockOpenAiRequestSnapshot,
  QaBusState,
  QaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { waitForHotReloadFact } from "./gateway-config-hot-reload-fixtures.js";

type PolicyProof = {
  rpc: <T>(method: string, params?: unknown) => Promise<T>;
  patch: (change: unknown, replacePaths?: string[]) => Promise<unknown>;
  proveGroup: (prefix: string, run: () => Promise<void>) => Promise<void>;
  verifyContinuity: (prefix: string, observation: string) => Promise<void>;
};
type Http = (route: string, body?: unknown) => Promise<{ status: number; text: string }>;
const SESSION_KEY = "agent:qa:hot-reload-policy";
const runFile = promisify(execFile);

async function startSpeechFixture() {
  const requests: Array<{ path: string; input: string; voice: string; response_format: string }> =
    [];
  // A valid, silent PCM WAV lets the real provider return and decode an inline audio clip.
  const wav = Buffer.alloc(364);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8_000, 24);
  wav.writeUInt32LE(16_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      assert(request.url && request.url.endsWith("/audio/speech"));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({
        path: request.url,
        input: body.input,
        voice: body.voice,
        response_format: body.response_format,
      });
      response.writeHead(200, { "content-type": "audio/wav" });
      response.end(wav);
    })().catch((error: unknown) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    wav,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export async function proveHotReloadPolicy({
  gateway,
  temporaryRoot,
  outputDir,
  rpc,
  patch,
  http,
  proveGroup,
  verifyContinuity,
}: PolicyProof & {
  gateway: QaGatewayChild;
  temporaryRoot: string;
  outputDir: string;
  http: Http;
}) {
  const root = await fs.mkdtemp(path.join(temporaryRoot, "policy-"));
  const observations: Array<Record<string, unknown>> = [];
  const initial = (await rpc<{ config: OpenClawConfig }>("config.get")).config;
  await proveGroup("tts", async () => {
    const speech = await startSpeechFixture();
    try {
      const apiKey = `qa-speech-${randomUUID()}`;
      for (const [index, voice] of ["alloy", "coral", "alloy"].entries()) {
        const auto = index === 1 ? "always" : "off";
        await patch({
          tts: {
            auto,
            provider: "openai",
            maxTextLength: 128,
            providers: {
              openai: {
                apiKey,
                baseUrl: `${speech.baseUrl}/generation-${index % 2}/v1`,
                model: "gpt-4o-mini-tts",
                voice,
                responseFormat: "wav",
              },
            },
          },
        });
        const status = await rpc<{ auto: string; enabled: boolean; provider: string }>(
          "tts.status",
        );
        assert.equal(status.auto, auto);
        assert.equal(status.enabled, auto !== "off");
        assert.equal(status.provider, "openai");
        const text = `Synthetic speech generation ${index}`;
        const clip = await rpc<{ provider: string; mimeType: string; audioBase64: string }>(
          "tts.speak",
          { text },
        );
        assert.equal(clip.provider, "openai");
        assert.equal(clip.mimeType, "audio/wav");
        assert.deepEqual(Buffer.from(clip.audioBase64, "base64"), speech.wav);
        assert.deepEqual(speech.requests.at(-1), {
          path: `/generation-${index % 2}/v1/audio/speech`,
          input: text,
          voice,
          response_format: "wav",
        });
        const requestCount = speech.requests.length;
        await patch({ tts: { maxTextLength: 2 } });
        await assert.rejects(rpc("tts.speak", { text }), /text too long.*max 2/);
        assert.equal(speech.requests.length, requestCount);
      }
      observations.push({ prefix: "tts", requests: speech.requests });
      await verifyContinuity(
        "tts",
        "Real OpenAI speech plugin sent changed voice and endpoint A→B→A to a named local WAV fixture; status and text-limit enforcement changed immediately",
      );
    } finally {
      try {
        await patch({ tts: initial.tts ?? null }, ["tts"]);
      } finally {
        await speech.stop();
      }
    }
  });

  await proveGroup("hooks.internal", async () => {
    const logPath = path.join(outputDir, "gateway-config-hot-reload-hooks.log");
    await fs.writeFile(logPath, "");
    const hook = async (directory: string, name: string, event: string, marker: string) => {
      const hookRoot = path.join(root, directory, name);
      await fs.mkdir(hookRoot, { recursive: true });
      await fs.writeFile(
        path.join(hookRoot, "HOOK.md"),
        `---\nname: ${name}\ndescription: Synthetic hot reload recorder\nmetadata: {"openclaw":{"events":["${event}"]}}\n---\n`,
      );
      await fs.writeFile(
        path.join(hookRoot, "handler.js"),
        `import { appendFileSync } from 'node:fs';\nexport default function(event) {\n  if (event.action === 'patch' && event.sessionKey === ${JSON.stringify(SESSION_KEY)}) appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(`${marker}|`)} + event.context.patch.label + '\\n');\n}\n`,
      );
    };
    await hook("first", "policy-recorder", "session", "A");
    await hook("second", "policy-recorder", "session", "B");
    await hook("broken", "policy-recorder", "session", "X");
    const rejectedImportMarker = `Synthetic rejected hook import ${randomUUID()}`;
    await fs.writeFile(
      path.join(root, "broken", "policy-recorder", "handler.js"),
      `throw new Error(${JSON.stringify(rejectedImportMarker)});\nexport default function() {}\n`,
    );
    // General session handlers run before the specific patch witness, including after entry disable.
    await hook("common", "policy-witness", "session:patch", "W");
    const configure = (directory: string, enabled = true, recorder = true) =>
      patch(
        {
          hooks: {
            internal: {
              enabled,
              load: { extraDirs: [path.join(root, directory), path.join(root, "common")] },
              entries: {
                "policy-recorder": { enabled: recorder },
                "policy-witness": { enabled: true },
              },
            },
          },
        },
        ["hooks.internal.load.extraDirs"],
      );
    const rows = async (label: string) =>
      (await fs.readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .filter((line) => line.endsWith(`|${label}`));
    const trigger = async (expected: string[]) => {
      const label = `policy-${randomUUID()}`;
      await rpc("sessions.patch", { key: SESSION_KEY, label });
      await waitForHotReloadFact("session patch witness", async () =>
        (await rows(label)).includes(`W|${label}`) ? true : undefined,
      );
      assert.deepEqual(
        await rows(label),
        expected.map((marker) => `${marker}|${label}`),
      );
      observations.push({ prefix: "hooks.internal", markers: expected });
    };
    try {
      await configure("first");
      await trigger(["A", "W"]);
      await assert.rejects(configure("broken"), (error: unknown) => {
        const message = String(error);
        assert.match(
          message,
          /Failed to load hook policy-recorder|persisted but was not applied to the active Gateway \(failed\)/,
        );
        observations.push({ prefix: "hooks.internal", rejectedImport: message.slice(0, 500) });
        return true;
      });
      await waitForHotReloadFact("rejected managed hook import diagnostic", () =>
        gateway.logs().includes(rejectedImportMarker) ? true : undefined,
      );
      await trigger(["A", "W"]);
      await configure("first");
      await configure("second");
      await trigger(["B", "W"]);
      await configure("second", true, false);
      await trigger(["W"]);
      await configure("second", false);
      const disabledLabel = `disabled-${randomUUID()}`;
      await rpc("sessions.patch", { key: SESSION_KEY, label: disabledLabel });
      await configure("second");
      await trigger(["B", "W"]);
      assert.deepEqual(await rows(disabledLabel), []);
      await verifyContinuity(
        "hooks.internal",
        "Rejected managed-hook import retained A and its gate; valid session:patch recorder replacement A→B ran exactly once, entry/global disable suppressed handlers, and re-enable restored B",
      );
    } finally {
      await patch({ hooks: { internal: initial.hooks?.internal ?? null } }, [
        "hooks.internal.load.extraDirs",
      ]);
    }
  });

  await proveGroup("worktreeRoot", async () => {
    const repository = path.join(root, "repository");
    await fs.mkdir(repository);
    const git = (args: string[]) => runFile("git", args, { cwd: repository });
    await git(["init", "--initial-branch=main"]);
    await fs.writeFile(path.join(repository, "proof.txt"), "Synthetic worktree allocation\n");
    await git(["add", "proof.txt"]);
    await git([
      "-c",
      "user.name=QA",
      "-c",
      "user.email=qa@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Synthetic fixture",
    ]);
    const worktrees: Array<{ id: string; path: string }> = [];
    try {
      for (const [index, generation] of ["a", "b", "a"].entries()) {
        const destination = path.join(root, `worktrees-${generation}`);
        await fs.mkdir(destination, { recursive: true });
        await patch({ worktreeRoot: destination });
        const worktree = await rpc<{ id: string; path: string }>("worktrees.create", {
          repoRoot: repository,
          name: `hot-reload-${index}`,
          baseRef: "main",
        });
        worktrees.push(worktree);
        assert(worktree.path.startsWith(`${await fs.realpath(destination)}${path.sep}`));
        for (const retained of worktrees) {
          assert.equal(
            await fs.readFile(path.join(retained.path, "proof.txt"), "utf8"),
            "Synthetic worktree allocation\n",
          );
        }
      }
      observations.push({
        prefix: "worktreeRoot",
        roots: ["a", "b", "a"],
        retained: worktrees.length,
      });
      await verifyContinuity(
        "worktreeRoot",
        "Public worktrees.create allocated real Git checkouts under A→B→A while all prior checkouts remained readable",
      );
    } finally {
      for (const worktree of worktrees) {
        assert.equal(
          (await rpc<{ removed: boolean }>("worktrees.remove", { id: worktree.id, force: true }))
            .removed,
          true,
        );
      }
      await patch({ worktreeRoot: initial.worktreeRoot ?? null });
    }
  });

  await proveGroup("mcp.apps.sandboxOrigin", async () => {
    const name = "hot-reload-origin";
    await rpc("board.widget.put", {
      sessionKey: SESSION_KEY,
      name,
      content: { kind: "html", html: "<p>Synthetic origin projection</p>" },
    });
    let sandboxPort: number | undefined;
    try {
      for (const sandboxOrigin of [
        "https://sandbox-a.example.invalid",
        "https://sandbox-b.example.invalid",
        null,
      ]) {
        await patch({ mcp: { apps: { sandboxOrigin } } });
        const board = await rpc<{
          widgets: Array<{
            name: string;
            sandboxOrigin?: string;
            sandboxPort?: number;
            frameUrl?: string;
          }>;
        }>("board.get", { sessionKey: SESSION_KEY });
        const widget = board.widgets.find((item) => item.name === name);
        assert(widget?.sandboxPort && widget.frameUrl);
        assert.equal(widget.sandboxOrigin, sandboxOrigin ?? undefined);
        sandboxPort ??= widget.sandboxPort;
        assert.equal(widget.sandboxPort, sandboxPort);
        const frame = await http(widget.frameUrl);
        assert.equal(frame.status, 200, frame.text);
        assert(frame.text.includes("Synthetic origin projection"));
      }
      observations.push({ prefix: "mcp.apps.sandboxOrigin", listenerRetained: true });
      await verifyContinuity(
        "mcp.apps.sandboxOrigin",
        "Fresh Board HTML views projected changed sandbox origins A→B→default while retaining the real sandbox listener and serving the stored widget",
      );
    } finally {
      await patch({ mcp: { apps: { sandboxOrigin: initial.mcp?.apps?.sandboxOrigin ?? null } } });
    }
  });

  await proveGroup("memory.citations", async () => {
    const note = path.join(gateway.workspaceDir, "memory", "hot-reload-citations.md");
    await fs.mkdir(path.dirname(note), { recursive: true });
    await fs.writeFile(note, "The synthetic hot reload lighthouse code is CITATION-47.\n");
    await gateway.runCli(["memory", "index", "--agent", "qa", "--force"]);
    try {
      for (const citations of ["off", "on", "off"] as const) {
        await patch({ memory: { citations } });
        const response = await http("/tools/invoke", {
          tool: "memory_search",
          sessionKey: SESSION_KEY,
          args: {
            query: "synthetic hot reload lighthouse code",
            corpus: "memory",
            minScore: 0,
            maxResults: 5,
          },
        });
        assert.equal(response.status, 200, response.text);
        const { result } = JSON.parse(response.text) as {
          result: {
            details: { results: Array<{ path: string; snippet: string; citation?: string }> };
          };
        };
        const details = result.details;
        const hit = details.results.find(
          (entry) => entry.path === "memory/hot-reload-citations.md",
        );
        assert(hit, JSON.stringify(details));
        assert(hit.snippet.includes("CITATION-47"));
        assert.equal(Boolean(hit.citation), citations === "on");
        assert.equal(
          hit.snippet.includes("Source: memory/hot-reload-citations.md#L"),
          citations === "on",
        );
      }
      observations.push({ prefix: "memory.citations", citations: ["off", "on", "off"] });
      await verifyContinuity(
        "memory.citations",
        "Real memory_search retrieved the same indexed note and removed→added→removed its citation field and Source text",
      );
    } finally {
      await patch({ memory: { citations: initial.memory?.citations ?? null } });
      await fs.rm(note);
    }
  });
  await fs.writeFile(
    path.join(outputDir, "gateway-config-hot-reload-policy.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
}

export async function proveHotReloadChannelPolicy({
  transport,
  state,
  providerRequests,
  patchChannels,
  rpc,
  patch,
  proveGroup,
  verifyContinuity,
}: PolicyProof & {
  transport: ReturnType<typeof createQaChannelTransport>;
  state: QaBusState;
  providerRequests: () => Promise<MockOpenAiRequestSnapshot[]>;
  patchChannels: PolicyProof["patch"];
}) {
  const channel = "qa-channel";
  const initial = (await rpc<{ config: OpenClawConfig }>("config.get")).config;
  const inbound = async (id: string, text: string, senderId = "qa-operator", group = false) => {
    const message = await transport.sendInbound({
      conversation: { kind: group ? "channel" : "direct", id },
      senderId,
      text,
    });
    const cursor = state.getSnapshot().cursor;
    await waitForHotReloadFact("channel policy turn consumed", () =>
      state.getAcknowledgedPollCursor("default") >= cursor ? true : undefined,
    );
    return message;
  };
  const outbound = (id: string) =>
    state
      .getSnapshot()
      .messages.filter(
        (message) => message.direction === "outbound" && message.conversation.id === id,
      );

  await proveGroup("commands", async () => {
    try {
      for (const [index, config] of [false, true, false].entries()) {
        await patchChannels({ commands: { config, ownerAllowFrom: ["qa-operator"] } });
        const id = `hot-command-${index}`;
        await inbound(id, "/config show commands.config");
        const replies = outbound(id);
        assert.equal(replies.length, 1, JSON.stringify(replies));
        assert.equal(replies[0]?.text.includes("Config commands.config:"), config);
        if (config) {
          assert(replies[0]?.text.includes("true"));
        } else {
          assert.match(replies[0]?.text ?? "", /\/config is disabled/);
        }
      }
      await verifyContinuity(
        "commands",
        "The same running QA channel rejected→executed→rejected the real /config command after shared-policy refresh; the manually stopped account stayed stopped",
      );
    } finally {
      await patchChannels(
        {
          commands: {
            config: initial.commands?.config ?? null,
            ownerAllowFrom: initial.commands?.ownerAllowFrom ?? null,
          },
        },
        ["commands.ownerAllowFrom"],
      );
    }
  });

  await proveGroup("accessGroups", async () => {
    try {
      await patchChannels(
        {
          channels: {
            [channel]: {
              groupPolicy: "allowlist",
              groupAllowFrom: ["accessGroup:hot-reload-policy"],
            },
          },
        },
        ["channels.qa-channel.groupAllowFrom"],
      );
      for (const [index, allowed] of [true, false, true].entries()) {
        await patchChannels(
          {
            accessGroups: {
              "hot-reload-policy": {
                type: "message.senders",
                members: { [channel]: allowed ? ["qa-control", "qa-operator"] : ["qa-control"] },
              },
            },
          },
          ["accessGroups.hot-reload-policy.members.qa-channel"],
        );
        const id = `hot-access-${index}`;
        const marker = `HOT_ACCESS_${index}`;
        await inbound(id, `Reply exactly \`${marker}\``, "qa-operator", true);
        assert.equal(
          outbound(id).filter((message) => message.text.includes(marker)).length,
          allowed ? 1 : 0,
        );
        const control = `HOT_CONTROL_${index}`;
        await inbound(id, `Reply exactly \`${control}\``, "qa-control", true);
        assert.equal(outbound(id).filter((message) => message.text.includes(control)).length, 1);
      }
      await verifyContinuity(
        "accessGroups",
        "A real shared-room sender was admitted→rejected→admitted as group membership changed; a retained allowed sender replied in every phase and the stopped account stayed stopped",
      );
    } finally {
      await patchChannels(
        {
          channels: {
            [channel]: {
              groupPolicy: initial.channels?.[channel]?.groupPolicy ?? null,
              groupAllowFrom: initial.channels?.[channel]?.groupAllowFrom ?? null,
            },
          },
          accessGroups: {
            "hot-reload-policy": initial.accessGroups?.["hot-reload-policy"] ?? null,
          },
        },
        ["channels.qa-channel.groupAllowFrom", "accessGroups.hot-reload-policy.members.qa-channel"],
      );
    }
  });

  await proveGroup("surfaces", async () => {
    try {
      for (const [index, policy] of ["allow", "disallow", "allow"].entries()) {
        await patchChannels({ surfaces: { [channel]: { silentReply: { group: policy } } } });
        const cursor = (await providerRequests()).at(-1)?.cursor ?? 0;
        const id = `hot-surface-${index}`;
        const marker = `HOT_SURFACE_${index}`;
        await inbound(id, `Reply exactly \`${marker}\``, "qa-operator", true);
        assert.equal(outbound(id).filter((message) => message.text.includes(marker)).length, 1);
        const requests = (await providerRequests()).filter(
          (request) => request.cursor > cursor && request.prompt.includes(marker),
        );
        assert(requests.length > 0, "Surface policy turn did not reach the mock provider");
        const guidance = 'If no response is needed, reply with exactly "NO_REPLY"';
        assert.equal(requests[0]?.allInputText.includes(guidance), policy === "allow");
      }
      // Deliberate NO_REPLY stays intentional even under disallow; this setting changes guidance.
      await verifyContinuity(
        "surfaces",
        "Real group turns gained→lost→regained silent-reply guidance in their model request and delivered their requested ordinary replies",
      );
    } finally {
      await patchChannels({ surfaces: initial.surfaces ?? null }, ["surfaces"]);
    }
  });

  for (const kind of ["exec", "plugin"] as const) {
    await proveGroup(`approvals.${kind}`, async () => {
      const phases = [
        { enabled: false, agentFilter: ["qa"], target: "approval-a", delivered: false },
        { enabled: true, agentFilter: ["other-agent"], target: "approval-a", delivered: false },
        { enabled: true, agentFilter: ["qa"], target: "approval-a", delivered: true },
        { enabled: true, agentFilter: ["qa"], target: "approval-b", delivered: true },
        { enabled: false, agentFilter: ["qa"], target: "approval-b", delivered: false },
      ];
      try {
        for (const [index, phase] of phases.entries()) {
          await patch(
            {
              approvals: {
                [kind]: {
                  enabled: phase.enabled,
                  mode: "targets",
                  agentFilter: phase.agentFilter,
                  targets: [{ channel, accountId: "default", to: `dm:${phase.target}` }],
                },
              },
            },
            [`approvals.${kind}.agentFilter`, `approvals.${kind}.targets`],
          );
          const marker = `HOT_APPROVAL_${kind}_${index}`;
          const result = await rpc<{
            id: string;
            status?: string;
            deliveryRoute?: string;
            decision?: null;
          }>(`${kind}.approval.request`, {
            ...(kind === "exec"
              ? { command: `printf ${marker}`, host: "gateway" }
              : {
                  pluginId: "qa-lab",
                  title: marker,
                  description: "Synthetic policy forwarding request",
                }),
            agentId: "qa",
            sessionKey: "agent:qa:main",
            twoPhase: true,
            timeoutMs: 30_000,
          });
          assert.equal(
            result.deliveryRoute === "forwarder",
            phase.delivered,
            JSON.stringify(result),
          );
          if (phase.delivered) {
            try {
              const message = await transport.waitForOutbound({
                conversation: { kind: "direct", id: phase.target },
                textIncludes: marker,
                timeoutMs: 30_000,
              });
              assert.equal(message.isError, undefined);
              assert(
                !outbound(phase.target === "approval-a" ? "approval-b" : "approval-a").some(
                  (entry) => entry.text.includes(marker),
                ),
              );
            } finally {
              await rpc(`${kind}.approval.resolve`, { id: result.id, decision: "deny" });
            }
          } else {
            assert(
              !state
                .getSnapshot()
                .messages.some(
                  (message) => message.direction === "outbound" && message.text.includes(marker),
                ),
            );
            if (result.status === "accepted") {
              await rpc(`${kind}.approval.resolve`, { id: result.id, decision: "deny" });
            } else {
              assert.equal(result.decision, null);
            }
          }
        }
        await verifyContinuity(
          `approvals.${kind}`,
          "Public approval requests recorded no forwarding while disabled/filtered, delivered actual cards to target A then B, and stopped forwarding after disable",
        );
      } finally {
        await patch({ approvals: { [kind]: initial.approvals?.[kind] ?? null } }, [
          `approvals.${kind}.agentFilter`,
          `approvals.${kind}.targets`,
        ]);
      }
    });
  }
}
