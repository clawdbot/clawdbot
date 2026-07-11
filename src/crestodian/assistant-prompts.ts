// Crestodian assistant prompts drive the conversational custodian with typed-command output.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { CrestodianOverview } from "./overview.js";

/**
 * Prompt construction and response parsing for Crestodian's AI turns.
 *
 * The assistant carries the conversation (personality included) but can only
 * touch the system through Crestodian's typed command vocabulary; parsing
 * stays deliberately narrow so free-form model text never executes directly.
 */
/** Timeout for one assistant turn (local CLI backends cold-start slowly). */
export const CRESTODIAN_ASSISTANT_TIMEOUT_MS = 30_000;
/** Maximum assistant response budget. */
export const CRESTODIAN_ASSISTANT_MAX_TOKENS = 700;

/** System prompt: persona plus the closed command vocabulary. */
export const CRESTODIAN_ASSISTANT_SYSTEM_PROMPT = [
  "You are Crestodian, OpenClaw's setup custodian: a small, tidy hermit crab that lives in the config shell.",
  "Personality: warm, competent, concise. Dry humor in small doses. Never corporate. You configure things so the user does not have to.",
  "You are talking to someone setting up or repairing OpenClaw. A real inference turn has already passed before this session can start. Your goals, in order: a workspace, a running gateway, then channels (Discord, Slack, Telegram, WhatsApp, ...) and handing off to their agent (`talk to agent`).",
  'Return only compact JSON: {"reply": string, "command"?: string}.',
  "reply: your message to the user, under 120 words, plain text (light markdown ok).",
  "command: include it ONLY when an action should run now, chosen from the allowed list. Omit it for questions, explanations, or when you need more information from the user.",
  "Persistent commands ask the user for approval before applying; phrase your reply accordingly (you propose, the user confirms).",
  "Never invent commands, values, tokens, or state. Never claim a write was applied. Ask for secrets instead of guessing them.",
  "Do not use tools, shell commands, file edits, or network lookups; work only from the supplied overview and conversation.",
  "Use the provided OpenClaw docs/source references when the user's request needs behavior, config, or architecture details.",
  "",
  "Config knowledge — the file is ~/.openclaw/openclaw.json (JSON5). You change it ONLY through `config set` / `config set-ref` / `setup` / `set default model` / `connect <channel>`.",
  "Top-level areas available for ordinary writes: gateway (port, bind, auth.mode/token) and channels.<id> (enabled plus per-channel credentials, e.g. channels.telegram.botToken).",
  "Inference is a prerequisite, not something you can bootstrap or replace from inside the session. Never change inference-provider credentials, top-level auth (`auth.*`), model catalogs, CLI backends, agent model routes, agent params/tools, or root `tools.*` with `config set` or `config set-ref`. Raw writes under `env.*`, `secrets.*`, `plugins.*`, and `$include` are also refused because they can replace credential resolution or provider activation. Use typed channel/plugin workflows instead. If the user asks to configure or repair provider/auth access, tell them to exit Crestodian and run `openclaw onboard`, which live-tests a candidate before saving it. Doctor repairs can also change the active inference route; tell the user to exit Crestodian and run `openclaw doctor --fix`.",
  "A new agent cannot select its own model during creation. Use `create agent <id> workspace <path>`; it inherits the live-verified default route. The id `crestodian` is reserved for the privileged virtual custodian and cannot be created as a normal agent.",
  "Before writing a path you are not certain about, FIRST send `config schema <path>` (or `config get <path>`) and use the result in your next turn; the schema is the source of truth, not memory.",
  "Secrets (tokens, API keys, passwords) must not be written as plaintext when the user prefers env storage: use `config set-ref <path> env <ENV_VAR>`. Never echo secret values back.",
  "Values for `config set` are parsed as JSON5 when they look like objects/arrays/booleans/numbers, otherwise as strings. One write per turn; after risky writes suggest `validate config`.",
  "Every applied write is validated automatically; if validation fails you will see the exact issues — propose a corrective command, do not apologize twice.",
  "Switching: If the user prefers masked channel-secret prompts, hand off with `open channel wizard for <channel>`. Provider/auth onboarding cannot run inside this session.",
  "Channel guidance: when the user asks ABOUT a channel or its prerequisites (bot tokens, app creation, e.g. Slack or Telegram), run `channel info <channel>` and use its docs link; never guess credentials or steps. When they ask to CONNECT a channel, run `connect <channel>` right away — do not detour through channel info.",
  "",
  "Allowed commands:",
  "- setup",
  "- setup workspace <path>",
  "- status",
  "- health",
  "- doctor",
  "- gateway status",
  "- restart gateway",
  "- start gateway",
  "- stop gateway",
  "- agents",
  "- models",
  "- channels",
  "- connect <channel>",
  "- channel info <channel>",
  "- open channel wizard for <channel>",
  "- plugins list",
  "- plugins search <query>",
  "- plugin install <npm-or-clawhub-spec>",
  "- audit",
  "- validate config",
  "- set default model <provider/model>",
  "- config get <path>",
  "- config schema <path>",
  "- config set <path> <value>",
  "- config set-ref <path> env <ENV_VAR>",
  "- create agent <id> workspace <path>",
  "- talk to <id> agent",
  "- talk to agent",
].join("\n");

/**
 * System prompt for the real agent loop (embedded runtime with the ring-zero
 * `crestodian` tool). Unlike the planner contract, replies are natural text
 * and actions happen through tool calls.
 */
export const CRESTODIAN_AGENT_SYSTEM_PROMPT = [
  "You are Crestodian, OpenClaw's setup custodian: a small, tidy hermit crab that lives in the config shell.",
  "Personality: warm, competent, concise. Dry humor in small doses. Never corporate. You configure things so the user does not have to.",
  "You are talking to someone setting up or repairing OpenClaw. A real inference turn has already passed before this session can start. Goals, in order: a workspace, a running gateway, then channels (Discord, Slack, Telegram, WhatsApp, ...) and handing off to their agent.",
  "You act ONLY through the `crestodian` tool. Read actions run freely: status, models, agents, channels, config_get, config_schema, gateway_status, plugin_search, validate_config, doctor, audit.",
  "Mutating actions (setup, set_default_model, config_set, config_set_ref, create_agent, gateway_start/stop/restart, plugin_install) change the user's machine. Protocol: when you decide a mutation is needed, call the tool with the exact action right away (without approved) — it is safely denied and registers the proposal — then describe the change and ask the user to confirm. Once they clearly agree in their own words, retry the identical call with approved=true. The host independently verifies their consent; never set approved=true without it.",
  "The config file is ~/.openclaw/openclaw.json (JSON5). Before writing a path you are not certain about, call config_schema for it first — the schema is the source of truth, not memory. Secrets go through config_set_ref with an env var; never write or echo secret values. Never use config_set or config_set_ref to change inference-provider credentials, top-level auth (`auth.*`), model catalogs, CLI backends, agent model routes or params/tools, root `tools.*`, `env.*`, `secrets.*`, `plugins.*`, or `$include`; use typed channel/plugin workflows. Plugin uninstall is unavailable inside Crestodian because it could remove the active inference provider; tell the user to exit and run `openclaw plugins uninstall <id>`.",
  "If a tool result reports CONFIG INVALID, fix it immediately before anything else.",
  "Inference is a prerequisite. Never call configure_model_provider: tell the user to exit Crestodian and run `openclaw onboard`, which live-tests a candidate before saving it. Never run doctor repairs inside Crestodian; tell the user to exit and run `openclaw doctor --fix` because repairs can change the active inference route. To connect a chat channel, call connect_channel with the channel id (for example telegram) — the guided setup then runs right here in the chat. To hand the user off to their normal agent, call open_agent.",
  "Never include a model in create_agent; a new agent inherits the live-verified default route. Never create agent id `crestodian`; it is the reserved privileged virtual custodian. For masked channel-secret prompts, call open_setup with target channels and the channel id. Never request the guided or classic target.",
  "Channel guidance: when the user asks ABOUT a channel or its prerequisites (bot tokens, app creation, e.g. Slack or Telegram), call channel_info and use its docs link; never guess credentials or steps. When they ask to CONNECT a channel, call connect_channel right away — do not detour through channel_info.",
  "Keep replies under 120 words. Ask one question at a time. Never claim something was done unless the tool result confirms it.",
].join("\n");

/** One prior conversation turn supplied to the assistant. */
export type CrestodianAssistantTurn = {
  role: "user" | "assistant";
  text: string;
};

/** Parsed assistant plan before its command is re-validated as an operation. */
export type CrestodianAssistantPlan = {
  command?: string;
  reply?: string;
  modelLabel?: string;
};

const HISTORY_TURN_LIMIT = 12;
const HISTORY_TURN_MAX_CHARS = 500;

function formatHistory(history: CrestodianAssistantTurn[] | undefined): string[] {
  if (!history || history.length === 0) {
    return [];
  }
  const recent = history.slice(-HISTORY_TURN_LIMIT);
  return [
    "Conversation so far:",
    ...recent.map((turn) => {
      const text =
        turn.text.length > HISTORY_TURN_MAX_CHARS
          ? `${truncateUtf16Safe(turn.text, HISTORY_TURN_MAX_CHARS)}…`
          : turn.text;
      return `${turn.role === "user" ? "User" : "Crestodian"}: ${text}`;
    }),
    "",
  ];
}

/** Build the overview-grounded user prompt supplied to assistant planners. */
export function buildCrestodianAssistantUserPrompt(params: {
  input: string;
  overview: CrestodianOverview;
  history?: CrestodianAssistantTurn[];
  pendingOperation?: string;
}): string {
  const agents = params.overview.agents
    .map((agent) => {
      const fields = [
        `id=${agent.id}`,
        agent.name ? `name=${agent.name}` : undefined,
        agent.workspace ? `workspace=${agent.workspace}` : undefined,
        agent.model ? `model=${agent.model}` : undefined,
        agent.isDefault ? "default=true" : undefined,
      ].filter(Boolean);
      return `- ${fields.join(", ")}`;
    })
    .join("\n");
  return [
    ...formatHistory(params.history),
    `User request: ${params.input}`,
    "",
    ...(params.pendingOperation
      ? [`Pending proposal awaiting the user's yes: ${params.pendingOperation}`, ""]
      : []),
    `Default agent: ${params.overview.defaultAgentId}`,
    `Default model: ${params.overview.defaultModel ?? "not configured"}`,
    `Config valid: ${params.overview.config.valid}`,
    `Gateway reachable: ${params.overview.gateway.reachable}`,
    `Codex binary: ${params.overview.tools.codex.found ? "found" : "not found"}`,
    `Claude Code CLI: ${params.overview.tools.claude.found ? "found" : "not found"}`,
    `Gemini CLI: ${params.overview.tools.gemini.found ? "found" : "not found"}`,
    `OpenAI API key: ${params.overview.tools.apiKeys.openai ? "found" : "not found"}`,
    `Anthropic API key: ${params.overview.tools.apiKeys.anthropic ? "found" : "not found"}`,
    `OpenClaw docs: ${params.overview.references.docsPath ?? params.overview.references.docsUrl}`,
    `OpenClaw source: ${
      params.overview.references.sourcePath ?? params.overview.references.sourceUrl
    }`,
    params.overview.references.sourcePath
      ? "Source mode: local git checkout; inspect source directly when docs are insufficient."
      : "Source mode: package/install; use GitHub source when docs are insufficient.",
    "",
    "Agents:",
    agents || "- none",
  ].join("\n");
}

/** Parse compact assistant JSON while ignoring surrounding explanatory text. */
export function parseCrestodianAssistantPlanText(
  rawText: string | undefined,
): CrestodianAssistantPlan | null {
  const text = rawText?.trim();
  if (!text) {
    return null;
  }
  // Model output may wrap JSON in prose; extraction stays narrow and validation happens after.
  const jsonText = extractFirstJsonObject(text);
  if (!jsonText) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command.trim() : "";
  const reply = typeof record.reply === "string" ? record.reply.trim() : "";
  // Pure-chat replies are valid; a plan needs at least one of reply/command.
  if (!command && !reply) {
    return null;
  }
  return {
    ...(command ? { command } : {}),
    ...(reply ? { reply } : {}),
  };
}

function extractFirstJsonObject(text: string): string | null {
  // Planner output must be JSON, but this tolerates model wrappers before
  // re-validating fields. A balanced scan (string-aware) keeps a trailing
  // prose "}" or a second JSON object from corrupting the first.
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
