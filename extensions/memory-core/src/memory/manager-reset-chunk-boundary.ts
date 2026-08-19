import {
  chunkMarkdown,
  type MemoryChunk,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export function chunkSessionContentAtResetBoundary(params: {
  content: string;
  cutoffLine?: number;
  lineMap?: readonly number[];
  chunking: { tokens: number; overlap: number; perEntry?: boolean };
}): MemoryChunk[] {
  const cutoffIndex =
    params.cutoffLine !== undefined && params.lineMap
      ? params.lineMap.findIndex((line) => line >= params.cutoffLine!)
      : -1;
  if (cutoffIndex <= 0) {
    return chunkMarkdown(params.content, params.chunking);
  }
  const lines = params.content.split("\n");
  const chunkPartition = (content: string, lineOffset: number) => {
    const chunks = chunkMarkdown(content, params.chunking);
    for (const chunk of chunks) {
      chunk.startLine += lineOffset;
      chunk.endLine += lineOffset;
    }
    return chunks;
  };
  return [
    ...chunkPartition(lines.slice(0, cutoffIndex).join("\n"), 0),
    ...chunkPartition(lines.slice(cutoffIndex).join("\n"), cutoffIndex),
  ];
}
