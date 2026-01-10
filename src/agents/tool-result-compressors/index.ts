/**
 * Tool Result Compressors
 *
 * Semantic compression for tool outputs to reduce token usage.
 * Each compressor understands the structure of its tool's output
 * and can intelligently summarize redundant information.
 */

export type ToolResultCompressor = (text: string) => string;

/**
 * Compresses `ls` command output by grouping similar files.
 * Groups files by extension and shows counts + samples.
 */
export function compressLsOutput(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= 20) return text; // Don't compress small outputs

  // Parse ls -la style output
  const fileEntries: Array<{
    perms: string;
    name: string;
    isDir: boolean;
    ext: string;
  }> = [];
  const headerLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Keep total line and header
    if (
      trimmed.startsWith("total ") ||
      (trimmed.startsWith("d") === false && trimmed.includes("total"))
    ) {
      headerLines.push(trimmed);
      continue;
    }

    // Parse file entry: drwxr-xr-x  5 user group  160 Jan 10 12:00 filename
    const match = trimmed.match(
      /^([drwx\-lsStT@+]+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/,
    );
    if (match) {
      const perms = match[1];
      const name = match[2];
      const isDir = perms.startsWith("d");
      const ext = isDir
        ? "<dir>"
        : name.includes(".")
          ? name.split(".").pop() || "<no-ext>"
          : "<no-ext>";
      fileEntries.push({ perms, name, isDir, ext });
    } else {
      // Simple ls output (just filenames)
      const name = trimmed;
      const isDir = name.endsWith("/");
      const ext = isDir
        ? "<dir>"
        : name.includes(".")
          ? name.split(".").pop() || "<no-ext>"
          : "<no-ext>";
      fileEntries.push({ perms: "", name, isDir, ext });
    }
  }

  if (fileEntries.length <= 20) return text;

  // Group by extension
  const byExt = new Map<string, typeof fileEntries>();
  for (const entry of fileEntries) {
    const existing = byExt.get(entry.ext) || [];
    existing.push(entry);
    byExt.set(entry.ext, existing);
  }

  // Build compressed output
  const result: string[] = [...headerLines];
  result.push(`[${fileEntries.length} files/directories total]`);
  result.push("");

  // Sort by count descending
  const sorted = [...byExt.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [ext, entries] of sorted) {
    const samples = entries.slice(0, 3).map((e) => e.name);
    const more = entries.length > 3 ? ` (+${entries.length - 3} more)` : "";
    result.push(
      `${ext}: ${entries.length} files - ${samples.join(", ")}${more}`,
    );
  }

  result.push("");
  result.push(
    "[Tool result compressed to save tokens. Request full output if needed.]",
  );

  return result.join("\n");
}

/**
 * Compresses `grep` output by deduplicating identical matches.
 */
export function compressGrepOutput(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= 30) return text;

  // Group matches by content (ignoring file path)
  const matchGroups = new Map<string, string[]>();
  const otherLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // grep output format: file:line:content or file:content
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const rest = trimmed.slice(colonIdx + 1);
      // Check for line number
      const secondColonIdx = rest.indexOf(":");
      const content =
        secondColonIdx > 0 && /^\d+$/.test(rest.slice(0, secondColonIdx))
          ? rest.slice(secondColonIdx + 1).trim()
          : rest.trim();

      const existing = matchGroups.get(content) || [];
      existing.push(trimmed);
      matchGroups.set(content, existing);
    } else {
      otherLines.push(trimmed);
    }
  }

  // If no significant deduplication possible, return original
  const totalMatches = [...matchGroups.values()].reduce(
    (sum, arr) => sum + arr.length,
    0,
  );
  if (matchGroups.size > totalMatches * 0.7) return text;

  // Build compressed output
  const result: string[] = [];
  result.push(`[${totalMatches} grep matches found, grouped by content]`);
  result.push("");

  // Sort by frequency
  const sorted = [...matchGroups.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  );

  for (const [content, occurrences] of sorted.slice(0, 20)) {
    if (occurrences.length > 1) {
      result.push(
        `"${content.slice(0, 80)}${content.length > 80 ? "..." : ""}"`,
      );
      result.push(
        `  Found ${occurrences.length} times: ${occurrences
          .slice(0, 2)
          .map((o) => o.split(":")[0])
          .join(
            ", ",
          )}${occurrences.length > 2 ? ` +${occurrences.length - 2} more` : ""}`,
      );
    } else {
      result.push(
        occurrences[0].slice(0, 120) +
          (occurrences[0].length > 120 ? "..." : ""),
      );
    }
  }

  if (sorted.length > 20) {
    result.push(`... and ${sorted.length - 20} more unique matches`);
  }

  if (otherLines.length > 0) {
    result.push("");
    result.push("Other lines:");
    result.push(...otherLines.slice(0, 5));
    if (otherLines.length > 5) {
      result.push(`... and ${otherLines.length - 5} more`);
    }
  }

  result.push("");
  result.push(
    "[Tool result compressed to save tokens. Request full output if needed.]",
  );

  return result.join("\n");
}

/**
 * Compresses bash command output by detecting repetitive patterns.
 */
export function compressBashOutput(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= 50) return text;

  // Detect repeated patterns
  const lineFrequency = new Map<string, number>();
  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized) continue;
    lineFrequency.set(normalized, (lineFrequency.get(normalized) || 0) + 1);
  }

  // Find highly repeated lines (appears 5+ times)
  const repeatedLines = [...lineFrequency.entries()]
    .filter(([_, count]) => count >= 5)
    .sort((a, b) => b[1] - a[1]);

  if (repeatedLines.length === 0) {
    // No patterns found, just truncate with head/tail
    if (lines.length > 100) {
      const head = lines.slice(0, 40);
      const tail = lines.slice(-40);
      return [
        ...head,
        "",
        `[... ${lines.length - 80} lines omitted ...]`,
        "",
        ...tail,
        "",
        "[Tool result truncated to save tokens.]",
      ].join("\n");
    }
    return text;
  }

  // Build compressed summary
  const result: string[] = [];
  result.push(`[Command output: ${lines.length} lines total]`);
  result.push("");

  if (repeatedLines.length > 0) {
    result.push("Repeated patterns detected:");
    for (const [line, count] of repeatedLines.slice(0, 10)) {
      result.push(
        `  (${count}x) ${line.slice(0, 80)}${line.length > 80 ? "..." : ""}`,
      );
    }
    result.push("");
  }

  // Show unique content (first and last portions)
  const uniqueLines = lines.filter((l) => {
    const normalized = l.trim();
    return normalized && (lineFrequency.get(normalized) || 0) < 5;
  });

  if (uniqueLines.length > 0) {
    result.push("Unique content (first 20 lines):");
    result.push(...uniqueLines.slice(0, 20));

    if (uniqueLines.length > 20 && uniqueLines.length <= 30) {
      result.push("");
      result.push("Remaining unique lines:");
      result.push(...uniqueLines.slice(20));
    } else if (uniqueLines.length > 30) {
      result.push("");
      result.push(`... ${uniqueLines.length - 30} unique lines omitted ...`);
      result.push("");
      result.push("Last 10 unique lines:");
      result.push(...uniqueLines.slice(-10));
    }
  }

  result.push("");
  result.push(
    "[Tool result compressed to save tokens. Request full output if needed.]",
  );

  return result.join("\n");
}

/**
 * Compresses file read output by collapsing whitespace in non-code sections.
 * Preserves code structure but reduces verbose documentation.
 */
export function compressReadOutput(text: string): string {
  // Don't compress small files or code-heavy content
  if (text.length < 8000) return text;

  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let consecutiveBlankLines = 0;
  let inCommentBlock = false;
  let commentBlockLines: string[] = [];

  for (const line of lines) {
    // Track code blocks (fenced markdown)
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    // Preserve code block content
    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    // Detect multi-line comments
    const trimmed = line.trim();
    if (trimmed.startsWith("/*") || trimmed.startsWith("/**")) {
      inCommentBlock = true;
      commentBlockLines = [line];
      continue;
    }

    if (inCommentBlock) {
      commentBlockLines.push(line);
      if (trimmed.endsWith("*/")) {
        inCommentBlock = false;
        // Summarize long comment blocks
        if (commentBlockLines.length > 10) {
          result.push(commentBlockLines[0]);
          result.push(
            `  [... ${commentBlockLines.length - 2} comment lines summarized ...]`,
          );
          result.push(commentBlockLines[commentBlockLines.length - 1]);
        } else {
          result.push(...commentBlockLines);
        }
        commentBlockLines = [];
      }
      continue;
    }

    // Collapse multiple blank lines
    if (trimmed === "") {
      consecutiveBlankLines++;
      if (consecutiveBlankLines <= 1) {
        result.push(line);
      }
      continue;
    }
    consecutiveBlankLines = 0;

    // Keep all other lines
    result.push(line);
  }

  const compressed = result.join("\n");

  // If we saved significant space, add a note
  if (text.length - compressed.length > 500) {
    return `${compressed}\n\n[File content compressed to save tokens.]`;
  }

  return text;
}

/**
 * Compresses find command output by showing directory structure.
 */
export function compressFindOutput(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length <= 30) return text;

  // Build directory tree structure
  const dirCounts = new Map<string, number>();
  const filesByDir = new Map<string, string[]>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const lastSlash = trimmed.lastIndexOf("/");
    const dir = lastSlash > 0 ? trimmed.slice(0, lastSlash) : ".";
    const file = lastSlash > 0 ? trimmed.slice(lastSlash + 1) : trimmed;

    dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
    const existing = filesByDir.get(dir) || [];
    existing.push(file);
    filesByDir.set(dir, existing);
  }

  // Build compressed output
  const result: string[] = [];
  result.push(
    `[find: ${lines.length} files found across ${dirCounts.size} directories]`,
  );
  result.push("");

  // Sort by file count
  const sorted = [...dirCounts.entries()].sort((a, b) => b[1] - a[1]);

  for (const [dir, count] of sorted.slice(0, 15)) {
    const files = filesByDir.get(dir) || [];
    const samples = files.slice(0, 3).join(", ");
    const more = files.length > 3 ? ` +${files.length - 3} more` : "";
    result.push(`${dir}/ (${count} files): ${samples}${more}`);
  }

  if (sorted.length > 15) {
    result.push(`... and ${sorted.length - 15} more directories`);
  }

  result.push("");
  result.push(
    "[Tool result compressed to save tokens. Request full output if needed.]",
  );

  return result.join("\n");
}

/**
 * Registry of tool result compressors.
 */
export const TOOL_COMPRESSORS: Record<string, ToolResultCompressor> = {
  ls: compressLsOutput,
  grep: compressGrepOutput,
  bash: compressBashOutput,
  read: compressReadOutput,
  find: compressFindOutput,
};

/**
 * Compress tool result based on tool name.
 * Returns original text if no compressor exists or compression not beneficial.
 */
export function compressToolResult(toolName: string, text: string): string {
  const normalizedTool = toolName.toLowerCase();
  const compressor = TOOL_COMPRESSORS[normalizedTool];

  if (!compressor) return text;

  try {
    return compressor(text);
  } catch {
    // If compression fails, return original
    return text;
  }
}
