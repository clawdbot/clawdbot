import type {
  AnyBlock,
  AnyChunk,
  PlanBlock,
  RichTextBlock,
  TaskCardBlock,
  TaskUpdateChunk,
} from "@slack/types";

// chat.update replaces the whole message. Keep a bounded projection from the
// first append, including buffered and definitively rejected chunks. Never
// repair an expired stream from only its last delta.
export class SlackStreamProjection {
  private blocks: AnyBlock[] = [];
  private tasks = new Map<string, TaskUpdateChunk>();
  private planIndex: number | undefined;
  private planTitle = "";
  private unavailable = false;

  constructor(private readonly taskDisplayMode: "plan" | "timeline" = "timeline") {}

  append(text?: string, chunks?: AnyChunk[]): void {
    if (this.unavailable) {
      return;
    }
    for (const chunk of [
      ...(text ? [{ type: "markdown_text" as const, text }] : []),
      ...(chunks ?? []),
    ]) {
      switch (chunk.type) {
        case "markdown_text": {
          const last = this.blocks.at(-1);
          if (last?.type === "markdown" && "text" in last && typeof last.text === "string") {
            last.text += chunk.text;
          } else {
            this.blocks.push({ type: "markdown", text: chunk.text });
          }
          break;
        }
        case "blocks":
          this.blocks.push(...structuredClone(chunk.blocks));
          break;
        case "plan_update":
          this.planTitle = chunk.title;
          this.ensurePlan();
          break;
        case "task_update": {
          if (this.taskDisplayMode === "plan") {
            this.ensurePlan();
          }
          const previous = this.tasks.get(chunk.id);
          const task: TaskUpdateChunk = {
            ...previous,
            type: "task_update",
            id: chunk.id,
            title: chunk.title,
            status: chunk.status,
            ...(chunk.details !== undefined
              ? { details: (previous?.details ?? "") + chunk.details }
              : {}),
            ...(chunk.output !== undefined
              ? { output: (previous?.output ?? "") + chunk.output }
              : {}),
            ...(chunk.sources !== undefined ? { sources: structuredClone(chunk.sources) } : {}),
          };
          this.tasks.set(chunk.id, task);
          if (this.taskDisplayMode === "timeline") {
            const index = this.blocks.findIndex(
              (block) =>
                block.type === "task_card" && "task_id" in block && block.task_id === chunk.id,
            );
            const block = taskCard(task);
            if (index === -1) {
              this.blocks.push(block);
            } else {
              this.blocks[index] = block;
            }
          }
          break;
        }
      }
    }
    // A conservative local retention budget, not Slack's wire-size contract.
    // Native streaming can continue beyond it; recovery must not use a partial copy.
    if (JSON.stringify(this.render()).length > 40_000 || this.blocks.length > 50) {
      this.unavailable = true;
      this.blocks = [];
      this.tasks.clear();
    }
  }

  private ensurePlan(): void {
    if (this.planIndex === undefined) {
      this.planIndex = this.blocks.length;
      this.blocks.push({ type: "plan", title: "" });
    }
  }

  private render(): AnyBlock[] {
    const blocks = [...this.blocks];
    if (this.planIndex !== undefined) {
      const tasks = [...this.tasks.values()].map((task) => {
        const { type: _type, ...fields } = taskCard(task);
        return fields;
      });
      const plans: PlanBlock[] = [];
      // Plan tasks intentionally omit the standalone task_card type field.
      // https://docs.slack.dev/reference/block-kit/blocks/plan-block/
      for (let i = 0; i < Math.max(tasks.length, 1); i += 50) {
        plans.push({
          type: "plan",
          title: this.planTitle,
          tasks: this.taskDisplayMode === "plan" ? tasks.slice(i, i + 50) : [],
        });
        if (this.taskDisplayMode === "timeline") {
          break;
        }
      }
      blocks.splice(this.planIndex, 1, ...plans);
    }
    return blocks;
  }

  getBlocks(): AnyBlock[] {
    const blocks = this.render();
    const markdownLength = blocks.reduce(
      (length, block) =>
        length +
        (block.type === "markdown" && "text" in block && typeof block.text === "string"
          ? block.text.length
          : 0),
      0,
    );
    if (this.unavailable || blocks.length > 50 || markdownLength > 12_000) {
      throw new Error("slack-stream: full-message recovery exceeds Slack message limits");
    }
    return blocks;
  }
}

function plainRichText(text: string): RichTextBlock {
  return {
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
  };
}

// Streaming source chunks use url_source in the SDK; Block Kit's published
// URL source element contract uses url.
// https://docs.slack.dev/reference/block-kit/block-elements/url-source-element/
function taskCard(task: TaskUpdateChunk): Omit<TaskCardBlock, "sources"> & {
  sources?: { type: "url"; url: string; text: string }[];
} {
  return {
    type: "task_card",
    task_id: task.id,
    title: task.title,
    status: task.status,
    ...(task.details ? { details: plainRichText(task.details) } : {}),
    ...(task.output ? { output: plainRichText(task.output) } : {}),
    ...(task.sources
      ? {
          sources: task.sources.map((source) => ({
            type: "url" as const,
            url: source.url,
            text: source.text,
          })),
        }
      : {}),
  };
}
