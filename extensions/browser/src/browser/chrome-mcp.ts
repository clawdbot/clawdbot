import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { normalizeOptionalString, readStringValue } from "openclaw/plugin-sdk/text-runtime";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { asRecord } from "../record-shared.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";
import type { BrowserTab } from "./client.types.js";
import { BrowserProfileUnavailableError, BrowserTabNotFoundError } from "./errors.js";

type ChromeMcpStructuredPage = {
  id: number;
  url?: string;
  selected?: boolean;
};

type ChromeMcpToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
};

type ChromeMcpSession = {
  client: Client;
  transport: StdioClientTransport;
  ready: Promise<void>;
};

type ChromeMcpSessionFactory = (
  profileName: string,
  userDataDir?: string,
) => Promise<ChromeMcpSession>;

const DEFAULT_CHROME_MCP_COMMAND = "npx";
const DEFAULT_CHROME_MCP_ARGS = [
  "-y",
  "chrome-devtools-mcp@latest",
  "--autoConnect",
  // Direct chrome-devtools-mcp launches do not enable structuredContent by default.
  "--experimentalStructuredContent",
  "--experimental-page-id-routing",
];
const CHROME_MCP_NEW_PAGE_TIMEOUT_MS = 5_000;
const CHROME_MCP_NAVIGATE_TIMEOUT_MS = 20_000;

const sessions = new Map<string, ChromeMcpSession>();
const pendingSessions = new Map<string, Promise<ChromeMcpSession>>();
let sessionFactory: ChromeMcpSessionFactory | null = null;

function asPages(value: unknown): ChromeMcpStructuredPage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ChromeMcpStructuredPage[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record || typeof record.id !== "number") {
      continue;
    }
    out.push({
      id: record.id,
      url: readStringValue(record.url),
      selected: record.selected === true,
    });
  }
  return out;
}

function parsePageId(targetId: string): number {
  const parsed = Number.parseInt(targetId.trim(), 10);
  if (!Number.isFinite(parsed)) {
    throw new BrowserTabNotFoundError();
  }
  return parsed;
}

function toBrowserTabs(pages: ChromeMcpStructuredPage[]): BrowserTab[] {
  return pages.map((page) => ({
    targetId: String(page.id),
    title: "",
    url: page.url ?? "",
    type: "page",
  }));
}

function extractStructuredContent(result: ChromeMcpToolResult): Record<string, unknown> {
  return asRecord(result.structuredContent) ?? {};
}

function extractTextContent(result: ChromeMcpToolResult): string[] {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((entry) => {
      const record = asRecord(entry);
      return record && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean);
}

function extractTextPages(result: ChromeMcpToolResult): ChromeMcpStructuredPage[] {
  const pages: ChromeMcpStructuredPage[] = [];
  for (const block of extractTextContent(result)) {
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+):\s+(.+?)(?:\s+\[(selected)\])?\s*$/i);
      if (!match) {
        continue;
      }
      pages.push({
        id: Number.parseInt(match[1] ?? "", 10),
        url: normalizeOptionalString(match[2]),
        selected: Boolean(match[3]),
      });
    }
  }
  return pages;
}

function extractStructuredPages(result: ChromeMcpToolResult): ChromeMcpStructuredPage[] {
  const structured = asPages(extractStructuredContent(result).pages);
  return structured.length > 0 ? structured : extractTextPages(result);
}

function extractSnapshot(result: ChromeMcpToolResult): ChromeMcpSnapshotNode {
  const structured = extractStructuredContent(result);
  const snapshot = asRecord(structured.snapshot);
  if (!snapshot) {
    throw new Error("Chrome MCP snapshot response was missing structured snapshot data.");
  }
  return snapshot as unknown as ChromeMcpSnapshotNode;
}

function extractJsonBlock(text: string): unknown {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const raw = match?.[1]?.trim() || text.trim();
  return raw ? JSON.parse(raw) : null;
}

function extractMessageText(result: ChromeMcpToolResult): string {
  const message = extractStructuredContent(result).message;
  if (typeof message === "string" && message.trim()) {
    return message;
  }
  const blocks = extractTextContent(result);
  return blocks.find((block) => block.trim()) ?? "";
}

function extractToolErrorMessage(result: ChromeMcpToolResult, name: string): string {
  const message = extractMessageText(result).trim();
  return message || `Chrome MCP tool "${name}" failed.`;
}

function extractJsonMessage(result: ChromeMcpToolResult): unknown {
  const candidates = [extractMessageText(result), ...extractTextContent(result)].filter((text) =>
    text.trim(),
  );
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return extractJsonBlock(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return null;
}

function normalizeChromeMcpUserDataDir(userDataDir?: string): string | undefined {
  const trimmed = userDataDir?.trim();
  return trimmed ? trimmed : undefined;
}

function buildChromeMcpSessionCacheKey(profileName: string, userDataDir?: string): string {
  return JSON.stringify([profileName, normalizeChromeMcpUserDataDir(userDataDir) ?? ""]);
}

function cacheKeyMatchesProfileName(cacheKey: string, profileName: string): boolean {
  try {
    const parsed = JSON.parse(cacheKey);
    return Array.isArray(parsed) && parsed[0] === profileName;
  } catch {
    return false;
  }
}

async function closeChromeMcpSessionsForProfile(
  profileName: string,
  keepKey?: string,
): Promise<boolean> {
  let closed = false;

  for (const key of Array.from(pendingSessions.keys())) {
    if (key !== keepKey && cacheKeyMatchesProfileName(key, profileName)) {
      pendingSessions.delete(key);
      closed = true;
    }
  }

  for (const [key, session] of Array.from(sessions.entries())) {
    if (key !== keepKey && cacheKeyMatchesProfileName(key, profileName)) {
      sessions.delete(key);
      closed = true;
      await session.client.close().catch(() => {});
    }
  }

  return closed;
}

export function buildChromeMcpArgs(userDataDir?: string): string[] {
  const normalizedUserDataDir = normalizeChromeMcpUserDataDir(userDataDir);
  return normalizedUserDataDir
    ? [...DEFAULT_CHROME_MCP_ARGS, "--userDataDir", normalizedUserDataDir]
    : [...DEFAULT_CHROME_MCP_ARGS];
}

async function createRealSession(
  profileName: string,
  userDataDir?: string,
): Promise<ChromeMcpSession> {
  const transport = new StdioClientTransport({
    command: DEFAULT_CHROME_MCP_COMMAND,
    args: buildChromeMcpArgs(userDataDir),
    stderr: "pipe",
  });
  const client = new Client(
    {
      name: "openclaw-browser",
      version: "0.0.0",
    },
    {},
  );

  const ready = (async () => {
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      if (!tools.tools.some((tool) => tool.name === "list_pages")) {
        throw new Error("Chrome MCP server did not expose the expected navigation tools.");
      }
    } catch (err) {
      await client.close().catch(() => {});
      const targetLabel = userDataDir
        ? `the configured Chromium user data dir (${userDataDir})`
        : "Google Chrome's default profile";
      throw new BrowserProfileUnavailableError(
        `Chrome MCP existing-session attach failed for profile "${profileName}". ` +
          `Make sure ${targetLabel} is running locally with remote debugging enabled. ` +
          `Details: ${String(err)}`,
      );
    }
  })();

  return {
    client,
    transport,
    ready,
  };
}

async function getSession(profileName: string, userDataDir?: string): Promise<ChromeMcpSession> {
  const cacheKey = buildChromeMcpSessionCacheKey(profileName, userDataDir);
  await closeChromeMcpSessionsForProfile(profileName, cacheKey);

  let session = sessions.get(cacheKey);
  if (session && session.transport.pid === null) {
    sessions.delete(cacheKey);
    session = undefined;
  }
  if (!session) {
    let pending = pendingSessions.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const created = await (sessionFactory ?? createRealSession)(profileName, userDataDir);
        if (pendingSessions.get(cacheKey) === pending) {
          sessions.set(cacheKey, created);
        } else {
          await created.client.close().catch(() => {});
        }
        return created;
      })();
      pendingSessions.set(cacheKey, pending);
    }
    try {
      session = await pending;
    } finally {
      if (pendingSessions.get(cacheKey) === pending) {
        pendingSessions.delete(cacheKey);
      }
    }
  }
  try {
    await session.ready;
    return session;
  } catch (err) {
    const current = sessions.get(cacheKey);
    if (current?.transport === session.transport) {
      sessions.delete(cacheKey);
    }
    throw err;
  }
}

async function callTool(
  profileName: string,
  userDataDir: string | undefined,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ChromeMcpToolResult> {
  const cacheKey = buildChromeMcpSessionCacheKey(profileName, userDataDir);
  const session = await getSession(profileName, userDataDir);
  let result: ChromeMcpToolResult;
  try {
    result = (await session.client.callTool({
      name,
      arguments: args,
    })) as ChromeMcpToolResult;
  } catch (err) {
    // Transport/connection error — tear down session so it reconnects on next call
    sessions.delete(cacheKey);
    await session.client.close().catch(() => {});
    throw err;
  }
  // Tool-level errors (element not found, script error, etc.) don't indicate a
  // broken connection — don't tear down the session for these.
  if (result.isError) {
    throw new Error(extractToolErrorMessage(result, name));
  }
  return result;
}

async function withTempFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-chrome-mcp-"));
  const filePath = path.join(dir, randomUUID());
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function findPageById(
  profileName: string,
  pageId: number,
  userDataDir?: string,
): Promise<ChromeMcpStructuredPage> {
  const pages = await listChromeMcpPages(profileName, userDataDir);
  const page = pages.find((entry) => entry.id === pageId);
  if (!page) {
    throw new BrowserTabNotFoundError();
  }
  return page;
}

export async function ensureChromeMcpAvailable(
  profileName: string,
  userDataDir?: string,
): Promise<void> {
  await getSession(profileName, userDataDir);
}

export function getChromeMcpPid(profileName: string): number | null {
  for (const [key, session] of sessions.entries()) {
    if (cacheKeyMatchesProfileName(key, profileName)) {
      return session.transport.pid ?? null;
    }
  }
  return null;
}

export async function closeChromeMcpSession(profileName: string): Promise<boolean> {
  return await closeChromeMcpSessionsForProfile(profileName);
}

export async function stopAllChromeMcpSessions(): Promise<void> {
  const names = [...new Set([...sessions.keys()].map((key) => JSON.parse(key)[0] as string))];
  for (const name of names) {
    await closeChromeMcpSession(name).catch(() => {});
  }
}

export async function listChromeMcpPages(
  profileName: string,
  userDataDir?: string,
): Promise<ChromeMcpStructuredPage[]> {
  const result = await callTool(profileName, userDataDir, "list_pages");
  return extractStructuredPages(result);
}

export async function listChromeMcpTabs(
  profileName: string,
  userDataDir?: string,
): Promise<BrowserTab[]> {
  return toBrowserTabs(await listChromeMcpPages(profileName, userDataDir));
}

export async function openChromeMcpTab(
  profileName: string,
  url: string,
  userDataDir?: string,
): Promise<BrowserTab> {
  const targetUrl = url.trim() || "about:blank";
  const result = await callTool(profileName, userDataDir, "new_page", {
    url: "about:blank",
    timeout: CHROME_MCP_NEW_PAGE_TIMEOUT_MS,
  });
  const pages = extractStructuredPages(result);
  const chosen = pages.find((page) => page.selected) ?? pages.at(-1);
  if (!chosen) {
    throw new Error("Chrome MCP did not return the created page.");
  }
  const targetId = String(chosen.id);
  const finalUrl =
    targetUrl === "about:blank"
      ? (chosen.url ?? targetUrl)
      : (
          await navigateChromeMcpPage({
            profileName,
            userDataDir,
            targetId,
            url: targetUrl,
            timeoutMs: CHROME_MCP_NAVIGATE_TIMEOUT_MS,
          })
        ).url;
  return {
    targetId,
    title: "",
    url: finalUrl,
    type: "page",
  };
}

export async function focusChromeMcpTab(
  profileName: string,
  targetId: string,
  userDataDir?: string,
): Promise<void> {
  await callTool(profileName, userDataDir, "select_page", {
    pageId: parsePageId(targetId),
    bringToFront: true,
  });
}

export async function closeChromeMcpTab(
  profileName: string,
  targetId: string,
  userDataDir?: string,
): Promise<void> {
  await callTool(profileName, userDataDir, "close_page", { pageId: parsePageId(targetId) });
}

export async function navigateChromeMcpPage(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  url: string;
  timeoutMs?: number;
}): Promise<{ url: string }> {
  await callTool(params.profileName, params.userDataDir, "navigate_page", {
    pageId: parsePageId(params.targetId),
    type: "url",
    url: params.url,
    ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
  });
  const page = await findPageById(
    params.profileName,
    parsePageId(params.targetId),
    params.userDataDir,
  );
  return { url: page.url ?? params.url };
}

export async function takeChromeMcpSnapshot(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
}): Promise<ChromeMcpSnapshotNode> {
  const result = await callTool(params.profileName, params.userDataDir, "take_snapshot", {
    pageId: parsePageId(params.targetId),
  });
  return extractSnapshot(result);
}

export async function takeChromeMcpScreenshot(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  uid?: string;
  fullPage?: boolean;
  format?: "png" | "jpeg";
}): Promise<Buffer> {
  return await withTempFile(async (filePath) => {
    await callTool(params.profileName, params.userDataDir, "take_screenshot", {
      pageId: parsePageId(params.targetId),
      filePath,
      format: params.format ?? "png",
      ...(params.uid ? { uid: params.uid } : {}),
      ...(params.fullPage ? { fullPage: true } : {}),
    });
    return await fs.readFile(filePath);
  });
}

export async function clickChromeMcpElement(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  uid: string;
  doubleClick?: boolean;
}): Promise<void> {
  await callTool(params.profileName, params.userDataDir, "click", {
    pageId: parsePageId(params.targetId),
    uid: params.uid,
    ...(params.doubleClick ? { dblClick: true } : {}),
  });
}

export async function fillChromeMcpElement(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  uid: string;
  value: string;
}): Promise<void> {
  await callTool(params.profileName, params.userDataDir, "fill", {
    pageId: parsePageId(params.targetId),
    uid: params.uid,
    value: params.value,
  });
}

export async function fillChromeMcpForm(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  elements: Array<{ uid: string; value: string }>;
}): Promise<void> {
  await callTool(params.profileName, params.userDataDir, "fill_form", {
    pageId: parsePageId(params.targetId),
    elements: params.elements,
  });
}

export async function hoverChromeMcpElement(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  uid: string;
}): Promise<void> {
  await callTool(params.profileName, params.userDataDir, "hover", {
    pageId: parsePageId(params.targetId),
    uid: params.uid,
  });
}

export async function dragChromeMcpElement(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  fromUid: string;
  toUid: string;
}): Promise<void> {
  await callTool(params.profileName, params.userDataDir, "drag", {
    pageId: parsePageId(params.targetId),
    from_uid: params.fromUid,
    to_uid: params.toUid,
  });
}

export async function uploadChromeMcpFile(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  uid: string;
  filePath: string;
}): Promise<void> {
  await callTool(params.profileName, params.userDataDir, "upload_file", {
    pageId: parsePageId(params.targetId),
    uid: params.uid,
    filePath: params.filePath,
  });
}

export async function pressChromeMcpKey(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  key: string;
}): Promise<void> {
  await callTool(params.profileName, params.userDataDir, "press_key", {
    pageId: parsePageId(params.targetId),
    key: params.key,
  });
}

export async function resizeChromeMcpPage(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  width: number;
  height: number;
}): Promise<void> {
  await callTool(params.profileName, params.userDataDir, "resize_page", {
    pageId: parsePageId(params.targetId),
    width: params.width,
    height: params.height,
  });
}

export async function handleChromeMcpDialog(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  action: "accept" | "dismiss";
  promptText?: string;
}): Promise<void> {
  await callTool(params.profileName, params.userDataDir, "handle_dialog", {
    pageId: parsePageId(params.targetId),
    action: params.action,
    ...(params.promptText ? { promptText: params.promptText } : {}),
  });
}

export async function evaluateChromeMcpScript(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  fn: string;
  args?: string[];
}): Promise<unknown> {
  const result = await callTool(params.profileName, params.userDataDir, "evaluate_script", {
    pageId: parsePageId(params.targetId),
    function: params.fn,
    ...(params.args?.length ? { args: params.args } : {}),
  });
  return extractJsonMessage(result);
}

export async function waitForChromeMcpText(params: {
  profileName: string;
  userDataDir?: string;
  targetId: string;
  text: string[];
  timeoutMs?: number;
}): Promise<void> {
  await callTool(params.profileName, params.userDataDir, "wait_for", {
    pageId: parsePageId(params.targetId),
    text: params.text,
    ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
  });
}

export function setChromeMcpSessionFactoryForTest(factory: ChromeMcpSessionFactory | null): void {
  sessionFactory = factory;
}

export async function resetChromeMcpSessionsForTest(): Promise<void> {
  sessionFactory = null;
  pendingSessions.clear();
  await stopAllChromeMcpSessions();
}
