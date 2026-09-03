import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { AgentToolResult } from "./runtime/index.js";
import { readToolSearchBatchRequest } from "./tool-search-request.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS,
  type ToolSearchConfig,
} from "./tool-search-types.js";
import { jsonResult } from "./tools/common.js";

type ToolSearchCandidate = Awaited<ReturnType<ToolSearchRuntime["search"]>>[number];
type ToolSearchBatchGroup = {
  query: string;
  candidates: ToolSearchCandidate[];
  truncated?: true;
};

const MAX_BATCH_CANDIDATE_DESCRIPTION_CHARS = 180;
const MAX_BATCH_CANDIDATE_DESCRIPTION_SCAN_CHARS = MAX_BATCH_CANDIDATE_DESCRIPTION_CHARS * 4;
const MAX_BATCH_CANDIDATE_METADATA_CHARS = 2_000;

function compactBatchCandidateDescription(candidate: ToolSearchCandidate): ToolSearchCandidate {
  const prefix = truncateUtf16Safe(
    candidate.description,
    MAX_BATCH_CANDIDATE_DESCRIPTION_SCAN_CHARS,
  );
  const normalized = prefix.replace(/\s+/g, " ").trim();
  if (
    prefix.length === candidate.description.length &&
    normalized.length <= MAX_BATCH_CANDIDATE_DESCRIPTION_CHARS
  ) {
    return { ...candidate, description: normalized };
  }
  const compacted = truncateUtf16Safe(
    normalized,
    MAX_BATCH_CANDIDATE_DESCRIPTION_CHARS - 3,
  ).trimEnd();
  return { ...candidate, description: `${compacted}...` };
}

function compactBatchCandidate(candidate: ToolSearchCandidate): ToolSearchCandidate | undefined {
  const mandatoryChars =
    candidate.id.length + candidate.source.length + candidate.name.length + candidate.input.length;
  if (mandatoryChars > MAX_BATCH_CANDIDATE_METADATA_CHARS) {
    return undefined;
  }
  let remaining = MAX_BATCH_CANDIDATE_METADATA_CHARS - mandatoryChars;
  const retain = (value: string | undefined): string | undefined => {
    if (value === undefined || value.length > remaining) {
      return undefined;
    }
    remaining -= value.length;
    return value;
  };
  const sourceName = retain(candidate.sourceName);
  const label = retain(candidate.label);
  const mcpChars = candidate.mcp
    ? candidate.mcp.serverName.length +
      candidate.mcp.safeServerName.length +
      candidate.mcp.toolName.length +
      candidate.mcp.operation.length
    : 0;
  const mcp = candidate.mcp && mcpChars <= remaining ? candidate.mcp : undefined;
  if (mcp) {
    remaining -= mcpChars;
  }
  const output = retain(candidate.output);
  return {
    ...compactBatchCandidateDescription(candidate),
    sourceName,
    label,
    mcp,
    output,
  };
}

function boundToolSearchBatchResponse(results: ToolSearchBatchGroup[]): {
  results: ToolSearchBatchGroup[];
  truncated?: true;
} {
  const bounded = results.map((result) => {
    const candidates = result.candidates
      .map(compactBatchCandidate)
      .filter((candidate): candidate is ToolSearchCandidate => candidate !== undefined);
    return {
      ...result,
      candidates,
      ...(candidates.length < result.candidates.length ? { truncated: true as const } : {}),
    };
  });
  let truncated = bounded.some((result) => result.truncated);
  const render = () => ({ results: bounded, ...(truncated ? { truncated: true as const } : {}) });
  while (JSON.stringify(render(), null, 2).length > MAX_TOOL_SEARCH_BATCH_RESPONSE_CHARS) {
    const removable = bounded
      .map((result, index) => ({
        index,
        rank: result.candidates.length,
        candidate: result.candidates.at(-1),
      }))
      .filter(
        (item): item is { index: number; rank: number; candidate: ToolSearchCandidate } =>
          item.candidate !== undefined,
      )
      .toSorted(
        (a, b) =>
          b.rank - a.rank ||
          JSON.stringify(b.candidate).length - JSON.stringify(a.candidate).length ||
          a.index - b.index,
      )[0];
    if (!removable) {
      break;
    }
    const group = bounded[removable.index];
    group?.candidates.pop();
    if (group) {
      group.truncated = true;
    }
    truncated = true;
  }
  return render();
}

export async function executeToolSearchBatch(
  runtime: ToolSearchRuntime,
  args: unknown,
  config: ToolSearchConfig,
): Promise<AgentToolResult<unknown>> {
  const searches = readToolSearchBatchRequest(args, config);
  const results = await Promise.all(
    searches.map(async (search) => ({
      query: search.query,
      candidates: await runtime.search(search.query, { limit: search.limit }),
    })),
  );
  return jsonResult(boundToolSearchBatchResponse(results));
}
