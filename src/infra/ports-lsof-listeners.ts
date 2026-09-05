import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { parseTcpEndpoint } from "./ports-netstat.js";
import type { PortListener } from "./ports-types.js";

export type LsofListenerRecord = {
  listener: PortListener;
  detail: string;
};

function parseLsofListenerFieldRecords(output: string): LsofListenerRecord[] {
  const records: LsofListenerRecord[] = [];
  let processFields: Pick<PortListener, "pid" | "command"> = {};
  let processLines: string[] = [];
  let fileLines: string[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("p")) {
      const pid = parseStrictPositiveInteger(line.slice(1));
      processFields = pid !== undefined ? { pid } : {};
      processLines = [line];
      fileLines = [];
      continue;
    }
    if (line.startsWith("c")) {
      processFields.command = line.slice(1);
      processLines.push(line);
      continue;
    }
    if (line.startsWith("f")) {
      fileLines = [line];
      continue;
    }
    if (line.startsWith("n")) {
      records.push({
        listener: { ...processFields, address: line.slice(1) },
        detail: [...processLines, ...fileLines, line].join("\n"),
      });
      fileLines = [];
    }
  }
  return records;
}

function parseLsofListenerPort(address: string | undefined): number | null {
  const normalized = address
    ?.replace(/^tcp\s+/i, "")
    .replace(/\s*\([^)]*\)\s*$/i, "")
    .trim();
  if (!normalized || normalized.includes("->")) {
    return null;
  }
  return parseTcpEndpoint(normalized)?.port ?? null;
}

export function parseLsofListenerRecordsByPort(output: string): Map<number, LsofListenerRecord[]> {
  const recordsByPort = new Map<number, LsofListenerRecord[]>();
  for (const record of parseLsofListenerFieldRecords(output)) {
    const port = parseLsofListenerPort(record.listener.address);
    if (port === null) {
      continue;
    }
    const records = recordsByPort.get(port) ?? [];
    records.push(record);
    recordsByPort.set(port, records);
  }
  return recordsByPort;
}

function listenerIdentity(listener: PortListener): string {
  return `${listener.pid ?? ""}\0${listener.command ?? ""}\0${listener.address ?? ""}`;
}

export function readLsofListenersForPort(
  recordsByPort: Map<number, LsofListenerRecord[]>,
  port: number,
): { listeners: PortListener[]; detail?: string } {
  const records = recordsByPort.get(port) ?? [];
  const seen = new Set<string>();
  const listeners: PortListener[] = [];
  const detailLines: string[] = [];
  for (const record of records) {
    const key = listenerIdentity(record.listener);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    listeners.push(record.listener);
    detailLines.push(record.detail);
  }
  return { listeners, detail: detailLines.join("\n") || undefined };
}
