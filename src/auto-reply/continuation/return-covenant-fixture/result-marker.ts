import { randomBytes } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SystemEvent } from "../../../infra/system-events.js";

const RETURN_COVENANT_RESULT_MARKER = /RCV-[0-9a-f]{32}/gu;

export type ReturnCovenantDurableMarkerObservation = {
  promptAdoptions: number;
  successorTranscriptResidualMatches: number;
  trustedSystemEventResidualMatches: number;
};

export function createReturnCovenantResultMarker(): string {
  return `RCV-${randomBytes(16).toString("hex")}`;
}

export function formatReturnCovenantResultText(executionKey: string, marker: string): string {
  return `[Internal task completion event] Return-covenant result for ${executionKey}. ${marker}`;
}

function countExactOccurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

function transcriptMessageText(event: unknown): string {
  if (!isRecord(event) || !isRecord(event.message)) {
    return "";
  }
  const content = event.message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      if (typeof part === "string") {
        return [part];
      }
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
        return [];
      }
      return [part.text];
    })
    .join("\n");
}

function foreignMarkerCount(text: string, marker: string): number {
  return [...text.matchAll(RETURN_COVENANT_RESULT_MARKER)].filter((match) => match[0] !== marker)
    .length;
}

export function assertReturnCovenantPromptMarker(params: {
  allowed: boolean;
  marker: string;
  promptText: string;
}): void {
  const expected = params.allowed ? 1 : 0;
  const ownMatches = countExactOccurrences(params.promptText, params.marker);
  const foreignMatches = foreignMarkerCount(params.promptText, params.marker);
  if (foreignMatches > 0) {
    throw new Error("return-covenant prompt contains a foreign result marker");
  }
  if (ownMatches !== expected) {
    throw new Error(
      `return-covenant prompt expected ${expected} durable result marker, observed ${ownMatches}`,
    );
  }
}

export function inspectReturnCovenantDurableMarkers(params: {
  allowed: boolean;
  marker: string;
  systemEvents: readonly SystemEvent[];
  transcript: readonly unknown[];
}): ReturnCovenantDurableMarkerObservation {
  const transcriptText = params.transcript.map(transcriptMessageText).join("\n");
  const systemEventText = params.systemEvents.map((event) => event.text).join("\n");
  const transcriptOwnMatches = countExactOccurrences(transcriptText, params.marker);
  const systemEventOwnMatches = countExactOccurrences(systemEventText, params.marker);
  const transcriptForeignMatches = foreignMarkerCount(transcriptText, params.marker);
  const systemEventForeignMatches = foreignMarkerCount(systemEventText, params.marker);
  if (transcriptForeignMatches + systemEventForeignMatches > 0) {
    throw new Error("return-covenant durable owners contain a foreign result marker");
  }
  const expected = params.allowed ? 1 : 0;
  const durableOwnMatches = transcriptOwnMatches + systemEventOwnMatches;
  if (durableOwnMatches !== expected) {
    throw new Error(
      `return-covenant expected ${expected} durable result marker, observed ${durableOwnMatches}`,
    );
  }
  if (systemEventOwnMatches !== 0) {
    throw new Error("return-covenant retained its result marker in trusted system events");
  }
  return {
    promptAdoptions: durableOwnMatches,
    successorTranscriptResidualMatches: Math.max(0, transcriptOwnMatches - expected),
    trustedSystemEventResidualMatches: systemEventOwnMatches,
  };
}
