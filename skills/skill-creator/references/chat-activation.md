# Chat Activation Templates

Use this reference to design conversational flow inside a new skill. Copy the templates into the target skill's SKILL.md (or a reference file) and tailor placeholders. Keep them concise and action-oriented.

## Core Principles

- Start with one clear question and 2-4 options so users can answer quickly.
- Ask for missing constraints only; avoid dumping a long questionnaire.
- Offer a recommended default path to reduce choice paralysis.
- Confirm understanding before executing large actions.
- Provide a fast exit path ("skip", "use defaults", "not sure").

## Minimal Trigger Map

Use this to decide when to engage deeper.

- **Clear intent + low risk**: proceed, confirm scope.
- **Unclear intent**: ask a single clarifying question with options.
- **High risk/irreversible**: confirm twice, restate consequences.
- **Missing inputs**: request only the top 1-2 blocking inputs.

## Quick-Start Opener Templates

Choose one style per skill.

### Option A: Single question

"What do you want to accomplish with {domain}?"

### Option B: Menu + default

"Pick a starting point for {domain}. I recommend **{default}** if you’re unsure.\n1) {option1}\n2) {option2}\n3) {option3}"

### Option C: Example-driven

"Give me one example of the desired outcome (e.g., {example1}, {example2})."

## Clarifying Question Ladder

Ask in order, stop once you have enough.

1) Goal: "What outcome should we optimize for?"
2) Scope: "Which part of {system} should we focus on?"
3) Constraints: "Any limits on time, budget, or tools?"
4) Format: "How should the output be delivered (list, table, code, doc)?"

## Checkpoint Confirmation

"Here’s what I’ll do: {plan}. Proceed? (yes/no)"

## Option Picker (Short)

"Choose one:\n1) {path1}\n2) {path2}\n3) {path3}"

## Context Recovery (If the user went silent)

"Quick check — do you want to continue with {last_step}, or should I switch to {fallback}?"

## Progress Updates (Non-spammy)

- "I’ve gathered {x}. Next, I’ll {next}."
- "I can proceed with defaults. Want me to?"

## Skill-Scoped Completion

"Done. Want any of these next?\n1) {next1}\n2) {next2}\n3) {next3}"

## Safety/Boundary Prompt

"This action is reversible by {rollback}. Confirm if you want to proceed."

## Example: Requirements Gathering (Short)

"To build {feature}, I need two things: goal and constraints.\n1) What’s the primary goal?\n2) Any must-have constraints?"

## Example: Debugging/Investigation

"What’s the exact error message and the last step before it happened?"

## Example: Content/Copy Generation

"Who is the audience, and what action should they take after reading it?"

## Example: Data/Reporting

"Which metric matters most, and over what time range?"

## Example: Design/UX

"What feeling or brand tone should this convey?"

## Tone Tips

- Use short sentences.
- Prefer verbs and choices over explanations.
- Avoid stacked questions; keep one question per message.

## Integration Checklist

- Include 1 opener template
- Include a 3-step clarifying ladder
- Include a confirmation line before major actions
- Include a completion prompt with 2-3 next steps
