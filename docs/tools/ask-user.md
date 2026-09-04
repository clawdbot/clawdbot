---
summary: "How ask_user pauses an agent turn for a structured human decision"
read_when:
  - You want an agent to ask the user a structured question
  - You are answering or debugging an ask_user prompt
  - You need the ask_user schema, timeout, or channel behavior
title: "Ask user"
---

`ask_user` lets the agent ask the human one to three structured questions and
wait for the answers. It is for decisions that genuinely belong to the user,
not routine confirmation or information the agent can derive from the request,
code, or a sensible default.

The tool is available only in the main session. Subagents and other non-primary
runs do not receive it.

## Answer a question

You can answer from any supported conversation surface:

- The web Control UI docks a question panel directly above the composer. For
  multi-question prompts, the panel shows one question at a time and advances
  through a short stepper. After resolution, the panel closes and the chat
  keeps only a compact answer summary.
- Telegram renders each choice as a full-width native button for one
  single-select question. **Other…** switches to Telegram's reply input without
  resolving the question.
- Discord and Slack render native buttons for a single-choice, single-question
  prompt.
- For a question created by an active OpenClaw run, a plain-text reply works on
  any channel when your current permissions match the creator's. Reply with a
  number, an option label, or your own answer. For multi-select questions,
  separate choices with commas.

Questions from a standalone [attached MCP client](/cli/attach) do not carry an
OpenClaw run's creator binding. Answer those using the question controls in the
Control UI or native app, not an ordinary channel message.

OpenClaw always enables a free-text **Other** answer. The agent must not add an
`Other` option to the authored option list.

Never answer `ask_user` with a credential. When the agent needs an API key it
uses the [`secrets` tool](/tools/secrets), whose masked prompt stores the value
without it entering the chat, the transcript, or the model's context.

## Platform behavior

Answers work on every supported conversation surface. The web Control UI uses a
docked stepper that replaces the composer while expanded; collapsing it restores
the full composer beneath a slim question bar. iOS, macOS, and Android show
inline cards; multiple questions stay stacked as an intentional touch-friendly
idiom. Every platform keeps the question-to-answer summary in the active chat
timeline without timed eviction, and **Skip** is available everywhere.

Multi-question and multi-select prompts degrade to readable text on messaging
channels. The Control UI keeps the full structured stepper.

## Timeout and no answer

The default timeout is 900 seconds. `timeoutSeconds` is clamped to the range
30 through 3600 seconds. This is a maximum human wait, subject to earlier agent
run cancellation or the overall run timeout. A pending question does not extend
an explicit run budget.

If the question expires or is cancelled before an answer arrives, the tool
returns `status: "no_answer"`. The agent then continues with its best judgment.
An aborted agent run cancels its pending Gateway question.

Gateway question records include the optional originating `runId`. Clients can
use it to keep the prompt and its terminal answer summary with the correct agent
turn, including after reconnecting and recovering the question with
`question.list` or `question.get`.

## Tool schema

```ts
{
  questions: Array<{
    id: string; // unique snake_case answer key
    header: string; // short label; truncated to 12 characters
    question: string; // one sentence
    options: Array<{
      label: string;
      description?: string;
    }>; // 2-4 options
    multiSelect?: boolean;
  }>; // 1-3 questions
  timeoutSeconds?: number; // integer; default 900, clamped to 30-3600
}
```

With `multiSelect: true`, the user can choose more than one option. Answer
values are returned as an array for every question.

Example answered result:

```json
{
  "status": "answered",
  "answers": {
    "answers": {
      "deploy_target": ["Staging (Recommended)"]
    }
  }
}
```

## Model guidance

The model-facing contract tells the agent to:

- ask only when blocked on a genuinely user-owned decision;
- ask exactly one question per call unless several answers must be submitted
  together, because one-question prompts can use native messaging controls;
- put every selectable choice in `options`, never only in question prose;
- use `multiSelect` only when several choices can be selected at once;
- put the recommended option first and suffix its label with `(Recommended)`;
- omit an authored `Other` option because free text is added automatically;
- continue with best judgment after `no_answer`.

The agent should not use `ask_user` to ask whether it may proceed or to confirm
its own plan.
