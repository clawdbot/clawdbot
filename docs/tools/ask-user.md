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

- The web Control UI shows one unified question card.
- Telegram, Discord, and Slack render native buttons for a single-choice,
  single-question prompt.
- A plain-text reply works on any channel. Reply with a number, an option label,
  or your own answer.

OpenClaw always enables a free-text **Other** answer. The agent must not add an
`Other` option to the authored option list.

Prompts that cannot use native buttons, including multi-question and
multi-select prompts, degrade to readable text. The Control UI keeps the full
structured card.

## Timeout and no answer

The default timeout is 900 seconds. `timeoutSeconds` is clamped to the range
30 through 3600 seconds.

If the question expires or is cancelled before an answer arrives, the tool
returns `status: "no_answer"`. The agent then continues with its best judgment.
An aborted agent run cancels its pending Gateway question.

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
      "deploy_target": {
        "answers": ["Staging (Recommended)"]
      }
    }
  }
}
```

## Model guidance

The model-facing contract tells the agent to:

- ask only when blocked on a genuinely user-owned decision;
- prefer one question and use no more than three;
- put the recommended option first and suffix its label with `(Recommended)`;
- omit an authored `Other` option because free text is added automatically;
- continue with best judgment after `no_answer`.

The agent should not use `ask_user` to ask whether it may proceed or to confirm
its own plan.
