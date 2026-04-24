export type OpenAIResponsesAssistantPhase = "commentary" | "final_answer";

export type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | {
      type: "input_image";
      source: { type: "url"; url: string } | { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "image_url";
      image_url: { url: string };
    };

export type InputItem =
  | {
      type: "message";
      role: "system" | "developer" | "user" | "assistant";
      content: string | ContentPart[];
      phase?: OpenAIResponsesAssistantPhase;
    }
  | { type: "function_call"; id?: string; call_id?: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | {
      type: "reasoning";
      id?: string;
      content?: string;
      encrypted_content?: string;
      summary?: string;
    }
  | { type: "item_reference"; id: string };

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface FunctionToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

export interface ResponseCreateEvent {
  type: "response.create";
  model: string;
  store?: boolean;
  stream?: boolean;
  input?: string | InputItem[];
  instructions?: string;
  tools?: FunctionToolDefinition[];
  tool_choice?: ToolChoice;
  context_management?: unknown;
  previous_response_id?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  metadata?: Record<string, string>;
  reasoning?: {
    effort?: "none" | "low" | "medium" | "high" | "xhigh";
    summary?: "auto" | "concise" | "detailed";
  };
  text?: { verbosity?: "low" | "medium" | "high"; [key: string]: unknown };
  truncation?: "auto" | "disabled";
  [key: string]: unknown;
}

/** Warm-up payload: generate: false pre-loads connection without generating output */
export interface WarmUpEvent extends ResponseCreateEvent {
  generate: false;
}

export type ClientEvent = ResponseCreateEvent | WarmUpEvent;
