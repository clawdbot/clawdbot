import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { deflateSync } from "node:zlib";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../../extensions/qa-lab/src/live-transports/shared/credential-lease.runtime.js";
import {
  parseSlackQaCredentialPayload,
  resolveSlackQaRuntimeEnv,
} from "../../extensions/qa-lab/src/live-transports/slack/slack-live.config.js";
import type { SlackQaRuntimeEnv } from "../../extensions/qa-lab/src/live-transports/slack/slack-live.contracts.js";
import { handleSlackAction } from "../../extensions/slack/src/action-runtime.js";
import { createSlackWebClient } from "../../extensions/slack/src/client.js";
import { registerSlackInstallationState } from "../../extensions/slack/src/installation-identity-state.js";
import { slackOutbound } from "../../extensions/slack/src/outbound-adapter.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_WIDTH = 2560;
const PNG_HEIGHT = 1536;
const POLL_TIMEOUT_MS = 60_000;

type SlackFile = {
  id?: string;
  mimetype?: string;
  name?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

type ProofResult = {
  bytes: number;
  filename: string;
  mime: string;
  preserved: boolean;
  route: string;
  sha256: string;
};

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createOpaquePng(): Buffer {
  const rowBytes = PNG_WIDTH * 3 + 1;
  const raw = Buffer.alloc(rowBytes * PNG_HEIGHT);
  for (let y = 0; y < PNG_HEIGHT; y += 1) {
    const rowOffset = y * rowBytes;
    raw[rowOffset] = 0;
    for (let x = 0; x < PNG_WIDTH; x += 1) {
      const offset = rowOffset + 1 + x * 3;
      raw[offset] = (x * 17 + y * 13) & 0xff;
      raw[offset + 1] = (x * 7 + y * 29 + ((x ^ y) & 0x3f)) & 0xff;
      raw[offset + 2] = (x * 31 + y * 5) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(PNG_WIDTH, 0);
  ihdr.writeUInt32BE(PNG_HEIGHT, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function findUploadedFile(params: {
  channelId: string;
  client: ReturnType<typeof createSlackWebClient>;
  marker: string;
  oldest: string;
}): Promise<SlackFile> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const history = await params.client.conversations.history({
      channel: params.channelId,
      inclusive: true,
      limit: 100,
      oldest: params.oldest,
    });
    for (const message of history.messages ?? []) {
      if (!message.text?.includes(params.marker) || !message.files?.length) {
        continue;
      }
      const candidate = message.files[0] as SlackFile;
      if (!candidate.id) {
        continue;
      }
      const info = await params.client.files.info({ file: candidate.id });
      return (info.file ?? candidate) as SlackFile;
    }
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for Slack upload marker ${params.marker}`);
}

async function downloadSlackFile(file: SlackFile, token: string): Promise<Buffer> {
  const url = file.url_private_download ?? file.url_private;
  if (!url) {
    throw new Error("Slack file did not expose a private download URL");
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Slack file download failed with HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const outputPath = process.env.ISSUE53932_PROOF_OUTPUT?.trim();
  if (!outputPath) {
    throw new Error("ISSUE53932_PROOF_OUTPUT is required");
  }
  const lease = await acquireQaCredentialLease<SlackQaRuntimeEnv>({
    kind: "slack",
    source: "convex",
    role: "ci",
    resolveEnvPayload: () => resolveSlackQaRuntimeEnv(),
    parsePayload: parseSlackQaCredentialPayload,
  });
  const heartbeat = startQaCredentialLeaseHeartbeat(lease);
  const tempDir = await mkdtemp(join(tmpdir(), "openclaw-issue53932-proof-"));
  const installationState = registerSlackInstallationState("default", "workspace");
  const uploadedFileIds: string[] = [];
  try {
    const runtime = lease.payload;
    const client = createSlackWebClient(runtime.sutBotToken);
    const auth = await client.auth.test();
    const teamId = auth.team_id?.trim();
    if (!teamId) {
      throw new Error("Slack auth.test did not return a workspace team id");
    }
    const cfg: OpenClawConfig = {
      channels: {
        slack: {
          appToken: runtime.sutAppToken,
          botToken: runtime.sutBotToken,
          groupPolicy: "open",
        },
      },
    };
    const source = createOpaquePng();
    const sourceHash = sha256(source);
    const runId = randomUUID().slice(0, 8);
    const oldest = `${Math.floor((Date.now() - 30_000) / 1_000)}.000000`;
    const routes = [
      { key: "control", filename: `issue53932-control-${runId}.png`, forced: false },
      { key: "core-send", filename: `issue53932-core-${runId}.png`, forced: true },
      { key: "workspace-send", filename: `issue53932-workspace-${runId}.png`, forced: true },
      { key: "upload-file", filename: `issue53932-upload-${runId}.png`, forced: true },
    ] as const;
    const sourcePaths = new Map<string, string>();
    for (const route of routes) {
      const path = join(tempDir, route.filename);
      await writeFile(path, source);
      sourcePaths.set(route.key, path);
    }

    await slackOutbound.sendMedia?.({
      accountId: "default",
      cfg,
      mediaLocalRoots: [tempDir],
      mediaUrl: sourcePaths.get("control"),
      text: `[issue53932-proof:${runId}:control]`,
      to: runtime.channelId,
    });
    await slackOutbound.sendMedia?.({
      accountId: "default",
      cfg,
      forceDocument: true,
      mediaLocalRoots: [tempDir],
      mediaUrl: sourcePaths.get("core-send"),
      text: `[issue53932-proof:${runId}:core-send]`,
      to: runtime.channelId,
    });
    await handleSlackAction(
      {
        action: "sendMessage",
        content: `[issue53932-proof:${runId}:workspace-send]`,
        forceDocument: true,
        mediaUrl: sourcePaths.get("workspace-send"),
        to: `team:${teamId}:channel:${runtime.channelId}`,
      },
      cfg,
      { mediaLocalRoots: [tempDir] },
    );
    await handleSlackAction(
      {
        action: "uploadFile",
        filePath: sourcePaths.get("upload-file"),
        filename: routes[3].filename,
        forceDocument: true,
        initialComment: `[issue53932-proof:${runId}:upload-file]`,
        to: `channel:${runtime.channelId}`,
      },
      cfg,
      { mediaLocalRoots: [tempDir] },
    );

    const results: ProofResult[] = [];
    for (const route of routes) {
      heartbeat.throwIfFailed();
      const file = await findUploadedFile({
        channelId: runtime.channelId,
        client,
        marker: `[issue53932-proof:${runId}:${route.key}]`,
        oldest,
      });
      if (file.id) {
        uploadedFileIds.push(file.id);
      }
      const downloaded = await downloadSlackFile(file, runtime.sutBotToken);
      const result = {
        bytes: downloaded.length,
        filename: file.name ?? "",
        mime: file.mimetype ?? "",
        preserved:
          downloaded.length === source.length &&
          sha256(downloaded) === sourceHash &&
          file.name === route.filename &&
          file.mimetype === "image/png",
        route: route.key,
        sha256: sha256(downloaded),
      };
      if (route.forced && !result.preserved) {
        throw new Error(`${route.key} did not preserve exact PNG bytes and metadata`);
      }
      if (!route.forced && result.sha256 === sourceHash) {
        throw new Error("control upload unexpectedly preserved the original PNG bytes");
      }
      results.push(result);
    }
    const summary = {
      controlChangedBytes:
        results.find((result) => result.route === "control")?.sha256 !== sourceHash,
      forcedRoutesPreserved: results
        .filter((result) => result.route !== "control")
        .every((result) => result.preserved),
      routes: results,
      source: {
        bytes: source.length,
        filenamePattern: "issue53932-<route>-<run>.png",
        height: PNG_HEIGHT,
        mime: "image/png",
        sha256: sourceHash,
        width: PNG_WIDTH,
      },
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(summary));
  } finally {
    installationState.release();
    await Promise.allSettled(
      uploadedFileIds.map(async (file) => {
        const client = createSlackWebClient(lease.payload.sutBotToken);
        await client.files.delete({ file });
      }),
    );
    await heartbeat.stop();
    await lease.release();
    await rm(tempDir, { force: true, recursive: true });
  }
}

await main();
