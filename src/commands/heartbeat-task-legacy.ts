/** Doctor-only reader for the retired YAML-like heartbeat `tasks:` syntax. */

export type LegacyHeartbeatTask = {
  name: string;
  interval: string;
  prompt: string;
};

type LegacyHeartbeatTaskDocument = {
  hasTasksBlock: boolean;
  taskEntryCount: number;
  tasks: LegacyHeartbeatTask[];
  strippedContent: string;
};

type HeartbeatLine = {
  htmlCommentSource?: string;
  raw: string;
  source: string;
  visible: string;
};

type LegacyHeartbeatTaskBuilder = Partial<LegacyHeartbeatTask>;

function splitHeartbeatLines(content: string): Array<{ raw: string; source: string }> {
  const lines: Array<{ raw: string; source: string }> = [];
  const matcher = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  for (const match of content.matchAll(matcher)) {
    const source = match[0];
    if (!source) {
      continue;
    }
    const raw = source.replace(/(?:\r\n|\n|\r)$/, "");
    lines.push({ raw, source });
  }
  return lines;
}

function scanHeartbeatLine(raw: string, state: { inHtmlComment: boolean }) {
  let cursor = 0;
  let hasHtmlComment = state.inHtmlComment;
  let htmlCommentRaw = "";
  let visible = "";
  while (cursor < raw.length) {
    if (state.inHtmlComment) {
      const commentEnd = raw.indexOf("-->", cursor);
      if (commentEnd === -1) {
        htmlCommentRaw += raw.slice(cursor);
        return { hasHtmlComment, htmlCommentRaw, visible };
      }
      htmlCommentRaw += raw.slice(cursor, commentEnd + 3);
      state.inHtmlComment = false;
      cursor = commentEnd + 3;
      continue;
    }

    const commentStart = raw.indexOf("<!--", cursor);
    if (commentStart === -1) {
      const outside = raw.slice(cursor);
      visible += outside;
      htmlCommentRaw += outside.replace(/\S/g, "");
      return { hasHtmlComment, htmlCommentRaw, visible };
    }
    const outside = raw.slice(cursor, commentStart);
    visible += outside;
    htmlCommentRaw += outside.replace(/\S/g, "") + "<!--";
    hasHtmlComment = true;
    state.inHtmlComment = true;
    cursor = commentStart + 4;
  }
  return { hasHtmlComment, htmlCommentRaw, visible };
}

function tokenizeHeartbeatLines(content: string): HeartbeatLine[] {
  const state = { inHtmlComment: false };
  return splitHeartbeatLines(content).map((line) => {
    const scanned = scanHeartbeatLine(line.raw, state);
    const lineEnding = line.source.slice(line.raw.length);
    const token: HeartbeatLine = {
      raw: line.raw,
      source: line.source,
      visible: scanned.visible,
    };
    if (scanned.hasHtmlComment) {
      token.htmlCommentSource = scanned.htmlCommentRaw + lineEnding;
    }
    return token;
  });
}

function unquoteTaskValue(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

/**
 * Parses and marks removable task syntax in one pass. The same boundary decision
 * therefore owns both cron creation and the bytes Doctor may remove.
 */
export function analyzeLegacyHeartbeatTasks(content: string): LegacyHeartbeatTaskDocument {
  const lines = tokenizeHeartbeatLines(content);
  const removedLineIndexes = new Set<number>();
  const tasks: LegacyHeartbeatTask[] = [];
  let taskEntryCount = 0;
  let hasTasksBlock = false;
  let inTasksBlock = false;
  let currentTask: LegacyHeartbeatTaskBuilder | undefined;
  let orphanEntryOpen = false;

  const finishCurrentTask = () => {
    if (currentTask?.name && currentTask.interval && currentTask.prompt) {
      tasks.push({
        name: currentTask.name,
        interval: currentTask.interval,
        prompt: currentTask.prompt,
      });
    }
    currentTask = undefined;
  };

  for (const [index, line] of lines.entries()) {
    const trimmed = line.visible.trim();

    // Every visible marker starts a new block, including a marker immediately
    // following another block with no intervening prose.
    if (trimmed === "tasks:") {
      finishCurrentTask();
      orphanEntryOpen = false;
      hasTasksBlock = true;
      inTasksBlock = true;
      removedLineIndexes.add(index);
      continue;
    }
    if (!inTasksBlock) {
      continue;
    }

    if (!trimmed) {
      // Whitespace belongs to the task block. HTML comments are invisible to
      // the parser but remain user-authored scratch and must survive migration.
      if (!line.raw.trim()) {
        removedLineIndexes.add(index);
      }
      continue;
    }

    if (trimmed.startsWith("- name:")) {
      finishCurrentTask();
      orphanEntryOpen = false;
      taskEntryCount += 1;
      currentTask = { name: unquoteTaskValue(trimmed.slice("- name:".length)) };
      removedLineIndexes.add(index);
      continue;
    }

    const isIndented = line.visible.startsWith(" ") || line.visible.startsWith("\t");
    if (isIndented && trimmed.startsWith("interval:")) {
      if (currentTask) {
        currentTask.interval = unquoteTaskValue(trimmed.slice("interval:".length));
      } else if (!orphanEntryOpen) {
        taskEntryCount += 1;
        orphanEntryOpen = true;
      }
      removedLineIndexes.add(index);
      continue;
    }
    if (isIndented && trimmed.startsWith("prompt:")) {
      if (currentTask) {
        currentTask.prompt = unquoteTaskValue(trimmed.slice("prompt:".length));
      } else if (!orphanEntryOpen) {
        taskEntryCount += 1;
        orphanEntryOpen = true;
      }
      removedLineIndexes.add(index);
      continue;
    }

    // Any other visible non-empty line is surrounding scratch, even when it
    // is indented. It ends the block and is preserved byte-for-byte.
    finishCurrentTask();
    orphanEntryOpen = false;
    inTasksBlock = false;
  }
  finishCurrentTask();

  return {
    hasTasksBlock,
    taskEntryCount,
    tasks,
    strippedContent: lines
      .map((line, index) =>
        removedLineIndexes.has(index) ? (line.htmlCommentSource ?? "") : line.source,
      )
      .join(""),
  };
}
