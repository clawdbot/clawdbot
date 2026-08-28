export function formatStatusTextContinuationLine(params: {
  maxChainLength: number;
  chainCount: number;
  pending: number;
  staged: number;
  volitional: number;
}): string | undefined {
  const { maxChainLength, chainCount, pending, staged, volitional } = params;
  if (chainCount === 0 && pending === 0 && staged === 0 && volitional === 0) {
    return undefined;
  }
  const parts = [`chain ${chainCount}/${maxChainLength}`];
  if (pending > 0) {
    parts.push(`${pending} delegates pending`);
  }
  if (staged > 0) {
    parts.push(`${staged} post-compaction staged`);
  }
  if (volitional > 0) {
    parts.push(`volitional: ${volitional}`);
  }
  return `🔄 Continuation: ${parts.join(" | ")}`;
}
