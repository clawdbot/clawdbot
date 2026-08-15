# Channel framework Completeness

Use this rubric when assigning category Completeness scores for the
`channel-framework` surface.

## Category Scope

- Channel Actions Commands and Approvals: Channel-native commands, Native command session target, Message actions, Message tool API discovery, Channel-native approval prompts
- Channel Setup: Supported channel catalog, Channel status taxonomy in channels list, Setup/onboarding flows, Install-on-demand, Setup wizard metadata
- Group Thread and Ambient Room Behavior: Group/channel session isolation, Mention-required, Native threads, Broadcast groups, Bot-loop protection
- Inbound Access and Identity Gates: DM pairing, Group/channel allowlists, Access group expansion, Mention gating, Sanitized inbound identity/route projections
- Media Attachments and Rich Channel Data: Inbound media normalization, Outbound direct text/media sends, Provider-specific channelData, Media roots
- Outbound Delivery and Reply Pipeline: Automatic final reply delivery, Durable outbound send orchestration, Reply pipeline transforms, Provider outbound adapter bridge
- Conversation Routing and Delivery: Inbound conversation routing, Session key construction, Agent binding precedence, Runtime conversation bindings, Thread/parent-child placement, Plugin registry resolution, Channel account startup, Whole-channel lifecycle controls, Config/secrets reload interactions, Auto-restart
- Status Health and Operator Controls: channels.status, Channel health policy, Operator CLI controls, Status read-model
