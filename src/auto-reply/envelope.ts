export type AgentEnvelopeParams = {
  surface: string;
  from?: string;
  timestamp?: number | Date;
  host?: string;
  ip?: string;
  body: string;
};

function formatTimestamp(ts?: number | Date): string | undefined {
  if (!ts) return undefined;
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) return undefined;

  const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");

  // Compact ISO-like UTC timestamp with minutes precision.
  // Example: 2025-01-02T03:04Z
  return `${yyyy}-${mm}-${dd}T${hh}:${min}Z`;
}

export function formatAgentEnvelope(params: AgentEnvelopeParams): string {
  const surface = params.surface?.trim() || "Surface";
  const parts: string[] = [surface];
  if (params.from?.trim()) parts.push(params.from.trim());
  if (params.host?.trim()) parts.push(params.host.trim());
  if (params.ip?.trim()) parts.push(params.ip.trim());
  const ts = formatTimestamp(params.timestamp);
  if (ts) parts.push(ts);
  const header = `[${parts.join(" ")}]`;
  return `${header} ${params.body}`;
}
