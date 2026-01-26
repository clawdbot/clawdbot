import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { CallRecordSchema, TerminalStates, type CallId, type CallRecord } from "../types.js";

export function persistCallRecord(storePath: string, call: CallRecord): void {
  const logPath = path.join(storePath, "calls.jsonl");
  const line = `${JSON.stringify(call)}\n`;
  // Fire-and-forget async write to avoid blocking event loop.
  fsp.appendFile(logPath, line).catch((err) => {
    console.error("[voice-call] Failed to persist call record:", err);
  });
}

export function loadActiveCallsFromStore(storePath: string): {
  activeCalls: Map<CallId, CallRecord>;
  providerCallIdMap: Map<string, CallId>;
  processedEventIds: Set<string>;
} {
  const logPath = path.join(storePath, "calls.jsonl");
  if (!fs.existsSync(logPath)) {
    return {
      activeCalls: new Map(),
      providerCallIdMap: new Map(),
      processedEventIds: new Set(),
    };
  }

  const content = fs.readFileSync(logPath, "utf-8");
  const lines = content.split("\n");

  const callMap = new Map<CallId, CallRecord>();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const call = CallRecordSchema.parse(JSON.parse(line));
      callMap.set(call.callId, call);
    } catch {
      // Skip invalid lines.
    }
  }

  const activeCalls = new Map<CallId, CallRecord>();
  const providerCallIdMap = new Map<string, CallId>();
  const processedEventIds = new Set<string>();

  for (const [callId, call] of callMap) {
    if (TerminalStates.has(call.state)) continue;
    activeCalls.set(callId, call);
    if (call.providerCallId) {
      providerCallIdMap.set(call.providerCallId, callId);
    }
    for (const eventId of call.processedEventIds) {
      processedEventIds.add(eventId);
    }
  }

  return { activeCalls, providerCallIdMap, processedEventIds };
}

export async function getCallHistoryFromStore(
  storePath: string,
  limit = 50,
): Promise<CallRecord[]> {
  const logPath = path.join(storePath, "calls.jsonl");

  try {
    await fsp.access(logPath);
  } catch {
    return [];
  }

  const content = await fsp.readFile(logPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const calls: CallRecord[] = [];

  for (const line of lines.slice(-limit)) {
    try {
      const parsed = CallRecordSchema.parse(JSON.parse(line));
      calls.push(parsed);
    } catch {
      // Skip invalid lines.
    }
  }

  return calls;
}
