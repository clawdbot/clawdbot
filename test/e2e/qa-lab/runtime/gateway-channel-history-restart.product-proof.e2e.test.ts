import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { startQaGatewayChild } from "../../../../extensions/qa-lab/api.js";

const MODEL_REF = "mock-openai/gpt-5.6-luna";
const PRIOR_TEXT = "CHANNEL_HISTORY_TEXT_PROOF_4D30";
const PDF_TEXT = "CHANNEL HISTORY PDF PROOF 8F21";
const RESPONSE_MARKER = "CHANNEL_HISTORY_RESTART_PROOF_OK";
const TEST_TIMEOUT_MS = 420_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

function writeEvents(response: ServerResponse, events: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  response.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

function completedResponse(text?: string): unknown[] {
  if (!text) {
    return [
      {
        type: "response.completed",
        response: { id: randomUUID(), status: "completed", output: [], usage: {} },
      },
    ];
  }
  const item = {
    type: "message",
    id: randomUUID(),
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: { id: randomUUID(), status: "completed", output: [item], usage: {} },
    },
  ];
}

async function startProvider() {
  const requests: string[] = [];
  const restoredContext = { pdf: false, text: false };
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
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
      }
      requests.push(body);
      if (requests.length === 1) {
        writeEvents(response, completedResponse("NO_REPLY"));
        return;
      }
      restoredContext.text = body.includes(PRIOR_TEXT);
      restoredContext.pdf = bodyContainsMarker(body, PDF_TEXT);
      writeEvents(
        response,
        completedResponse(
          restoredContext.text && restoredContext.pdf ? RESPONSE_MARKER : "CONTEXT_MISSING",
        ),
      );
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("proof provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    restoredContext,
    stop: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function bodyContainsMarker(body: string, marker: string): boolean {
  if (body.includes(marker)) {
    return true;
  }
  const candidates = body.match(/[A-Za-z0-9+/]{80,}={0,2}/g) ?? [];
  return candidates.some((candidate) => {
    try {
      return Buffer.from(candidate, "base64").includes(Buffer.from(marker));
    } catch {
      return false;
    }
  });
}

function buildPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function createFakeImsg(root: string) {
  const inbox = path.join(root, "inbox.jsonl");
  const requests = path.join(root, "requests.jsonl");
  const invocations = path.join(root, "invocations.jsonl");
  const outbound = path.join(root, "outbound.jsonl");
  const executable = path.join(root, "fake-imsg.mjs");
  await Promise.all([
    fs.writeFile(inbox, ""),
    fs.writeFile(requests, ""),
    fs.writeFile(invocations, ""),
    fs.writeFile(outbound, ""),
  ]);
  const script = `#!/usr/bin/env node
import fs from "node:fs";
const inbox=${JSON.stringify(inbox)}, requests=${JSON.stringify(requests)}, invocations=${JSON.stringify(invocations)}, outbound=${JSON.stringify(outbound)};
const args=process.argv.slice(2);
fs.appendFileSync(invocations,JSON.stringify(args)+"\\n");
const command=args.join(" ");
if(command==="rpc --help"){process.stdout.write("Usage: imsg rpc --json\\n");process.exit(0);}
if(command==="status --json"){process.stdout.write(JSON.stringify({version:"0.14.1",advanced_features:true,v2_ready:true,selectors:{},rpc_methods:["chats.list","watch.subscribe","send","typing","read"]})+"\\n");process.exit(0);}
if(command==="send-rich --help"){process.stdout.write("Usage: imsg send-rich\\n");process.exit(0);}
if(command==="poll send --help"){process.stdout.write("Usage: imsg poll send\\n");process.exit(0);}
if(command!=="rpc --json"){process.stderr.write("unsupported fake imsg invocation: "+command+"\\n");process.exit(2);}
let offset=fs.statSync(inbox).size, subscribed=false;
process.stdin.setEncoding("utf8"); let pending="";
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\\n");
process.stdin.on("data",chunk=>{ pending+=chunk; let i; while((i=pending.indexOf("\\n"))>=0){ const line=pending.slice(0,i); pending=pending.slice(i+1); if(!line.trim())continue; const req=JSON.parse(line); fs.appendFileSync(requests,JSON.stringify(req)+"\\n"); if(req.method==="watch.subscribe"){subscribed=true;reply(req.id,{subscription:1});} else if(req.method==="send"){fs.appendFileSync(outbound,JSON.stringify(req.params)+"\\n");reply(req.id,{guid:"proof-outbound-guid",status:"sent"});} else {reply(req.id,{ok:true});}}});
setInterval(()=>{ if(!subscribed)return; const size=fs.statSync(inbox).size; if(size<=offset)return; const fd=fs.openSync(inbox,"r"), buf=Buffer.alloc(size-offset); fs.readSync(fd,buf,0,buf.length,offset); fs.closeSync(fd); offset=size; for(const line of buf.toString().split("\\n")){if(line.trim())process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"message",params:JSON.parse(line)})+"\\n");}},25);
`;
  await fs.writeFile(executable, script, { mode: 0o700 });
  return {
    executable,
    outbound,
    append: async (message: unknown) => await fs.appendFile(inbox, `${JSON.stringify(message)}\n`),
  };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error("product proof timed out");
}

async function countRpcRequests(file: string, method: string): Promise<number> {
  return (await fs.readFile(file, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method?: unknown })
    .filter((request) => request.method === method).length;
}

type PersistedHistoryState = {
  items?: Array<{
    sequence?: number;
    entry?: {
      body?: string;
      media?: Array<{ path?: string }>;
      messageId?: string;
    };
  }>;
  nextSequence?: number;
};

function readPersistedHistory(dbPath: string): PersistedHistoryState | null {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT value_json FROM plugin_state_entries
         WHERE plugin_id = 'imessage' AND namespace = 'channel-history-v1'
           AND entry_key = 'default:4242'`,
      )
      .get() as { value_json?: unknown } | undefined;
    return typeof row?.value_json === "string"
      ? (JSON.parse(row.value_json) as PersistedHistoryState)
      : null;
  } finally {
    database.close();
  }
}

describe.runIf(process.env.OPENCLAW_CHANNEL_HISTORY_PRODUCT_PROOF === "1")(
  "Gateway durable channel-history restart product proof",
  () => {
    it(
      "restores text and PDF after restart and retains them after zero visible delivery",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-history-proof-"));
        cleanups.push(async () => await fs.rm(root, { recursive: true, force: true }));
        const pdfPath = path.join(root, "worksheet.pdf");
        await fs.writeFile(pdfPath, buildPdf(PDF_TEXT));
        const imsg = await createFakeImsg(root);
        const provider = await startProvider();
        cleanups.push(provider.stop);
        const gateway = await startQaGatewayChild({
          repoRoot: process.cwd(),
          providerBaseUrl: `${provider.baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: MODEL_REF,
          alternateModel: MODEL_REF,
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          transport: {
            requiredPluginIds: ["document-extract", "imessage"],
            createGatewayConfig: () => ({
              channels: {
                imessage: {
                  enabled: true,
                  cliPath: imsg.executable,
                  includeAttachments: true,
                  attachmentRoots: [root],
                  groupPolicy: "open",
                  groups: { "*": { requireMention: true } },
                  historyLimit: 50,
                },
              },
              messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
            }),
          },
        });
        cleanups.push(gateway.stop);
        const stateDbPath = path.join(gateway.tempRoot, "state", "state", "openclaw.sqlite");
        const requestsFile = path.join(root, "requests.jsonl");
        await waitFor(async () => (await countRpcRequests(requestsFile, "watch.subscribe")) >= 1);
        const source = {
          id: 101,
          guid: "proof-source-guid",
          chat_id: 4242,
          sender: "+15550001111",
          is_from_me: false,
          is_group: true,
          text: PRIOR_TEXT,
          attachments: [{ original_path: pdfPath, mime_type: "application/pdf", missing: false }],
        };
        await imsg.append({ message: source });
        await waitFor(async () => {
          const state = readPersistedHistory(stateDbPath);
          const item = state?.items?.[0];
          return (
            state?.items?.length === 1 &&
            item?.entry?.body?.includes(PRIOR_TEXT) === true &&
            item.entry.media?.length === 1 &&
            typeof item.entry.media[0]?.path === "string"
          );
        });
        const initialState = readPersistedHistory(stateDbPath);
        const initialSequence = initialState?.items?.[0]?.sequence;
        const firstPid = gateway.pid;
        await gateway.restartAfterStateMutation(async () => {});
        await waitFor(async () => (await countRpcRequests(requestsFile, "watch.subscribe")) >= 2);
        await imsg.append({
          message: {
            ...source,
            id: 102,
            guid: "proof-zero-guid",
            text: "@openclaw first attempt",
            attachments: [],
          },
        });
        await waitFor(async () => provider.requests.length === 1);
        await waitFor(async () =>
          gateway.logs().includes("visible channel turn dispatched with no queued reply payloads"),
        );
        const retainedState = readPersistedHistory(stateDbPath);
        expect(retainedState?.items).toHaveLength(1);
        expect(retainedState?.items?.[0]?.sequence).toBe(initialSequence);
        expect(retainedState?.items?.[0]?.entry?.body).toContain(PRIOR_TEXT);
        expect(retainedState?.items?.[0]?.entry?.media).toHaveLength(1);
        const secondPid = gateway.pid;
        await gateway.restartAfterStateMutation(async () => {});
        await waitFor(async () => (await countRpcRequests(requestsFile, "watch.subscribe")) >= 3);
        await imsg.append({
          message: {
            ...source,
            id: 103,
            guid: "proof-success-guid",
            text: "@openclaw retry now",
            attachments: [],
          },
        });
        await waitFor(async () => provider.requests.length === 2);
        await waitFor(async () =>
          (await fs.readFile(imsg.outbound, "utf8")).includes(RESPONSE_MARKER),
        );
        await waitFor(async () => readPersistedHistory(stateDbPath)?.items?.length === 0);
        const restoredRequest = provider.requests[1] ?? "";
        const outboundLines = (await fs.readFile(imsg.outbound, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean);
        expect(restoredRequest).toContain(PRIOR_TEXT);
        expect(provider.restoredContext).toEqual({ pdf: true, text: true });
        expect(outboundLines.filter((line) => line.includes(RESPONSE_MARKER))).toHaveLength(1);
        expect(firstPid).not.toBe(secondPid);
        expect(secondPid).not.toBe(gateway.pid);
        console.log(
          JSON.stringify({
            phase: "channel-history-restart-proof-complete",
            head: process.env.OPENCLAW_PROOF_HEAD_SHA ?? "local-checkout",
            restartCount: 2,
            priorTextVisible: true,
            pdfTextVisible: true,
            retainedAfterZeroVisible: true,
            markerOutboundCount: 1,
          }),
        );
      },
    );
  },
);
