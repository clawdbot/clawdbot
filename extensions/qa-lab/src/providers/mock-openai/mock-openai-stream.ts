import type {
  MockAssistantMessageSpec,
  MockOutputText,
  MockToolCallItem,
  StreamEvent,
} from "./mock-openai-contracts.js";

export class MockResponseStream {
  private readonly response: {
    id: string;
    object: "response";
    output: Array<Record<string, unknown>>;
  };
  private readonly events: StreamEvent[];

  constructor(id: string) {
    this.response = { id, object: "response", output: [] };
    this.events = [
      {
        type: "response.created",
        // Creation must keep an empty snapshot while later items accumulate.
        response: {
          ...this.response,
          status: "in_progress",
          output: [],
          created_at: Math.floor(Date.now() / 1_000),
        },
      },
    ];
  }

  private start(item: Record<string, unknown>, initial = item) {
    const outputIndex = this.response.output.push(item) - 1;
    this.events.push({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: initial,
    });
    return outputIndex;
  }

  private done(item: Record<string, unknown>, outputIndex: number) {
    this.events.push({ type: "response.output_item.done", output_index: outputIndex, item });
  }

  item(item: Record<string, unknown>, initial = item) {
    this.done(item, this.start(item, initial));
  }

  message(spec: MockAssistantMessageSpec, complete = true) {
    const part: MockOutputText = { type: "output_text", text: spec.text, annotations: [] };
    const item = {
      type: "message",
      id: spec.id,
      role: "assistant",
      status: complete ? "completed" : "in_progress",
      ...(spec.phase ? { phase: spec.phase } : {}),
      content: [part],
    };
    const outputIndex = this.start(item, { ...item, content: [], status: "in_progress" });
    const position = { item_id: spec.id, output_index: outputIndex, content_index: 0 };
    this.events.push({
      type: "response.content_part.added",
      ...position,
      part: { ...part, text: "" },
    });
    for (const delta of spec.streamDeltas ?? []) {
      this.events.push({ type: "response.output_text.delta", ...position, delta });
    }
    if (!complete) {
      return;
    }
    this.events.push({ type: "response.output_text.done", ...position, text: spec.text });
    this.events.push({ type: "response.content_part.done", ...position, part });
    this.done(item, outputIndex);
  }

  tool(item: MockToolCallItem) {
    const initial =
      item.type === "function_call"
        ? { ...item, arguments: "" }
        : { ...item, input: "", status: "in_progress" };
    const position = { item_id: item.id, output_index: this.start(item, initial) };
    if (item.type === "function_call") {
      this.events.push(
        { type: "response.function_call_arguments.delta", ...position, delta: item.arguments },
        {
          type: "response.function_call_arguments.done",
          ...position,
          name: item.name,
          arguments: item.arguments,
        },
      );
    } else {
      this.events.push(
        {
          type: "response.custom_tool_call_input.delta",
          ...position,
          call_id: item.call_id,
          delta: item.input,
        },
        { type: "response.custom_tool_call_input.done", ...position, input: item.input },
      );
    }
    this.done(item, position.output_index);
  }

  complete(outputTokens: number): StreamEvent[] {
    this.events.push({
      type: "response.completed",
      response: {
        ...this.response,
        status: "completed",
        usage: { input_tokens: 64, output_tokens: outputTokens, total_tokens: 64 + outputTokens },
      },
    });
    return this.events;
  }

  fail(): StreamEvent[] {
    this.events.push({ type: "response.failed", response: { ...this.response, status: "failed" } });
    return this.events;
  }
}
