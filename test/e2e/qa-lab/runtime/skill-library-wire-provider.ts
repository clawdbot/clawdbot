// Mock-provider E2E: only model decisions are synthetic. Tools execute in the real runtime.
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type {
  SkillsLibraryReceipt,
  SkillsLibrarySaveParams,
} from "../../../../packages/gateway-protocol/src/schema/skill-library.js";
import { closeWireServer } from "./paired-node-worker-wire-fixture.js";

type ProviderItem = {
  type?: string;
  role?: string;
  content?: unknown;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: unknown;
};
type CatalogSkill = { name: string; location: string };
export type SkillLibraryTurnObservation = {
  catalogs: CatalogSkill[][];
  readOutput?: string;
  execOutput?: string;
};
type AuthorObservation = { created?: string; read?: string; updated?: string };

export function executableSkillLibraryBundle(
  reference = "ALICE-RESOURCE-1\n",
): SkillsLibrarySaveParams {
  return {
    slug: "execution-proof",
    expectedRevision: null,
    content:
      "---\nname: execution-proof\ndescription: Read the synthetic skill and execute its bundled report helper.\n---\nRun scripts/report.mjs relative to this SKILL.md. It reads this file and references/value.txt.\n",
    files: [
      { path: "references/value.txt", content: reference },
      { path: "references/binary.dat", content: "AAEC/w==", encoding: "base64" },
      {
        path: "scripts/report.mjs",
        executable: true,
        content: [
          'import fs from "node:fs";',
          'import { fileURLToPath } from "node:url";',
          'console.log("SKILL_LIBRARY_OUTPUT=" + JSON.stringify({',
          '  skill: fs.readFileSync(new URL("../SKILL.md", import.meta.url), "utf8"),',
          '  reference: fs.readFileSync(new URL("../references/value.txt", import.meta.url), "utf8"),',
          '  binary: fs.readFileSync(new URL("../references/binary.dat", import.meta.url)).toString("hex"),',
          "  executable: (fs.statSync(fileURLToPath(import.meta.url)).mode & 0o111) !== 0,",
          '  directory: fs.realpathSync(fileURLToPath(new URL("../", import.meta.url))),',
          '  helper: "bundled-helper-v1"',
          "}));",
          "",
        ].join("\n"),
      },
    ],
  };
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n");
}

function catalogSkills(instructions: string): CatalogSkill[] {
  const catalog = [...instructions.matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/gu)]
    .map((match) => match[1])
    .join("\n");
  const decode = (text: string) =>
    text
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&");
  return [...catalog.matchAll(/<skill>([\s\S]*?)<\/skill>/gu)].map((match) => {
    const name = match[1]!.match(/<name>(.*?)<\/name>/u)?.[1];
    const location = match[1]!.match(/<location>(.*?)<\/location>/u)?.[1];
    if (!name || !location) {
      throw new Error("Skill catalog omitted a name or location");
    }
    return { name: decode(name), location: decode(location) };
  });
}

function sse(response: ServerResponse, event: unknown) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function reply(response: ServerResponse, text: string) {
  const id = `msg_${randomUUID()}`;
  const item = {
    type: "message",
    id,
    role: "assistant",
    phase: "final_answer",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  sse(response, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...item, status: "in_progress", content: [] },
  });
  sse(response, {
    type: "response.output_text.delta",
    output_index: 0,
    content_index: 0,
    item_id: id,
    delta: text,
  });
  sse(response, { type: "response.output_item.done", output_index: 0, item });
  sse(response, {
    type: "response.completed",
    response: {
      id: `resp_${id}`,
      status: "completed",
      output: [item],
      usage: { input_tokens: 32, output_tokens: 32, total_tokens: 64 },
    },
  });
  response.end("data: [DONE]\n\n");
}

function callTool(response: ServerResponse, callId: string, name: string, args: unknown) {
  const item = {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  };
  sse(response, {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...item, arguments: "" },
  });
  sse(response, {
    type: "response.function_call_arguments.delta",
    output_index: 0,
    item_id: item.id,
    delta: item.arguments,
  });
  sse(response, { type: "response.output_item.done", output_index: 0, item });
  sse(response, {
    type: "response.completed",
    response: {
      id: `resp_${callId}`,
      status: "completed",
      output: [item],
      usage: { input_tokens: 32, output_tokens: 16, total_tokens: 48 },
    },
  });
  response.end("data: [DONE]\n\n");
}

export async function startSkillLibraryWireProvider() {
  const issuedCalls = new Map<
    string,
    { name: string; arguments: string; previousCallIds: Set<string | undefined> }
  >();
  const observations = new Map<string, SkillLibraryTurnObservation>();
  const authorDrafts = new Map<
    string,
    { draft: SkillsLibrarySaveParams; updatedContent: string }
  >();
  const authorOutputs = new Map<string, AuthorObservation>();
  const holds = new Map<
    string,
    { promise: Promise<void>; release: () => void; entered: boolean }
  >();
  const errors: Error[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        instructions?: string;
        input?: ProviderItem[];
        tools?: Array<{ name?: string; parameters?: TSchema }>;
      };
      const input = body.input ?? [];
      // Native runtimes can append user-role context after the tagged scenario.
      const user =
        input
          .filter((item) => item.role === "user")
          .map((item) => contentText(item.content))
          .findLast((text) => /SKILL-LIBRARY-(?:PROBE|AUTHOR):[a-z0-9-]+/u.test(text)) ?? "";
      const match = user.match(/SKILL-LIBRARY-PROBE:([a-z0-9-]+)(?: name=([a-z0-9_-]+))?/u);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const emitTool = (callId: string, name: string, args: unknown) => {
        issuedCalls.set(callId, {
          name,
          arguments: JSON.stringify(args),
          previousCallIds: new Set(
            input.filter((item) => item.type === "function_call").map((item) => item.call_id),
          ),
        });
        callTool(response, callId, name, args);
      };
      const output = (callId: string) => {
        const issued = issuedCalls.get(callId);
        if (!issued) {
          return undefined;
        }
        // Replay may normalize call IDs. Correlate the actual echoed call and result instead.
        const echoed = input.findLast(
          (item) =>
            item.type === "function_call" &&
            item.name === issued.name &&
            item.arguments === issued.arguments &&
            !issued.previousCallIds.has(item.call_id),
        );
        const item = input.find(
          (candidate) =>
            candidate.type === "function_call_output" &&
            echoed?.call_id !== undefined &&
            candidate.call_id === echoed.call_id,
        );
        if (!item || item.output === undefined) {
          const identities = input
            .filter(
              (candidate) =>
                candidate.type === "function_call" || candidate.type === "function_call_output",
            )
            .slice(-8)
            .map(({ type, name, call_id }) => ({ type, name, call_id }));
          throw new Error(
            `Missing real tool result for ${callId}; replay identities: ${JSON.stringify(identities)}`,
          );
        }
        return typeof item.output === "string" ? item.output : JSON.stringify(item.output);
      };
      const authorMarker = user.match(/SKILL-LIBRARY-AUTHOR:([a-z0-9-]+)/u)?.[1];
      if (authorMarker) {
        const scenario = authorDrafts.get(authorMarker);
        if (!scenario) {
          throw new Error(`No synthetic authoring draft registered for ${authorMarker}`);
        }
        const { draft, updatedContent } = scenario;
        const workshop = body.tools?.find((tool) => tool.name === "skill_workshop");
        const invoke = (callId: string, args: unknown) => {
          if (!workshop?.parameters || !Value.Check(workshop.parameters, args)) {
            throw new Error(
              "Ordinary chat did not advertise a Workshop schema accepting the requested action",
            );
          }
          emitTool(callId, "skill_workshop", args);
        };
        const observation = authorOutputs.get(authorMarker) ?? {};
        authorOutputs.set(authorMarker, observation);
        const createId = `${authorMarker}_create`;
        const created = output(createId);
        if (created === undefined) {
          invoke(createId, {
            action: "create",
            target: "personal",
            name: draft.slug,
            proposal_content: draft.content,
            files: draft.files,
          });
          return;
        }
        observation.created = created;
        const receipt = JSON.parse(created) as SkillsLibraryReceipt;
        if (receipt.state !== "published" || !receipt.entry?.skillId) {
          throw new Error(`Workshop did not return a publication receipt: ${created}`);
        }
        const readId = `${authorMarker}_read`;
        const read = output(readId);
        if (read === undefined) {
          invoke(readId, { action: "read", target: "personal", skill_id: receipt.entry.skillId });
          return;
        }
        observation.read = read;
        const inspected = JSON.parse(read) as {
          skillId: string;
          revision: string;
          contentIncluded: unknown;
          content?: string;
        };
        if (
          inspected.skillId !== receipt.entry.skillId ||
          !inspected.revision ||
          inspected.contentIncluded !== true ||
          typeof inspected.content !== "string"
        ) {
          throw new Error(`Workshop read did not expose the authored revision: ${read}`);
        }
        const updateId = `${authorMarker}_update`;
        const updated = output(updateId);
        if (updated === undefined) {
          // Consume the real read's revision and omit files; the Gateway must preserve supporting bytes.
          invoke(updateId, {
            action: "update",
            target: "personal",
            skill_id: inspected.skillId,
            expected_revision: inspected.revision,
            name: draft.slug,
            proposal_content: updatedContent,
          });
          return;
        }
        observation.updated = updated;
        reply(response, `AUTHOR-RESULT:${authorMarker}\n${updated}`);
        return;
      }
      if (!match) {
        reply(response, "No skill probe requested.");
        return;
      }
      const [, marker, skillName] = match;
      const observation = observations.get(marker!) ?? { catalogs: [] };
      observations.set(marker!, observation);
      const instructions = [
        body.instructions ?? "",
        ...input
          .filter((item) => item.role === "system" || item.role === "developer")
          .map((item) => contentText(item.content)),
      ].join("\n");
      const catalog = catalogSkills(instructions);
      observation.catalogs.push(catalog);
      if (!skillName) {
        reply(response, `CATALOG-OBSERVED:${marker}`);
        return;
      }
      const selected = catalog.filter((skill) => skill.name === skillName);
      if (selected.length !== 1) {
        throw new Error(
          `Expected exactly one advertised skill ${skillName}, found ${selected.length}`,
        );
      }
      const readId = `${marker}_read`;
      const execId = `${marker}_exec`;
      const readOutput = output(readId);
      if (readOutput === undefined) {
        if (!body.tools?.some((tool) => tool.name === "read")) {
          throw new Error("Direct read tool missing from this runtime's advertised tools");
        }
        emitTool(readId, "read", { path: selected[0]!.location });
        return;
      }
      observation.readOutput = readOutput;
      const execOutput = output(execId);
      if (execOutput === undefined) {
        const hold = holds.get(marker!);
        if (hold) {
          hold.entered = true;
          await hold.promise;
        }
        if (response.destroyed) {
          return;
        }
        if (!body.tools?.some((tool) => tool.name === "exec")) {
          throw new Error("Direct exec tool missing from this runtime's advertised tools");
        }
        const helper = path.join(path.dirname(selected[0]!.location), "scripts", "report.mjs");
        // Expand the advertised home on the executing host, never in the provider/Gateway.
        const homeRelative = helper.startsWith("~/");
        const helperTail = homeRelative ? helper.slice(2) : helper;
        const quotedHelper = `${homeRelative ? '"$HOME"/' : ""}'${helperTail.replaceAll("'", "'\\''")}'`;
        emitTool(execId, "exec", { command: `node ${quotedHelper}` });
        return;
      }
      observation.execOutput = execOutput;
      // Return only what the real tool returned; the test owns the expected contents.
      reply(response, `TOOL-RESULT:${marker}\n${execOutput}`);
    })().catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      errors.push(failure);
      console.error(`[skill-library-wire-provider] ${failure.message}`);
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Skill provider failed to bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    observations,
    authorOutputs,
    authorDraft: (marker: string, draft: SkillsLibrarySaveParams, updatedContent: string) =>
      authorDrafts.set(marker, { draft, updatedContent }),
    errors,
    hold(marker: string) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      holds.set(marker, { promise, release, entered: false });
    },
    isHeld: (marker: string) => holds.get(marker)?.entered === true,
    release: (marker: string) => holds.get(marker)?.release(),
    async stop() {
      for (const hold of holds.values()) {
        hold.release();
      }
      await closeWireServer(server);
    },
  };
}
