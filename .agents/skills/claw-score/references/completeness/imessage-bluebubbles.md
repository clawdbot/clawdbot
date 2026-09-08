# iMessage Completeness

Use this rubric when assigning category Completeness scores for the
`imessage-bluebubbles` surface.

## Category Scope

- Channel Setup and Operations: Translate legacy config, Cut over safely, Handle migration caveats, Run local imsg, Run through SSH wrapper, Grant macOS permissions, Probe runtime health, Account setup prompts, Account status checks, Doctor repair checks, Account Config
- Access and Identity: Authorize direct senders, Route direct conversations, Bind ACP sessions, Group Policy, Mentions, System Prompts
- Conversation Routing and Delivery: Watch live messages, Coalesce split-send DMs, Replay missed messages, Seed conversation history
- Media and Rich Content: Media, Attachments, Remote Fetch, Chunking, Native Actions, Private API, Message Tool
- Native Controls and Approvals: Native Approvals, Reactions, Operator Control

## Surface-Specific Guidance

- Score `imsg` as the active iMessage transport. BlueBubbles is removed and counts only as a bounded migration workflow under Channel Setup and Operations.
- Keep the stable `imessage-bluebubbles` surface and coverage namespace for compatibility with historical evidence; do not interpret that identifier as an active product name.
