---
summary: "Generated heading map for OpenClaw docs pages"
read_when: "Finding which docs page covers a topic before reading the page"
title: "Docs map"
---

# OpenClaw docs map

This file is generated from `docs/**/*.md` and `docs/**/*.mdx` headings to help agents navigate the documentation tree.
Do not edit it by hand; run `pnpm docs:map:gen`.

## agent-runtime-architecture.md

- Route: /agent-runtime-architecture
- Headings:
  - H2: Runtime Layout
  - H2: Boundaries
  - H2: Manifests
  - H2: Runtime Selection
  - H2: Related

## announcements/bluebubbles-imessage.md

- Route: /announcements/bluebubbles-imessage
- Headings:
  - H1: BlueBubbles removal and the imsg iMessage path
  - H2: What changed
  - H2: What to do
  - H2: Migration notes
  - H2: See also

## auth-credential-semantics.md

- Route: /auth-credential-semantics
- Headings:
  - H2: Stable probe reason codes
  - H2: Token credentials
  - H3: Eligibility rules
  - H3: Resolution rules
  - H2: Agent copy portability
  - H2: Config-only auth routes
  - H2: Explicit auth order filtering
  - H2: Probe target resolution
  - H2: External CLI credential discovery
  - H2: OAuth SecretRef Policy Guard
  - H2: Legacy-Compatible Messaging
  - H2: Related

## automation/auth-monitoring.md

- Route: /automation/auth-monitoring
- Headings:
  - H2: Related

## automation/clawflow.md

- Route: /automation/clawflow
- Headings:
  - H2: Related

## automation/cron-jobs.md

- Route: /automation/cron-jobs
- Headings:
  - H2: Quick start
  - H2: How cron works
  - H2: Schedule types
  - H3: Day-of-month and day-of-week use OR logic
  - H2: Payloads
  - H3: Agent-turn options
  - H3: Command payloads
  - H2: Execution styles
  - H2: Delivery and output
  - H3: Failure notifications
  - H3: Output language
  - H2: CLI examples
  - H2: Managing jobs
  - H2: Webhooks
  - H3: Authentication
  - H2: Gmail PubSub integration
  - H3: Wizard setup (recommended)
  - H3: Gateway auto-start
  - H3: Manual one-time setup
  - H3: Gmail model override
  - H2: Configuration
  - H2: Troubleshooting
  - H3: Command ladder
  - H2: Related

## automation/cron-vs-heartbeat.md

- Route: /automation/cron-vs-heartbeat
- Headings:
  - H2: Related

## automation/gmail-pubsub.md

- Route: /automation/gmail-pubsub
- Headings:
  - H2: Related

## automation/hooks.md

- Route: /automation/hooks
- Headings:
  - H2: Choose the right surface
  - H2: Quick start
  - H2: Event types
  - H2: Writing hooks
  - H3: Hook structure
  - H3: HOOK.md format
  - H3: Handler implementation
  - H3: Event context highlights
  - H2: Hook discovery
  - H3: Hook packs
  - H2: Bundled hooks
  - H3: session-memory details
  - H3: bootstrap-extra-files config
  - H3: command-logger details
  - H3: compaction-notifier details
  - H3: boot-md details
  - H2: Plugin hooks
  - H2: Configuration
  - H2: CLI reference
  - H2: Best practices
  - H2: Troubleshooting
  - H3: Hook not discovered
  - H3: Hook not eligible
  - H3: Hook not executing
  - H2: Related

## automation/index.md

- Route: /automation
- Headings:
  - H2: Quick decision guide
  - H3: Scheduled Tasks (Cron) vs Heartbeat
  - H2: Core concepts
  - H3: Scheduled tasks (cron)
  - H3: Tasks
  - H3: Inferred commitments
  - H3: Task Flow
  - H3: Standing orders
  - H3: Hooks
  - H3: Heartbeat
  - H2: How they work together
  - H2: Related

## automation/poll.md

- Route: /automation/poll
- Headings:
  - H2: Related

## automation/standing-orders.md

- Route: /automation/standing-orders
- Headings:
  - H2: Why standing orders
  - H2: How they work
  - H2: Anatomy of a standing order
  - H2: Standing orders plus cron jobs
  - H2: Examples
  - H3: Example 1: content and social media (weekly cycle)
  - H3: Example 2: finance operations (event-triggered)
  - H3: Example 3: monitoring and alerts (continuous)
  - H2: Execute-verify-report pattern
  - H2: Multi-program architecture
  - H2: Best practices
  - H3: Do
  - H3: Avoid
  - H2: Related

## automation/taskflow.md

- Route: /automation/taskflow
- Headings:
  - H2: When to use Task Flow
  - H2: Sync modes
  - H3: Managed mode
  - H3: Mirrored mode
  - H2: Flow statuses
  - H2: Durable state and revision tracking
  - H2: Cancel behavior
  - H2: CLI commands
  - H2: Reliable scheduled workflow pattern
  - H2: How flows relate to tasks
  - H2: Related

## automation/tasks.md

- Route: /automation/tasks
- Headings:
  - H2: TL;DR
  - H2: Quick start
  - H2: What creates a task
  - H2: Task lifecycle
  - H2: Delivery and notifications
  - H3: Notification policies
  - H2: CLI reference
  - H2: Chat task board (/tasks)
  - H3: Control UI
  - H2: Status integration (task pressure)
  - H2: Storage and maintenance
  - H3: Where tasks live
  - H3: Automatic maintenance
  - H2: How tasks relate to other systems
  - H2: Related

## automation/troubleshooting.md

- Route: /automation/troubleshooting
- Headings:
  - H2: Related

## automation/webhook.md

- Route: /automation/webhook
- Headings:
  - H2: Related

## brave-search.md

- Route: /brave-search
- Headings:
  - H2: Related

## channels/access-groups.md

- Route: /channels/access-groups
- Headings:
  - H2: Static message sender groups
  - H2: Reference groups from allowlists
  - H2: Supported message-channel paths
  - H2: Discord channel audiences
  - H2: Plugin diagnostics
  - H2: Security notes
  - H2: Troubleshooting

## channels/ambient-room-events.md

- Route: /channels/ambient-room-events
- Headings:
  - H2: Recommended setup
  - H2: What changes
  - H2: Discord example
  - H2: Slack example
  - H2: Telegram example
  - H2: Agent specific policy
  - H2: Visible reply modes
  - H2: History
  - H2: Troubleshooting
  - H2: Related

## channels/bot-loop-protection.md

- Route: /channels/bot-loop-protection
- Headings:
  - H2: Defaults
  - H2: Configure shared defaults
  - H2: Override per channel, account, or room
  - H2: Channel support

## channels/broadcast-groups.md

- Route: /channels/broadcast-groups
- Headings:
  - H2: Overview
  - H2: Configuration
  - H3: Basic setup
  - H3: Processing strategy
  - H3: Complete example
  - H2: How it works
  - H3: Message flow
  - H3: Session isolation
  - H3: Example: isolated sessions
  - H2: Use cases
  - H2: Best practices
  - H2: Compatibility
  - H3: Providers
  - H3: Routing
  - H2: Troubleshooting
  - H2: Examples
  - H2: API reference
  - H3: Config schema
  - H3: Fields
  - H2: Limitations
  - H2: Related

## channels/channel-routing.md

- Route: /channels/channel-routing
- Headings:
  - H1: Channels &amp; routing
  - H2: Key terms
  - H2: Outbound target prefixes
  - H2: Session key shapes (examples)
  - H2: Main DM route pinning
  - H2: Guarded inbound recording
  - H2: Routing rules (how an agent is chosen)
  - H2: Broadcast groups (run multiple agents)
  - H2: Config overview
  - H2: Session storage
  - H2: WebChat behavior
  - H2: Reply context
  - H2: Related

## channels/clickclack.md

- Route: /channels/clickclack
- Headings:
  - H2: Quick setup
  - H3: Account config keys
  - H2: Multiple bots
  - H2: Reply modes
  - H2: Agent activity rows
  - H2: Targets
  - H2: Permissions
  - H2: Troubleshooting

## channels/discord.md

- Route: /channels/discord
- Headings:
  - H2: Quick setup
  - H2: Recommended: Set up a guild workspace
  - H2: Runtime model
  - H2: Forum channels
  - H2: Interactive components
  - H2: Access control and routing
  - H3: Role-based agent routing
  - H2: Native commands and command auth
  - H2: Feature details
  - H2: Tools and action gates
  - H2: Components v2 UI
  - H2: Voice
  - H3: Voice channels
  - H3: Follow users in voice
  - H3: Voice messages
  - H2: Troubleshooting
  - H2: Configuration reference
  - H2: Safety and operations
  - H2: Related

## channels/feishu.md

- Route: /channels/feishu
- Headings:
  - H2: Quick start
  - H2: Access control
  - H3: Direct messages
  - H3: Group chats
  - H2: Group configuration examples
  - H3: Allow all groups, no @mention required
  - H3: Allow all groups, still require @mention
  - H3: Allow specific groups only
  - H3: Restrict senders within a group
  - H2: Get group/user IDs
  - H3: Group IDs (chatid, format: ocxxx)
  - H3: User IDs (openid, format: ouxxx)
  - H2: Common commands
  - H2: Troubleshooting
  - H3: Bot does not respond in group chats
  - H3: Bot does not receive messages
  - H3: QR setup does not react in the Feishu mobile app
  - H3: App Secret leaked
  - H2: Advanced configuration
  - H3: Multiple accounts
  - H3: Message limits
  - H3: Streaming
  - H3: Quota optimization
  - H3: Group session scope and topic threads
  - H3: Feishu workspace tools
  - H3: ACP sessions
  - H4: Persistent ACP binding
  - H4: Spawn ACP from chat
  - H3: Multi-agent routing
  - H2: Per-user agent isolation (Dynamic Agent Creation)
  - H3: Quick setup
  - H3: How it works
  - H3: Configuration options
  - H3: Session scope
  - H3: Typical multi-user deployment
  - H3: Verification
  - H3: Notes
  - H2: Configuration reference
  - H2: Supported message types
  - H3: Receive
  - H3: Send
  - H3: Threads and replies
  - H2: Related

## channels/googlechat.md

- Route: /channels/googlechat
- Headings:
  - H2: Install
  - H2: Quick setup (beginner)
  - H2: Add to Google Chat
  - H2: Public URL (Webhook-only)
  - H3: Option A: Tailscale Funnel (Recommended)
  - H3: Option B: Reverse Proxy (Caddy)
  - H3: Option C: Cloudflare Tunnel
  - H2: How it works
  - H2: Targets
  - H2: Config highlights
  - H2: Troubleshooting
  - H3: 405 Method Not Allowed
  - H3: Other issues
  - H2: Related

## channels/group-messages.md

- Route: /channels/group-messages
- Headings:
  - H2: Behavior
  - H2: Config example (WhatsApp)
  - H3: Activation command (owner-only)
  - H2: How to use
  - H2: Testing / verification
  - H2: Known considerations
  - H2: Related

## channels/groups.md

- Route: /channels/groups
- Headings:
  - H2: Beginner intro (2 minutes)
  - H2: Visible replies
  - H2: Context visibility and allowlists
  - H2: Session keys
  - H2: Pattern: personal DMs + public groups (single agent)
  - H2: Display labels
  - H2: Group policy
  - H2: Mention gating (default)
  - H2: Scope configured mention patterns
  - H2: Group/channel tool restrictions (optional)
  - H2: Group allowlists
  - H2: Activation (owner-only)
  - H2: Context fields
  - H2: iMessage specifics
  - H2: WhatsApp system prompts
  - H2: WhatsApp specifics
  - H2: Related

## channels/imessage-from-bluebubbles.md

- Route: /channels/imessage-from-bluebubbles
- Headings:
  - H2: Migration checklist
  - H2: What imsg does
  - H2: Before you start
  - H2: Config translation
  - H2: Group registry footgun
  - H2: Step-by-step
  - H2: Action parity at a glance
  - H2: Pairing, sessions, and ACP bindings
  - H2: No rollback channel
  - H2: Related

## channels/imessage.md

- Route: /channels/imessage
- Headings:
  - H2: Quick setup
  - H2: Requirements and permissions (macOS)
  - H2: Enabling the imsg private API
  - H3: Setup
  - H3: When SIP stays enabled
  - H2: Access control and routing
  - H2: ACP conversation bindings
  - H2: Deployment patterns
  - H2: Media, chunking, and delivery targets
  - H2: Private API actions
  - H2: Config writes
  - H2: Coalescing split-send DMs (command + URL in one composition)
  - H3: Scenarios and what the agent sees
  - H2: Inbound recovery after a bridge or gateway restart
  - H3: Operator-visible signal
  - H3: Migration
  - H2: Troubleshooting
  - H2: Configuration reference pointers
  - H2: Related

## channels/index.md

- Route: /channels
- Headings:
  - H2: Supported channels
  - H2: Delivery notes
  - H2: Notes

## channels/irc.md

- Route: /channels/irc
- Headings:
  - H2: Quick start
  - H2: Connection settings
  - H2: Security defaults
  - H2: Access control
  - H3: Common gotcha: allowFrom is for DMs, not channels
  - H2: Reply triggering (mentions)
  - H2: Security note (recommended for public channels)
  - H3: Same tools for everyone in the channel
  - H3: Different tools per sender (owner gets more power)
  - H2: NickServ
  - H2: Environment variables
  - H2: Troubleshooting
  - H2: Related

## channels/line.md

- Route: /channels/line
- Headings:
  - H2: Install
  - H2: Setup
  - H2: Configure
  - H2: Access control
  - H2: Message behavior
  - H2: Channel data (rich messages)
  - H2: ACP support
  - H2: Outbound media
  - H2: Troubleshooting
  - H2: Related

## channels/location.md

- Route: /channels/location
- Headings:
  - H2: Text formatting
  - H2: Context fields
  - H2: Channel notes
  - H2: Related

## channels/matrix-migration.md

- Route: /channels/matrix-migration
- Headings:
  - H2: What the migration does automatically
  - H2: What the migration cannot do automatically
  - H2: Recommended upgrade flow
  - H2: How encrypted migration works
  - H2: Common messages and what they mean
  - H3: Upgrade and detection messages
  - H3: Encrypted-state recovery messages
  - H3: Manual recovery messages
  - H3: Custom plugin install messages
  - H2: If encrypted history still does not come back
  - H2: If you want to start fresh for future messages
  - H2: Related

## channels/matrix-presentation.md

- Route: /channels/matrix-presentation
- Headings:
  - H2: Event content
  - H2: Fallback behavior
  - H2: Supported blocks
  - H2: Interactions
  - H2: Relationship to approval metadata
  - H2: Media messages

## channels/matrix-push-rules.md

- Route: /channels/matrix-push-rules
- Headings:
  - H2: Prerequisites
  - H2: Steps
  - H2: Multi-bot notes
  - H2: Homeserver notes
  - H2: Related

## channels/matrix.md

- Route: /channels/matrix
- Headings:
  - H2: Install
  - H2: Setup
  - H3: Interactive setup
  - H3: Minimal config
  - H3: Auto-join
  - H3: Allowlist target formats
  - H3: Account ID normalization
  - H3: Cached credentials
  - H3: Environment variables
  - H2: Configuration example
  - H2: Streaming previews
  - H2: Voice messages
  - H2: Approval metadata
  - H3: Self-hosted push rules for quiet finalized previews
  - H2: Bot-to-bot rooms
  - H2: Encryption and verification
  - H3: Enable encryption
  - H3: Status and trust signals
  - H3: Verify this device with a recovery key
  - H3: Bootstrap or repair cross-signing
  - H3: Room-key backup
  - H3: Listing, requesting, and responding to verifications
  - H3: Multi-account notes
  - H2: Profile management
  - H2: Threads
  - H3: Session routing (sessionScope)
  - H3: Reply threading (threadReplies)
  - H3: Thread inheritance and slash commands
  - H2: ACP conversation bindings
  - H3: Thread binding config
  - H2: Reactions
  - H2: History context
  - H2: Context visibility
  - H2: DM and room policy
  - H2: Direct room repair
  - H2: Exec approvals
  - H2: Slash commands
  - H2: Multi-account
  - H2: Private/LAN homeservers
  - H2: Proxying Matrix traffic
  - H2: Target resolution
  - H2: Configuration reference
  - H3: Account and connection
  - H3: Encryption
  - H3: Access and policy
  - H3: Reply behavior
  - H3: Reaction settings
  - H3: Tooling and per-room overrides
  - H3: Exec approval settings
  - H2: Related

## channels/mattermost.md

- Route: /channels/mattermost
- Headings:
  - H2: Install
  - H2: Quick setup
  - H2: Native slash commands
  - H2: Environment variables (default account)
  - H2: Chat modes
  - H2: Threading and sessions
  - H2: Access control (DMs)
  - H2: Channels (groups)
  - H2: Targets for outbound delivery
  - H2: DM channel retry
  - H2: Preview streaming
  - H2: Reactions (message tool)
  - H2: Interactive buttons (message tool)
  - H3: Direct API integration (external scripts)
  - H2: Directory adapter
  - H2: Multi-account
  - H2: Troubleshooting
  - H2: Related

## channels/msteams.md

- Route: /channels/msteams
- Headings:
  - H2: Bundled plugin
  - H2: Quick setup
  - H2: Goals
  - H2: Config writes
  - H2: Access control (DMs + groups)
  - H3: How it works
  - H3: Step 1: Create Azure Bot
  - H3: Step 2: Get credentials
  - H3: Step 3: Configure messaging endpoint
  - H3: Step 4: Enable Teams channel
  - H3: Step 5: Build Teams app manifest
  - H3: Step 6: Configure OpenClaw
  - H3: Step 7: Run the gateway
  - H2: Federated authentication (certificate plus managed identity)
  - H3: Option A: Certificate-based authentication
  - H3: Option B: Azure Managed Identity
  - H3: AKS Workload Identity setup
  - H3: Auth type comparison
  - H2: Local development (tunneling)
  - H2: Testing the bot
  - H2: Environment variables
  - H2: Member info action
  - H2: History context
  - H2: Current Teams RSC permissions (manifest)
  - H2: Example Teams manifest (redacted)
  - H3: Manifest caveats (must-have fields)
  - H3: Updating an existing app
  - H2: Capabilities: RSC only vs Graph
  - H3: With Teams RSC only (app installed, no Graph API permissions)
  - H3: With Teams RSC + Microsoft Graph Application permissions
  - H3: RSC vs Graph API
  - H2: Graph-enabled media + history (required for channels)
  - H2: Known limitations
  - H3: Webhook timeouts
  - H3: Teams cloud and service URL support
  - H3: Formatting
  - H2: Configuration
  - H2: Routing and sessions
  - H2: Reply style: threads vs posts
  - H3: Resolution precedence
  - H3: Thread context preservation
  - H2: Attachments and images
  - H2: Sending files in group chats
  - H3: Why group chats need SharePoint
  - H3: Setup
  - H3: Sharing behavior
  - H3: Fallback behavior
  - H3: Files stored location
  - H2: Polls (Adaptive Cards)
  - H2: Presentation cards
  - H2: Target formats
  - H2: Proactive messaging
  - H2: Team and Channel IDs (Common Gotcha)
  - H2: Private channels
  - H2: Troubleshooting
  - H3: Common issues
  - H3: Manifest upload errors
  - H3: RSC permissions not working
  - H2: References
  - H2: Related

## channels/nextcloud-talk.md

- Route: /channels/nextcloud-talk
- Headings:
  - H2: Install
  - H2: Quick setup (beginner)
  - H2: Notes
  - H2: Access control (DMs)
  - H2: Rooms (groups)
  - H2: Capabilities
  - H2: Configuration reference (Nextcloud Talk)
  - H2: Related

## channels/nostr.md

- Route: /channels/nostr
- Headings:
  - H2: Install
  - H3: Non-interactive setup
  - H2: Quick setup
  - H2: Configuration reference
  - H2: Profile metadata
  - H2: Access control
  - H3: DM policies
  - H3: Allowlist example
  - H2: Key formats
  - H2: Relays
  - H2: Protocol support
  - H2: Testing
  - H3: Local relay
  - H3: Manual test
  - H2: Troubleshooting
  - H3: Not receiving messages
  - H3: Not sending responses
  - H3: Duplicate responses
  - H2: Security
  - H2: Limitations (MVP)
  - H2: Related

## channels/pairing.md

- Route: /channels/pairing
- Headings:
  - H2: 1) DM pairing (inbound chat access)
  - H3: Approve a sender
  - H3: Reusable sender groups
  - H3: Where the state lives
  - H2: 2) Node device pairing (iOS/Android/macOS/headless nodes)
  - H3: Pair from the Control UI (recommended)
  - H3: Pair via Telegram
  - H3: Approve a node device
  - H3: Optional trusted-CIDR node auto-approve
  - H3: Node pairing state storage
  - H3: Notes
  - H2: Related docs

## channels/qa-channel.md

- Route: /channels/qa-channel
- Headings:
  - H2: What it does
  - H2: Config
  - H2: Runners
  - H2: Related

## channels/qqbot.md

- Route: /channels/qqbot
- Headings:
  - H2: Install
  - H2: Setup
  - H2: Configure
  - H3: Access policy
  - H3: Multi-account setup
  - H3: Group chats
  - H3: Voice (STT / TTS)
  - H2: Target formats
  - H2: Slash commands
  - H2: Media and storage
  - H2: Troubleshooting
  - H2: Related

## channels/raft.md

- Route: /channels/raft
- Headings:
  - H2: Install
  - H2: Prerequisites
  - H2: Configure
  - H2: How it works
  - H2: Verify
  - H2: Troubleshooting
  - H2: References

## channels/signal.md

- Route: /channels/signal
- Headings:
  - H2: The number model (read this first)
  - H2: Install
  - H2: Quick setup
  - H2: What it is
  - H2: Setup path A: link existing Signal account (QR)
  - H2: Setup path B: register dedicated bot number (SMS, Linux)
  - H2: External daemon mode (httpUrl)
  - H2: Container mode (bbernhard/signal-cli-rest-api)
  - H2: Access control (DMs + groups)
  - H2: How it works (behavior)
  - H2: Media + limits
  - H2: Typing + read receipts
  - H2: Lifecycle status reactions
  - H2: Reactions (message tool)
  - H2: Approval reactions
  - H2: Delivery targets (CLI/cron)
  - H2: Aliases
  - H2: Troubleshooting
  - H2: Security notes
  - H2: Configuration reference (Signal)
  - H2: Related

## channels/slack.md

- Route: /channels/slack
- Headings:
  - H2: Choosing a transport
  - H3: Relay mode
  - H2: Install
  - H2: Quick setup
  - H2: Socket Mode transport tuning
  - H2: Manifest and scope checklist
  - H3: Additional manifest settings
  - H2: Token model
  - H2: Actions and gates
  - H2: Access control and routing
  - H2: Threading, sessions, and reply tags
  - H2: Ack reactions
  - H3: Emoji (ackReaction)
  - H3: Scope (messages.ackReactionScope)
  - H2: Text streaming
  - H2: Typing reaction fallback
  - H2: Media, chunking, and delivery
  - H2: Commands and slash behavior
  - H2: Interactive replies
  - H3: Plugin-owned modal submissions
  - H2: Native approvals in Slack
  - H2: Events and operational behavior
  - H2: Configuration reference
  - H2: Troubleshooting
  - H2: Attachment vision reference
  - H3: Supported media types
  - H3: Inbound pipeline
  - H3: Thread-root attachment inheritance
  - H3: Multi-attachment handling
  - H3: Size, download, and model limits
  - H3: Known limits
  - H3: Related documentation
  - H2: Related

## channels/sms.md

- Route: /channels/sms
- Headings:
  - H2: Before you begin
  - H2: Quick Setup
  - H2: Configuration Examples
  - H3: Config file
  - H3: Environment variables
  - H3: SecretRef auth token
  - H3: Messaging Service sender
  - H3: Default outbound target
  - H2: Access control
  - H2: Sending SMS
  - H2: Verify Setup
  - H3: End-to-end test from macOS iMessage/SMS
  - H2: Webhook security
  - H2: Multi-account config
  - H2: Troubleshooting
  - H3: Twilio returns 403 or OpenClaw rejects the webhook
  - H3: No pairing request appears
  - H3: Outbound sends fail
  - H3: Messages arrive but the agent does not answer

## channels/synology-chat.md

- Route: /channels/synology-chat
- Headings:
  - H2: Install
  - H2: Quick setup
  - H2: Environment variables
  - H2: DM policy and access control
  - H2: Outbound delivery
  - H2: Multi-account
  - H2: Security notes
  - H2: Troubleshooting
  - H2: Related

## channels/telegram.md

- Route: /channels/telegram
- Headings:
  - H2: Quick setup
  - H2: Telegram side settings
  - H2: Access control and activation
  - H3: Group bot identity
  - H2: Runtime behavior
  - H2: Feature reference
  - H2: Error reply controls
  - H2: Troubleshooting
  - H2: Configuration reference
  - H2: Related

## channels/tlon.md

- Route: /channels/tlon
- Headings:
  - H2: Bundled plugin
  - H2: Setup
  - H2: Private/LAN ships
  - H2: Group channels
  - H2: Access control
  - H2: Owner and approval system
  - H2: Auto-accept settings
  - H2: Hot-reload via Urbit settings store
  - H2: Delivery targets (CLI/cron)
  - H2: Bundled skill
  - H2: Capabilities
  - H2: Troubleshooting
  - H2: Configuration reference
  - H2: Notes
  - H2: Related

## channels/troubleshooting.md

- Route: /channels/troubleshooting
- Headings:
  - H2: Command ladder
  - H2: After an update
  - H2: WhatsApp
  - H3: WhatsApp failure signatures
  - H2: Telegram
  - H3: Telegram failure signatures
  - H2: Discord
  - H3: Discord failure signatures
  - H2: Slack
  - H3: Slack failure signatures
  - H2: iMessage
  - H3: iMessage failure signatures
  - H2: Signal
  - H3: Signal failure signatures
  - H2: QQ Bot
  - H3: QQ Bot failure signatures
  - H2: Matrix
  - H3: Matrix failure signatures
  - H2: Related

## channels/twitch.md

- Route: /channels/twitch
- Headings:
  - H2: Install
  - H2: Quick setup
  - H2: What it is
  - H2: Token refresh (optional)
  - H2: Multi-account support
  - H2: Access control
  - H2: Troubleshooting
  - H2: Config
  - H3: Account config
  - H3: Provider options
  - H2: Tool actions
  - H2: Safety and ops
  - H2: Limits
  - H2: Related

## channels/wechat.md

- Route: /channels/wechat
- Headings:
  - H2: Naming
  - H2: How it works
  - H2: Install
  - H2: Login
  - H2: Access control
  - H2: Compatibility
  - H2: Sidecar process
  - H2: Troubleshooting
  - H2: Related docs

## channels/whatsapp.md

- Route: /channels/whatsapp
- Headings:
  - H2: Install
  - H2: Quick setup
  - H2: Deployment patterns
  - H2: Runtime model
  - H2: Call the current requester with MeowCaller (experimental)
  - H2: Approval prompts
  - H2: Plugin hooks and privacy
  - H2: Access control and activation
  - H2: Configured ACP bindings
  - H2: Personal-number and self-chat behavior
  - H2: Message normalization and context
  - H2: Delivery, chunking, and media
  - H2: Reply quoting
  - H2: Reaction level
  - H2: Acknowledgment reactions
  - H2: Lifecycle status reactions
  - H2: Multi-account and credentials
  - H2: Tools, actions, and config writes
  - H2: Troubleshooting
  - H2: System prompts
  - H2: Configuration reference pointers
  - H2: Related

## channels/yuanbao.md

- Route: /channels/yuanbao
- Headings:
  - H2: Quick start
  - H3: Interactive setup (alternative)
  - H2: Access control
  - H3: Direct messages
  - H3: Group chats
  - H2: Configuration examples
  - H2: Common commands
  - H2: Troubleshooting
  - H2: Advanced configuration
  - H3: Multiple accounts
  - H3: Message limits
  - H3: Streaming
  - H3: Group chat history context
  - H3: Reply-to mode
  - H3: Markdown hint injection
  - H3: Debug mode
  - H3: Multi-agent routing
  - H2: Configuration reference
  - H2: Supported message types
  - H2: Related

## channels/zalo.md

- Route: /channels/zalo
- Headings:
  - H2: Bundled plugin
  - H2: Quick setup
  - H2: What it is
  - H2: How it works
  - H2: Limits
  - H2: Access control
  - H3: Direct messages
  - H3: Groups
  - H2: Long-polling vs webhook
  - H2: Supported message types
  - H2: Capabilities
  - H2: Delivery targets (CLI/cron)
  - H2: Troubleshooting
  - H2: Configuration reference
  - H2: Related

## channels/zaloclawbot.md

- Route: /channels/zaloclawbot
- Headings:
  - H2: Compatibility
  - H2: Prerequisites
  - H2: Install with onboard (recommended)
  - H2: Manual installation
  - H3: 1. Install the plugin
  - H3: 2. Enable the plugin in config
  - H3: 3. Generate a QR code and log in
  - H3: 4. Restart the gateway
  - H2: How it works
  - H2: Under the hood
  - H2: Troubleshooting
  - H2: Related

## channels/zalouser.md

- Route: /channels/zalouser
- Headings:
  - H2: Install
  - H2: Quick setup
  - H2: What it is
  - H2: Naming
  - H2: Finding IDs (directory)
  - H2: Limits
  - H2: Access control (DMs)
  - H2: Group access (optional)
  - H3: Group mention gating
  - H2: Multi-account
  - H2: Environment variables
  - H2: Typing, reactions, and delivery acknowledgements
  - H2: Troubleshooting
  - H2: Related

## ci.md

- Route: /ci
- Headings:
  - H2: Pipeline overview
  - H2: Fail-fast order
  - H2: PR context and evidence
  - H2: Scope and routing
  - H2: ClawSweeper activity forwarding
  - H2: Manual dispatches
  - H2: Runners
  - H2: Runner registration budget
  - H2: Local equivalents
  - H2: OpenClaw Performance
  - H2: Full Release Validation
  - H2: Live and E2E shards
  - H2: Package Acceptance
  - H3: Jobs
  - H3: Candidate sources
  - H3: Suite profiles
  - H3: Legacy compatibility windows
  - H3: Examples
  - H2: Install smoke
  - H2: Local Docker E2E
  - H3: Tunables
  - H3: Reusable live/E2E workflow
  - H3: Release-path chunks
  - H2: Plugin Prerelease
  - H2: QA Lab
  - H2: CodeQL
  - H3: Security categories
  - H3: Platform-specific security shards
  - H3: Critical Quality categories
  - H2: Maintenance workflows
  - H3: Docs Agent
  - H3: Test Performance Agent
  - H3: Duplicate PRs After Merge
  - H2: Local check gates and changed routing
  - H2: Testbox validation
  - H2: Related

## clawhub/cli.md

- Route: /clawhub/cli
- Headings:
  - H1: ClawHub CLI
  - H2: Discover and install
  - H3: Release trust
  - H2: Publish and maintain
  - H2: Related

## clawhub/publishing.md

- Route: /clawhub/publishing
- Headings:
  - H1: Publishing on ClawHub
  - H2: Owners
  - H2: Skills
  - H2: Plugins
  - H2: Release flow
  - H2: FAQ
  - H3: Package scope must match selected owner

## cli/acp.md

- Route: /cli/acp
- Headings:
  - H2: What this is not
  - H2: Compatibility matrix
  - H2: Known limitations
  - H2: Usage
  - H2: ACP client (debug)
  - H2: Protocol smoke testing
  - H2: How to use this
  - H2: Selecting agents
  - H2: Use from acpx (Codex, Claude, other ACP clients)
  - H2: Zed editor setup
  - H2: Session mapping
  - H2: Options
  - H3: acp client options
  - H2: Related

## cli/agent.md

- Route: /cli/agent
- Headings:
  - H1: openclaw agent
  - H2: Options
  - H2: Examples
  - H2: Notes
  - H2: JSON delivery status
  - H2: Related

## cli/agents.md

- Route: /cli/agents
- Headings:
  - H1: openclaw agents
  - H2: Examples
  - H2: Command surface
  - H3: agents list
  - H3: agents add [name]
  - H3: agents bindings
  - H3: agents bind
  - H3: agents unbind
  - H3: agents set-identity
  - H3: agents delete &lt;id&gt;
  - H2: Routing bindings
  - H3: --bind format
  - H3: Binding scope behavior
  - H2: Identity files
  - H2: Set identity
  - H2: Related

## cli/approvals.md

- Route: /cli/approvals
- Headings:
  - H1: openclaw approvals
  - H2: openclaw exec-policy
  - H2: Common commands
  - H2: Replace approvals from a file
  - H2: "Never prompt" / YOLO example
  - H2: Allowlist helpers
  - H2: Common options
  - H2: Notes
  - H2: Related

## cli/attach.md

- Route: /cli/attach
- Headings: none

## cli/audit.md

- Route: /cli/audit
- Headings:
  - H1: openclaw audit
  - H2: Filters
  - H2: Recorded events
  - H2: Gateway RPC
  - H2: Related

## cli/backup.md

- Route: /cli/backup
- Headings:
  - H1: openclaw backup
  - H2: Notes
  - H2: What gets backed up
  - H2: Invalid config behavior
  - H2: Size and performance
  - H2: Related

## cli/browser.md

- Route: /cli/browser
- Headings:
  - H1: openclaw browser
  - H2: Common flags
  - H2: Quick start (local)
  - H2: Quick troubleshooting
  - H2: Lifecycle
  - H2: If the command is missing
  - H2: Profiles
  - H2: Tabs
  - H2: Snapshot / screenshot / actions
  - H2: State and storage
  - H2: Debugging
  - H2: Existing Chrome via MCP
  - H2: Remote browser control (node host proxy)
  - H2: Related

## cli/channels.md

- Route: /cli/channels
- Headings:
  - H1: openclaw channels
  - H2: Common commands
  - H2: Status / capabilities / resolve / logs
  - H2: Add / remove accounts
  - H2: Login and logout (interactive)
  - H2: Troubleshooting
  - H2: Capabilities probe
  - H2: Resolve names to IDs
  - H2: Related

## cli/clawbot.md

- Route: /cli/clawbot
- Headings:
  - H1: openclaw clawbot
  - H2: Migration
  - H2: Related

## cli/commitments.md

- Route: /cli/commitments
- Headings:
  - H2: Usage
  - H2: Options
  - H2: Examples
  - H2: Output
  - H2: Related

## cli/completion.md

- Route: /cli/completion
- Headings:
  - H1: openclaw completion
  - H2: Usage
  - H2: Options
  - H2: Install flow
  - H2: Notes
  - H2: Related

## cli/config.md

- Route: /cli/config
- Headings:
  - H2: Root options
  - H2: Examples
  - H3: Paths
  - H3: config get
  - H3: config file
  - H3: config schema
  - H3: config validate
  - H2: Values
  - H2: config set modes
  - H3: Provider builder flags
  - H2: config patch
  - H2: Dry run
  - H3: JSON output shape
  - H2: Applying changes
  - H2: Write safety
  - H2: Repair loop
  - H2: Related

## cli/configure.md

- Route: /cli/configure
- Headings:
  - H1: openclaw configure
  - H2: Options
  - H2: Model section
  - H2: Web section
  - H2: Other notes
  - H2: Related

## cli/crestodian.md

- Route: /cli/crestodian
- Headings:
  - H1: openclaw crestodian
  - H2: When it starts
  - H2: What Crestodian shows
  - H2: Examples
  - H2: Operations and approval
  - H2: Setup bootstrap
  - H2: AI conversation
  - H3: CLI harness trust model
  - H2: Switching to an agent
  - H2: Message rescue mode
  - H2: Related

## cli/cron.md

- Route: /cli/cron
- Headings:
  - H1: openclaw cron
  - H2: Create jobs quickly
  - H2: Sessions
  - H2: Delivery
  - H3: Delivery ownership
  - H3: Failure delivery
  - H2: Scheduling
  - H3: One-shot jobs
  - H3: Recurring jobs
  - H3: Manual runs
  - H2: Models
  - H3: Isolated cron model precedence
  - H3: Fast mode
  - H3: Live model switch retries
  - H2: Run output and denials
  - H3: Stale acknowledgement suppression
  - H3: Silent token suppression
  - H3: Structured denials
  - H2: Retention
  - H2: Migrating older jobs
  - H2: Common edits
  - H2: Common admin commands
  - H2: Related

## cli/daemon.md

- Route: /cli/daemon
- Headings:
  - H1: openclaw daemon
  - H2: Usage
  - H2: Subcommands and options
  - H2: Notes
  - H2: Related

## cli/dashboard.md

- Route: /cli/dashboard
- Headings:
  - H1: openclaw dashboard
  - H2: Related

## cli/devices.md

- Route: /cli/devices
- Headings:
  - H1: openclaw devices
  - H2: Common options
  - H2: Commands
  - H3: openclaw devices list
  - H3: openclaw devices approve [requestId] [--latest]
  - H3: openclaw devices reject &lt;requestId&gt;
  - H3: openclaw devices remove &lt;deviceId&gt;
  - H3: openclaw devices clear --yes [--pending]
  - H3: openclaw devices rotate --device &lt;id&gt; --role &lt;role&gt; [--scope &lt;scope...&gt;]
  - H3: openclaw devices revoke --device &lt;id&gt; --role &lt;role&gt;
  - H2: Notes
  - H2: Token drift recovery checklist
  - H2: Paperclip / openclawgateway first-run approval
  - H2: Related

## cli/directory.md

- Route: /cli/directory
- Headings:
  - H1: openclaw directory
  - H2: Common flags
  - H2: Notes
  - H2: Using results with message send
  - H2: ID formats by channel
  - H2: Self ("me")
  - H2: Peers (contacts/users)
  - H2: Groups
  - H2: Related

## cli/dns.md

- Route: /cli/dns
- Headings:
  - H1: openclaw dns
  - H2: dns setup
  - H2: Related

## cli/docs.md

- Route: /cli/docs
- Headings:
  - H1: openclaw docs
  - H2: Usage
  - H2: Examples
  - H2: How it works
  - H2: Output
  - H2: Exit codes
  - H2: Related

## cli/doctor.md

- Route: /cli/doctor
- Headings:
  - H1: openclaw doctor
  - H2: Postures
  - H2: Examples
  - H2: Options
  - H2: Lint mode
  - H2: Structured health checks
  - H2: Check selection
  - H2: Post-upgrade mode
  - H2: Notes
  - H2: macOS: launchctl env overrides
  - H2: Related

## cli/flows.md

- Route: /cli/flows
- Headings:
  - H1: openclaw tasks flow
  - H2: Subcommands
  - H3: Status filter values
  - H2: Examples
  - H2: Related

## cli/gateway.md

- Route: /cli/gateway
- Headings:
  - H2: Run the Gateway
  - H3: Options
  - H2: Restart the Gateway
  - H3: Gateway profiling
  - H2: Query a running Gateway
  - H3: gateway health
  - H3: gateway usage-cost
  - H3: gateway stability
  - H3: gateway diagnostics export
  - H3: gateway status
  - H3: gateway probe
  - H4: Remote over SSH (Mac app parity)
  - H3: gateway call &lt;method&gt;
  - H2: Manage the Gateway service
  - H3: Install with a wrapper
  - H2: Discover gateways (Bonjour)
  - H3: gateway discover
  - H2: Related

## cli/health.md

- Route: /cli/health
- Headings:
  - H1: openclaw health
  - H2: Options
  - H2: Behavior
  - H2: Related

## cli/hooks.md

- Route: /cli/hooks
- Headings:
  - H1: openclaw hooks
  - H2: List hooks
  - H2: Get hook info
  - H2: Check eligibility
  - H2: Enable a hook
  - H2: Disable a hook
  - H2: Install and update hook packs
  - H2: Bundled hooks
  - H3: command-logger log file
  - H2: Notes
  - H2: Related

## cli/index.md

- Route: /cli
- Headings:
  - H2: Command pages
  - H2: Global flags
  - H2: Output modes
  - H2: Color palette
  - H2: Command tree
  - H2: Chat slash commands
  - H2: Usage tracking
  - H2: Related

## cli/infer.md

- Route: /cli/infer
- Headings:
  - H2: Turn infer into a skill
  - H2: Command tree
  - H2: Common tasks
  - H2: Behavior
  - H2: Model
  - H2: Image
  - H2: Audio
  - H2: TTS
  - H2: Video
  - H2: Web
  - H2: Embedding
  - H2: JSON output
  - H2: Common pitfalls
  - H2: Related

## cli/logs.md

- Route: /cli/logs
- Headings:
  - H1: openclaw logs
  - H2: Options
  - H2: Shared Gateway RPC options
  - H2: Examples
  - H2: Fallback and recovery behavior
  - H2: Related

## cli/mcp.md

- Route: /cli/mcp
- Headings:
  - H2: Choose the right MCP path
  - H2: OpenClaw as an MCP server
  - H3: When to use serve
  - H3: How it works
  - H3: Choose a client mode
  - H3: What serve exposes
  - H3: Usage
  - H3: Bridge tools
  - H3: Event model
  - H3: Claude channel notifications
  - H3: MCP client config
  - H3: Options
  - H3: Security and trust boundary
  - H3: Testing
  - H3: Troubleshooting
  - H2: OpenClaw as an MCP client registry
  - H3: Saved MCP server definitions
  - H3: Common server recipes
  - H3: JSON output shapes
  - H3: Stdio transport
  - H3: SSE / HTTP transport
  - H3: OAuth workflow
  - H3: Streamable HTTP transport
  - H2: Control UI
  - H2: Current limits
  - H2: Related

## cli/memory.md

- Route: /cli/memory
- Headings:
  - H1: openclaw memory
  - H2: memory status
  - H2: memory index
  - H2: memory search
  - H2: memory promote
  - H2: memory promote-explain
  - H2: memory rem-harness
  - H2: memory rem-backfill
  - H2: Dreaming
  - H2: SecretRef gateway dependency
  - H2: Related

## cli/message.md

- Route: /cli/message
- Headings:
  - H1: openclaw message
  - H2: Channel selection
  - H2: Target formats (-t, --target)
  - H2: Common flags
  - H2: SecretRef resolution
  - H2: Actions
  - H3: Core
  - H3: Send
  - H3: Poll
  - H3: Threads
  - H3: Emojis
  - H3: Stickers
  - H3: Roles, channels, voice, events (Discord)
  - H3: Moderation (Discord)
  - H3: Broadcast
  - H2: Related

## cli/migrate.md

- Route: /cli/migrate
- Headings:
  - H1: openclaw migrate
  - H2: Commands
  - H2: Safety model
  - H2: Claude provider
  - H3: What Claude imports
  - H3: Archive and manual-review state
  - H2: Codex provider
  - H3: What Codex imports
  - H3: Manual-review Codex state
  - H2: Hermes provider
  - H3: What Hermes imports
  - H3: Supported .env keys
  - H3: Archive-only state
  - H3: After applying
  - H2: Plugin contract
  - H2: Onboarding integration
  - H2: Related

## cli/models.md

- Route: /cli/models
- Headings:
  - H1: openclaw models
  - H2: Common commands
  - H3: Status
  - H3: List
  - H3: Set default / image model
  - H3: Scan
  - H2: Aliases
  - H2: Fallbacks
  - H2: Auth profiles
  - H2: Related

## cli/node.md

- Route: /cli/node
- Headings:
  - H1: openclaw node
  - H2: Why use a node host?
  - H2: Browser proxy (zero-config)
  - H2: Run (foreground)
  - H2: Gateway auth for node host
  - H2: Service (background)
  - H2: Pairing
  - H2: Exec approvals
  - H2: Related

## cli/nodes.md

- Route: /cli/nodes
- Headings:
  - H1: openclaw nodes
  - H2: Status
  - H2: Pairing
  - H2: Invoke
  - H2: Notify, push, location, screen
  - H2: Related

## cli/onboard.md

- Route: /cli/onboard
- Headings:
  - H1: openclaw onboard
  - H2: Examples
  - H2: Reset
  - H2: Locale
  - H2: Non-interactive setup
  - H3: Gateway auth (non-interactive)
  - H3: Local gateway health
  - H3: Interactive ref mode
  - H3: Z.AI endpoint choices
  - H2: Additional non-interactive flags
  - H2: Provider prefiltering
  - H2: Web-search follow-ups
  - H2: Other behaviors
  - H2: Common follow-up commands

## cli/pairing.md

- Route: /cli/pairing
- Headings:
  - H1: openclaw pairing
  - H2: Commands
  - H2: pairing list
  - H2: pairing approve
  - H3: Owner bootstrap
  - H2: Related

## cli/path.md

- Route: /cli/path
- Headings:
  - H1: openclaw path
  - H2: Why use it
  - H2: How it is used
  - H2: How it works
  - H2: Subcommands
  - H2: Global flags
  - H2: oc:// syntax
  - H2: Addressing by file kind
  - H2: Mutation contract
  - H2: Examples
  - H2: Recipes by file kind
  - H3: Markdown
  - H3: JSONC
  - H3: JSONL
  - H3: YAML
  - H2: Subcommand reference
  - H3: resolve &lt;oc-path&gt;
  - H3: find &lt;pattern&gt;
  - H3: set &lt;oc-path&gt; &lt;value&gt;
  - H3: validate &lt;oc-path&gt;
  - H3: emit &lt;file&gt;
  - H2: Exit codes
  - H2: Output mode
  - H2: Notes
  - H2: Related

## cli/plugins.md

- Route: /cli/plugins
- Headings:
  - H2: Commands
  - H2: Author
  - H3: Provider scaffold
  - H2: Install
  - H3: Marketplace shorthand
  - H2: List
  - H3: Plugin index
  - H2: Uninstall
  - H2: Update
  - H2: Inspect
  - H2: Doctor
  - H2: Registry
  - H2: Marketplace
  - H2: Related

## cli/policy.md

- Route: /cli/policy
- Headings:
  - H1: openclaw policy
  - H2: Quick start
  - H3: Policy rule reference
  - H4: Scoped overlays
  - H4: Channels
  - H4: MCP servers
  - H4: Model providers
  - H4: Network
  - H4: Ingress and channel access
  - H4: Gateway
  - H4: Agent workspace
  - H4: Sandbox posture
  - H4: Data Handling
  - H4: Secrets
  - H4: Exec approvals
  - H4: Auth profiles
  - H4: Tool metadata
  - H4: Tool posture
  - H2: Run checks
  - H2: Configure policy
  - H2: Accept policy state
  - H2: Findings
  - H2: Repair
  - H2: Exit codes
  - H2: Related

## cli/proxy.md

- Route: /cli/proxy
- Headings:
  - H1: openclaw proxy
  - H2: Validate
  - H3: Options
  - H2: Debug proxy
  - H2: Related

## cli/qr.md

- Route: /cli/qr
- Headings:
  - H1: openclaw qr
  - H2: Options
  - H2: Setup code contents
  - H2: Gateway URL resolution
  - H2: Auth resolution (no --remote)
  - H2: Auth resolution (--remote)
  - H2: Related

## cli/reset.md

- Route: /cli/reset
- Headings:
  - H1: openclaw reset
  - H2: Options
  - H2: Scopes
  - H2: Notes
  - H2: Related

## cli/sandbox.md

- Route: /cli/sandbox
- Headings:
  - H2: Commands
  - H3: openclaw sandbox list
  - H3: openclaw sandbox recreate
  - H3: openclaw sandbox explain
  - H2: Why recreate is needed
  - H2: Common triggers
  - H2: Registry migration
  - H2: Configuration
  - H2: Related

## cli/secrets.md

- Route: /cli/secrets
- Headings:
  - H1: openclaw secrets
  - H2: Reload runtime snapshot
  - H2: Audit
  - H2: Configure (interactive helper)
  - H3: Exec provider safety
  - H2: Apply a saved plan
  - H3: Why no rollback backups
  - H2: Example
  - H2: Related

## cli/security.md

- Route: /cli/security
- Headings:
  - H1: openclaw security
  - H2: Audit modes
  - H2: What it checks
  - H2: SecretRef behavior
  - H2: Suppressions
  - H2: JSON output
  - H2: What --fix changes
  - H2: Related

## cli/sessions.md

- Route: /cli/sessions
- Headings:
  - H1: openclaw sessions
  - H2: Tail trajectory progress
  - H2: Export a trajectory bundle
  - H2: Cleanup maintenance
  - H2: Compact a session
  - H3: sessions.compact RPC
  - H2: Related

## cli/setup.md

- Route: /cli/setup
- Headings:
  - H1: openclaw setup
  - H2: Options
  - H3: Baseline mode
  - H2: Examples
  - H2: Notes
  - H2: Related

## cli/skills.md

- Route: /cli/skills
- Headings:
  - H1: openclaw skills
  - H2: Commands
  - H2: Skill Workshop
  - H2: Related

## cli/status.md

- Route: /cli/status
- Headings:
  - H2: Session and model resolution
  - H2: Usage and quota
  - H2: Overview and update status
  - H2: Secrets
  - H2: Memory
  - H2: Related

## cli/system.md

- Route: /cli/system
- Headings:
  - H1: openclaw system
  - H2: Common commands
  - H2: system event
  - H2: system heartbeat last|enable|disable
  - H2: system presence
  - H2: Notes
  - H2: Related

## cli/tasks.md

- Route: /cli/tasks
- Headings:
  - H2: Usage
  - H2: Root Options
  - H2: Subcommands
  - H3: list
  - H3: show
  - H3: notify
  - H3: cancel
  - H3: audit
  - H3: maintenance
  - H3: flow
  - H2: Related

## cli/transcripts.md

- Route: /cli/transcripts
- Headings:
  - H1: openclaw transcripts
  - H2: Commands
  - H2: Output
  - H2: Many sessions per day
  - H2: Missing summaries
  - H2: Configuration

## cli/tui.md

- Route: /cli/tui
- Headings:
  - H1: openclaw tui
  - H2: Options
  - H2: Notes
  - H2: Examples
  - H2: Config repair loop
  - H2: Related

## cli/uninstall.md

- Route: /cli/uninstall
- Headings:
  - H1: openclaw uninstall
  - H2: Options
  - H2: Examples
  - H2: Notes
  - H2: Related

## cli/update.md

- Route: /cli/update
- Headings:
  - H1: openclaw update
  - H2: Usage
  - H2: Options
  - H2: update status
  - H2: update repair
  - H2: update wizard
  - H2: What it does
  - H3: Restart handoff
  - H3: Control-plane response shape
  - H2: Git checkout flow
  - H3: Channel selection
  - H3: Update steps
  - H3: Plugin sync details
  - H2: Related

## cli/voicecall.md

- Route: /cli/voicecall
- Headings:
  - H1: openclaw voicecall
  - H2: Subcommands
  - H2: Setup and smoke
  - H3: setup
  - H3: smoke
  - H2: Call lifecycle
  - H3: call
  - H3: start
  - H3: continue
  - H3: speak
  - H3: dtmf
  - H3: end
  - H3: status
  - H2: Logs and metrics
  - H3: tail
  - H3: latency
  - H2: Exposing webhooks
  - H3: expose
  - H2: Related

## cli/webhooks.md

- Route: /cli/webhooks
- Headings:
  - H1: openclaw webhooks
  - H2: Subcommands
  - H2: webhooks gmail setup
  - H3: Required
  - H3: Pub/Sub options
  - H3: OpenClaw delivery options
  - H3: gog watch serve options
  - H3: Tailscale exposure
  - H3: Output
  - H2: webhooks gmail run
  - H2: Related

## cli/wiki.md

- Route: /cli/wiki
- Headings:
  - H1: openclaw wiki
  - H2: Common commands
  - H2: Commands
  - H3: wiki status
  - H3: wiki doctor
  - H3: wiki init
  - H3: wiki ingest &lt;path&gt;
  - H3: wiki okf import &lt;path&gt;
  - H3: wiki compile
  - H3: wiki lint
  - H3: wiki search &lt;query&gt;
  - H3: wiki get &lt;lookup&gt;
  - H3: wiki apply
  - H3: wiki bridge import
  - H3: wiki unsafe-local import
  - H3: wiki chatgpt import
  - H3: wiki chatgpt rollback &lt;run-id&gt;
  - H3: wiki obsidian ...
  - H2: Practical usage guidance
  - H2: Configuration tie-ins
  - H2: Related

## cli/workboard.md

- Route: /cli/workboard
- Headings:
  - H2: Usage
  - H2: list
  - H2: create
  - H2: show
  - H2: dispatch
  - H2: Slash command parity
  - H2: Permissions
  - H2: Troubleshooting
  - H3: No cards appear
  - H3: Dispatch says data-only
  - H3: Dispatch starts nothing
  - H2: Related

## concepts/active-memory.md

- Route: /concepts/active-memory
- Headings:
  - H2: Quick start
  - H2: How it works
  - H2: When it runs
  - H3: Session types
  - H2: Session toggle
  - H2: How to see it
  - H2: Query modes
  - H2: Prompt styles
  - H2: Model fallback policy
  - H3: Speed recommendations
  - H4: Cerebras setup
  - H2: Memory tools
  - H3: Built-in memory-core
  - H3: LanceDB memory
  - H3: Lossless Claw
  - H2: Advanced escape hatches
  - H2: Transcript persistence
  - H2: Configuration
  - H2: Recommended setup
  - H3: Cold-start grace
  - H2: Debugging
  - H2: Common issues
  - H2: Related pages

## concepts/agent-loop.md

- Route: /concepts/agent-loop
- Headings:
  - H2: Entry points
  - H2: Run sequence
  - H2: Queueing and concurrency
  - H2: Session and workspace preparation
  - H2: Prompt assembly
  - H2: Hooks
  - H3: Internal hooks (Gateway hooks)
  - H3: Plugin hooks
  - H2: Streaming
  - H2: Tool execution
  - H2: Reply shaping
  - H2: Compaction and retries
  - H2: Event streams
  - H2: Chat channel handling
  - H2: Timeouts
  - H3: Stuck session diagnostics
  - H2: Where things can end early
  - H2: Related

## concepts/agent-runtimes.md

- Route: /concepts/agent-runtimes
- Headings:
  - H2: Codex surfaces
  - H2: Runtime ownership
  - H2: Runtime selection
  - H2: GitHub Copilot agent runtime
  - H2: Compatibility contract
  - H2: Status labels
  - H2: Related

## concepts/agent-workspace.md

- Route: /concepts/agent-workspace
- Headings:
  - H2: Default location
  - H2: Extra workspace folders
  - H2: Workspace file map
  - H2: What is NOT in the workspace
  - H2: Git backup (recommended, private)
  - H2: Do not commit secrets
  - H2: Moving the workspace to a new machine
  - H2: Advanced notes
  - H2: Related

## concepts/agent.md

- Route: /concepts/agent
- Headings:
  - H2: Workspace (required)
  - H2: Bootstrap files (injected)
  - H2: Built-in tools
  - H2: Skills
  - H2: Runtime boundaries
  - H2: Sessions
  - H2: Steering while streaming
  - H2: Model refs
  - H2: Configuration (minimal)
  - H2: Related

## concepts/architecture.md

- Route: /concepts/architecture
- Headings:
  - H2: Overview
  - H2: Components and flows
  - H3: Gateway (daemon)
  - H3: Clients (mac app / CLI / web admin)
  - H3: Nodes (macOS / iOS / Android / headless)
  - H3: WebChat
  - H2: Connection lifecycle (single client)
  - H2: Wire protocol (summary)
  - H2: Pairing and local trust
  - H2: Protocol typing and codegen
  - H2: Remote access
  - H2: Operations snapshot
  - H2: Invariants
  - H2: Related

## concepts/channel-docking.md

- Route: /concepts/channel-docking
- Headings:
  - H2: Example
  - H2: Why use it
  - H2: Required config
  - H2: Commands
  - H2: What changes
  - H2: What does not change
  - H2: Troubleshooting

## concepts/commitments.md

- Route: /concepts/commitments
- Headings:
  - H2: Enable commitments
  - H2: How it works
  - H2: Scope
  - H2: Commitments vs reminders
  - H2: Manage commitments
  - H2: Privacy and cost
  - H2: Troubleshooting
  - H2: Related

## concepts/compaction.md

- Route: /concepts/compaction
- Headings:
  - H2: How it works
  - H2: Auto-compaction
  - H2: Manual compaction
  - H2: Configuration
  - H3: Using a different model
  - H3: Identifier preservation
  - H3: Active transcript byte guard
  - H3: Successor transcripts
  - H3: Compaction notices
  - H3: Memory flush
  - H2: Pluggable compaction providers
  - H2: Compaction vs pruning
  - H2: Troubleshooting
  - H2: Related

## concepts/context-engine.md

- Route: /concepts/context-engine
- Headings:
  - H2: Quick start
  - H2: How it works
  - H3: Subagent lifecycle (optional)
  - H3: System prompt addition
  - H2: The legacy engine
  - H2: Plugin engines
  - H3: The ContextEngine interface
  - H3: Runtime settings
  - H3: Host requirements
  - H3: Failure isolation
  - H3: ownsCompaction
  - H2: Configuration reference
  - H2: Relationship to compaction and memory
  - H2: Tips
  - H2: Related

## concepts/context.md

- Route: /concepts/context
- Headings:
  - H2: Quick start (inspect context)
  - H2: Example output
  - H3: /context list
  - H3: /context detail
  - H3: /context map
  - H2: What counts toward the context window
  - H2: How OpenClaw builds the system prompt
  - H2: Injected workspace files (Project Context)
  - H2: Skills: injected vs loaded on-demand
  - H2: Tools: there are two costs
  - H2: Commands, directives, and "inline shortcuts"
  - H2: Sessions, compaction, and pruning (what persists)
  - H2: What /context actually reports
  - H2: Related

## concepts/delegate-architecture.md

- Route: /concepts/delegate-architecture
- Headings:
  - H2: What is a delegate
  - H2: Why delegates
  - H2: Capability tiers
  - H3: Tier 1: Read-Only + Draft
  - H3: Tier 2: Send on Behalf
  - H3: Tier 3: Proactive
  - H2: Prerequisites: isolation and hardening
  - H3: Hard blocks (non-negotiable)
  - H3: Tool restrictions
  - H3: Sandbox isolation
  - H3: Audit trail
  - H2: Setting up a delegate
  - H3: 1. Create the delegate agent
  - H3: 2. Configure identity provider delegation
  - H4: Microsoft 365
  - H4: Google Workspace
  - H3: 3. Bind the delegate to channels
  - H3: 4. Add credentials to the delegate agent
  - H2: Example: organizational assistant
  - H2: Scaling pattern
  - H2: Related

## concepts/dreaming.md

- Route: /concepts/dreaming
- Headings:
  - H2: What dreaming writes
  - H2: Phase model
  - H2: Session transcript ingestion
  - H2: Dream Diary
  - H2: Deep ranking signals
  - H3: QA shadow trial report coverage
  - H2: Scheduling
  - H2: Quick start
  - H2: Slash command
  - H2: CLI workflow
  - H2: Key defaults
  - H2: Dreams UI
  - H2: Related

## concepts/experimental-features.md

- Route: /concepts/experimental-features
- Headings:
  - H2: Currently documented flags
  - H2: Local model lean mode
  - H3: Why these tools
  - H3: When to turn it on
  - H3: When to leave it off
  - H3: Enable
  - H2: Experimental does not mean hidden
  - H2: Related

## concepts/features.md

- Route: /concepts/features
- Headings:
  - H2: Highlights
  - H2: Full list
  - H2: Related

## concepts/managed-worktrees.md

- Route: /concepts/managed-worktrees
- Headings:
  - H2: Layout and names
  - H2: Provision ignored files
  - H2: Run repository setup
  - H2: Session worktrees
  - H2: Snapshots, cleanup, and restore
  - H2: CLI
  - H2: Gateway methods
  - H2: Workboard workspaces

## concepts/mantis-slack-desktop-runbook.md

- Route: /concepts/mantis-slack-desktop-runbook
- Headings:
  - H2: Storage model
  - H2: GitHub dispatch
  - H2: Local CLI
  - H2: Hydrate modes
  - H2: Timing interpretation
  - H2: Evidence checklist
  - H2: Failure handling
  - H2: Related

## concepts/mantis.md

- Route: /concepts/mantis
- Headings:
  - H2: Ownership
  - H2: CLI commands
  - H3: discord-smoke
  - H3: run
  - H3: desktop-browser-smoke
  - H3: slack-desktop-smoke
  - H3: telegram-desktop-builder
  - H2: Evidence manifest
  - H2: GitHub automation
  - H2: Machines and secrets
  - H2: Run outcomes
  - H2: Adding a scenario
  - H2: Open questions

## concepts/markdown-formatting.md

- Route: /concepts/markdown-formatting
- Headings:
  - H2: Pipeline
  - H2: IR example
  - H2: Table handling
  - H2: Chunking rules
  - H2: Link policy
  - H2: Spoilers
  - H2: Adding or updating a channel formatter
  - H2: Common gotchas
  - H2: Related

## concepts/memory-builtin.md

- Route: /concepts/memory-builtin
- Headings:
  - H2: What it provides
  - H2: Getting started
  - H2: Supported embedding providers
  - H2: How indexing works
  - H2: When to use
  - H2: Troubleshooting
  - H2: Configuration
  - H2: Related

## concepts/memory-honcho.md

- Route: /concepts/memory-honcho
- Headings:
  - H2: What it provides
  - H2: Available tools
  - H2: Getting started
  - H2: Configuration
  - H2: Migrating existing memory
  - H2: How it works
  - H2: Honcho vs builtin memory
  - H2: CLI commands
  - H2: Further reading
  - H2: Related

## concepts/memory-qmd.md

- Route: /concepts/memory-qmd
- Headings:
  - H2: What it adds over builtin
  - H2: Getting started
  - H3: Prerequisites
  - H3: Enable
  - H2: How the sidecar works
  - H2: Search performance and compatibility
  - H2: Model overrides
  - H2: Indexing extra paths
  - H2: Indexing session transcripts
  - H2: Search scope
  - H2: Citations
  - H2: When to use
  - H2: Troubleshooting
  - H2: Configuration
  - H2: Related

## concepts/memory-search.md

- Route: /concepts/memory-search
- Headings:
  - H2: Quick start
  - H2: Supported providers
  - H2: How search works
  - H2: Improving search quality
  - H3: Temporal decay
  - H3: MMR (diversity)
  - H3: Enable both
  - H2: Multimodal memory
  - H2: Session memory search
  - H2: Troubleshooting
  - H2: Related

## concepts/memory.md

- Route: /concepts/memory
- Headings:
  - H2: How it works
  - H2: What goes where
  - H2: Action-sensitive memories
  - H2: Inferred commitments
  - H2: Memory tools
  - H2: Memory search
  - H2: Memory backends
  - H2: Knowledge wiki layer
  - H2: Automatic memory flush
  - H2: Dreaming
  - H2: Grounded backfill and live promotion
  - H2: CLI
  - H2: Further reading

## concepts/message-lifecycle-refactor.md

- Route: /concepts/message-lifecycle-refactor
- Headings:
  - H2: Why this refactor happened
  - H2: What shipped
  - H3: Send context
  - H3: Receive context
  - H3: Live preview
  - H3: Durable receipts
  - H3: Public SDK reduction
  - H2: Where the implementation diverged from the original design
  - H2: Concrete migration hazards (still relevant)
  - H2: Failure classification
  - H2: Open questions
  - H2: Related

## concepts/messages.md

- Route: /concepts/messages
- Headings:
  - H2: Inbound dedupe
  - H2: Inbound debouncing
  - H2: Sessions and devices
  - H2: Prompt bodies and history context
  - H2: Tool result metadata
  - H2: Queueing and followups
  - H2: Channel run ownership
  - H2: Streaming, chunking, and batching
  - H2: Reasoning visibility and tokens
  - H2: Prefixes, threading, and replies
  - H2: Silent replies
  - H2: Related

## concepts/model-failover.md

- Route: /concepts/model-failover
- Headings:
  - H2: Runtime flow
  - H2: Selection source policy
  - H2: Auth failure skip cache
  - H2: User-visible fallback notices
  - H2: Auth storage (keys + OAuth)
  - H2: Profile IDs
  - H2: Rotation order
  - H3: Session stickiness (cache-friendly)
  - H3: OpenAI Codex subscription plus API-key backup
  - H2: Cooldowns
  - H2: Billing disables
  - H2: Model fallback
  - H3: Candidate chain rules
  - H3: Which errors advance fallback
  - H3: Cooldown skip vs probe behavior
  - H2: Session overrides and live model switching
  - H2: Observability and failure summaries
  - H2: Related config

## concepts/model-providers.md

- Route: /concepts/model-providers
- Headings:
  - H2: Quick rules
  - H2: Plugin-owned provider behavior
  - H2: API key rotation
  - H2: Official provider plugins
  - H3: OpenAI
  - H3: Anthropic
  - H3: OpenAI ChatGPT/Codex OAuth
  - H3: Other subscription-style hosted options
  - H3: OpenCode
  - H3: Google Gemini (API key)
  - H3: Google Vertex and Gemini CLI
  - H3: Z.AI (GLM)
  - H3: Vercel AI Gateway
  - H3: Other bundled provider plugins
  - H4: Quirks worth knowing
  - H2: Providers via models.providers (custom/base URL)
  - H3: Moonshot AI (Kimi)
  - H3: Kimi Coding
  - H3: Volcano Engine (Doubao)
  - H3: BytePlus (International)
  - H3: Synthetic
  - H3: MiniMax
  - H3: LM Studio
  - H3: Ollama
  - H3: vLLM
  - H3: SGLang
  - H3: Local proxies (LM Studio, vLLM, LiteLLM, etc.)
  - H2: CLI examples
  - H2: Related

## concepts/models.md

- Route: /concepts/models
- Headings:
  - H2: Selection order
  - H2: Selection source and fallback strictness
  - H2: Quick model policy
  - H2: Onboarding
  - H2: "Model is not allowed" (and why replies stop)
  - H2: /model in chat
  - H2: CLI
  - H2: Models registry (models.json)
  - H2: Related

## concepts/multi-agent.md

- Route: /concepts/multi-agent
- Headings:
  - H2: What is one agent
  - H2: Paths
  - H3: Single-agent mode (default)
  - H2: Agent helper
  - H2: Quick start
  - H2: Multiple agents, multiple personas
  - H2: Cross-agent QMD memory search
  - H2: One WhatsApp number, multiple people (DM split)
  - H2: Routing rules
  - H2: Multiple accounts / phone numbers
  - H2: Concepts
  - H2: Platform examples
  - H2: Common patterns
  - H2: Per-agent sandbox and tool configuration
  - H2: Related

## concepts/oauth.md

- Route: /concepts/oauth
- Headings:
  - H2: The token sink (why it exists)
  - H2: Storage (where tokens live)
  - H2: Anthropic Claude CLI reuse
  - H2: OAuth exchange (how login works)
  - H3: Anthropic setup-token
  - H3: OpenAI Codex (ChatGPT OAuth)
  - H2: Refresh + expiry
  - H2: Multiple accounts (profiles) + routing
  - H3: 1) Preferred: separate agents
  - H3: 2) Advanced: multiple profiles in one agent
  - H2: Related

## concepts/parallel-specialist-lanes.md

- Route: /concepts/parallel-specialist-lanes
- Headings:
  - H2: First principles
  - H2: Recommended rollout
  - H3: Phase 1: lane contracts + background heavy work
  - H3: Phase 2: priority and concurrency controls
  - H3: Phase 3: coordinator / traffic controller
  - H2: Minimal lane contract template
  - H2: Related

## concepts/personal-agent-benchmark-pack.md

- Route: /concepts/personal-agent-benchmark-pack
- Headings:
  - H2: Scenarios
  - H2: Privacy Model
  - H2: Extending the pack

## concepts/presence.md

- Route: /concepts/presence
- Headings:
  - H2: Presence fields (what shows up)
  - H2: Producers (where presence comes from)
  - H3: 1) Gateway self entry
  - H3: 2) WebSocket connect
  - H4: Why one-off CLI commands do not show up
  - H3: 3) system-event beacons
  - H3: 4) Node connects (role: node)
  - H2: Merge + dedupe rules (why instanceId matters)
  - H2: TTL and bounded size
  - H2: Remote/tunnel caveat (loopback IPs)
  - H2: Consumers
  - H3: macOS Instances tab
  - H2: Debugging tips
  - H2: Related

## concepts/progress-drafts.md

- Route: /concepts/progress-drafts
- Headings:
  - H2: Quick start
  - H2: What users see
  - H2: Choose a mode
  - H2: Configure labels
  - H2: Control progress lines
  - H3: Detail mode
  - H3: Command/exec text
  - H3: Commentary lane
  - H3: Line limits
  - H3: Rich rendering (Slack)
  - H3: Hide tool/task lines
  - H2: Channel behavior
  - H2: Finalization
  - H2: Troubleshooting
  - H2: Related

## concepts/qa-e2e-automation.md

- Route: /concepts/qa-e2e-automation
- Headings:
  - H2: Command surface
  - H3: Profile-backed qa run
  - H2: Operator flow
  - H3: Observability smokes
  - H3: Matrix smoke lanes
  - H3: Discord Mantis scenarios
  - H3: Mantis Slack desktop and visual-task runners
  - H3: Credential pool health check
  - H2: Live transport coverage
  - H2: Discord, Slack, Telegram, and WhatsApp QA reference
  - H3: Shared CLI flags
  - H3: Telegram QA
  - H3: Discord QA
  - H3: Slack QA
  - H4: Setting up the Slack workspace
  - H3: WhatsApp QA
  - H3: Convex credential pool
  - H2: Repo-backed seeds
  - H2: Provider mock lanes
  - H2: Transport adapters
  - H3: Adding a channel
  - H3: Scenario helper names
  - H2: Reporting
  - H2: Related docs

## concepts/qa-matrix.md

- Route: /concepts/qa-matrix
- Headings:
  - H2: Quick start
  - H2: What the lane does
  - H2: CLI
  - H3: Common flags
  - H3: Provider flags
  - H2: Profiles
  - H2: Scenarios
  - H2: Environment variables
  - H2: Output artifacts
  - H2: Triage tips
  - H2: Live transport contract
  - H2: Related

## concepts/queue-steering.md

- Route: /concepts/queue-steering
- Headings:
  - H2: Runtime boundary
  - H2: Modes
  - H2: Burst example
  - H2: Scope
  - H2: Debounce
  - H2: Related

## concepts/queue.md

- Route: /concepts/queue
- Headings:
  - H2: Why
  - H2: How it works
  - H2: Defaults
  - H2: Queue modes
  - H2: Queue options
  - H2: Steer and streaming
  - H2: Precedence
  - H2: Per-session overrides
  - H2: Queued-turn cancellation
  - H2: Scope and guarantees
  - H2: Troubleshooting
  - H2: Related

## concepts/retry.md

- Route: /concepts/retry
- Headings:
  - H2: Goals
  - H2: Defaults
  - H2: Behavior
  - H3: Model providers
  - H3: Discord
  - H3: Telegram
  - H2: Configuration
  - H2: Notes
  - H2: Related

## concepts/session-pruning.md

- Route: /concepts/session-pruning
- Headings:
  - H2: Why it matters
  - H2: How it works
  - H2: Legacy image cleanup
  - H2: Smart defaults
  - H2: Enable or disable
  - H2: Pruning vs compaction
  - H2: Further reading
  - H2: Related

## concepts/session-tool.md

- Route: /concepts/session-tool
- Headings:
  - H2: Available tools
  - H2: Listing and reading sessions
  - H2: Sending cross-session messages
  - H2: Status and orchestration helpers
  - H2: Spawning sub-agents
  - H2: Visibility
  - H2: Further reading
  - H2: Related

## concepts/session.md

- Route: /concepts/session
- Headings:
  - H2: How messages are routed
  - H2: DM isolation
  - H3: Dock linked channels
  - H2: Session lifecycle
  - H2: Where state lives
  - H2: Session maintenance
  - H2: Inspecting sessions
  - H2: Further reading
  - H2: Related

## concepts/soul.md

- Route: /concepts/soul
- Headings:
  - H2: What belongs in SOUL.md
  - H2: Why this works
  - H2: The Molty prompt
  - H2: What good looks like
  - H2: One warning
  - H2: Related

## concepts/streaming.md

- Route: /concepts/streaming
- Headings:
  - H2: Block streaming (channel messages)
  - H3: Media delivery with block streaming
  - H2: Chunking algorithm (low/high bounds)
  - H2: Coalescing (merge streamed blocks)
  - H2: Human-like pacing between blocks
  - H2: "Stream chunks or everything"
  - H2: Preview streaming modes
  - H3: Channel mapping
  - H3: Legacy key migration
  - H2: Runtime behavior
  - H3: Telegram
  - H3: Discord
  - H3: Slack
  - H3: Mattermost
  - H3: Matrix
  - H2: Tool-progress preview updates
  - H2: Progress draft rendering
  - H3: Commentary progress lane
  - H2: Related

## concepts/system-prompt.md

- Route: /concepts/system-prompt
- Headings:
  - H2: Structure
  - H2: Prompt modes
  - H2: Prompt snapshots
  - H2: Workspace bootstrap injection
  - H2: Time handling
  - H2: Skills
  - H2: Documentation
  - H2: Related

## concepts/timezone.md

- Route: /concepts/timezone
- Headings:
  - H2: Three timezone surfaces
  - H2: Setting the user timezone
  - H2: Envelope timezone values
  - H2: When to override
  - H2: Related

## concepts/typebox.md

- Route: /concepts/typebox
- Headings:
  - H2: Mental model (30 seconds)
  - H2: Where the schemas live
  - H2: Current pipeline
  - H2: How the schemas are used at runtime
  - H2: Example frames
  - H2: Minimal client (Node.js)
  - H2: Worked example: add a method end-to-end
  - H2: Swift codegen behavior
  - H2: Versioning and compatibility
  - H2: Schema patterns and conventions
  - H2: Live schema JSON
  - H2: When you change schemas
  - H2: Related

## concepts/typing-indicators.md

- Route: /concepts/typing-indicators
- Headings:
  - H2: Defaults
  - H2: Modes
  - H2: Configuration
  - H2: Notes
  - H2: Related

## concepts/usage-tracking.md

- Route: /concepts/usage-tracking
- Headings:
  - H2: What it is
  - H2: Where it shows up
  - H2: Anthropic and OpenAI cost history
  - H2: Default usage footer mode
  - H3: Three distinct session states
  - H3: Precedence
  - H3: Resetting vs. turning off
  - H3: Toggle behavior
  - H3: Config
  - H2: Custom /usage full footer
  - H3: Shape
  - H3: Contract Paths
  - H3: Verbs
  - H3: Piece forms
  - H3: Example
  - H2: Providers + credentials
  - H2: Related

## date-time.md

- Route: /date-time
- Headings:
  - H2: Message envelopes (local by default)
  - H3: Examples
  - H2: System prompt: current date and time
  - H2: System event lines (local by default)
  - H3: Configure user timezone + format
  - H2: Time format detection (auto)
  - H2: Tool payloads + connectors (raw provider time + normalized fields)
  - H2: Related docs

## debug/node-issue.md

- Route: /debug/node-issue
- Headings:
  - H1: Node + tsx "\\name is not a function" crash
  - H2: Status
  - H2: Original symptom
  - H2: Cause
  - H2: Current repro check
  - H2: Workarounds (if the crash returns)
  - H2: References
  - H2: Related

## diagnostics/flags.md

- Route: /diagnostics/flags
- Headings:
  - H2: How it works
  - H2: Known flags
  - H2: Enable via config
  - H2: Env override (one-off)
  - H2: Profiler flags
  - H2: Timeline artifacts
  - H2: Where logs go
  - H2: Extract logs
  - H2: Notes
  - H2: Related

## gateway/authentication.md

- Route: /gateway/authentication
- Headings:
  - H2: Recommended setup: API key (any provider)
  - H2: Anthropic: Claude CLI reuse
  - H2: Manual token entry
  - H3: SecretRef-backed credentials
  - H2: Checking model auth status
  - H2: API key rotation (gateway)
  - H2: Removing provider auth while the gateway is running
  - H2: Controlling which credential is used
  - H3: OpenAI and legacy openai-codex ids
  - H3: During login (CLI)
  - H3: Per-session (chat command)
  - H3: Per-agent (CLI override)
  - H2: Troubleshooting
  - H3: "No credentials found"
  - H3: Token expiring/expired
  - H2: Related

## gateway/background-process.md

- Route: /gateway/background-process
- Headings:
  - H2: exec tool
  - H3: Env overrides
  - H3: Config (preferred over env overrides)
  - H2: Child process bridging
  - H2: process tool
  - H2: Examples
  - H2: Related

## gateway/bonjour.md

- Route: /gateway/bonjour
- Headings:
  - H2: Wide-area Bonjour (Unicast DNS-SD) over Tailscale
  - H3: Gateway config
  - H3: One-time DNS server setup (gateway host, macOS only)
  - H3: Tailscale DNS settings
  - H3: Gateway listener security
  - H2: What advertises
  - H2: Service types
  - H2: TXT keys (non-secret hints)
  - H2: Debugging on macOS
  - H2: Debugging in Gateway logs
  - H2: Debugging on iOS node
  - H2: When to enable Bonjour
  - H2: When to disable Bonjour
  - H2: Docker gotchas
  - H2: Troubleshooting disabled Bonjour
  - H2: Common failure modes
  - H2: Escaped instance names (\032)
  - H2: Enabling / disabling / configuration
  - H2: Related docs

## gateway/bridge-protocol.md

- Route: /gateway/bridge-protocol
- Headings:
  - H2: Why it existed
  - H2: Transport
  - H2: Handshake and pairing
  - H2: Frames
  - H2: Exec lifecycle events
  - H2: Historical tailnet usage
  - H2: Versioning
  - H2: Related

## gateway/cli-backends.md

- Route: /gateway/cli-backends
- Headings:
  - H2: Quick start
  - H2: Using it as a fallback
  - H2: Configuration
  - H2: How it works
  - H3: Claude CLI specifics
  - H2: Sessions
  - H2: Fallback prelude from claude-cli sessions
  - H2: Images
  - H2: Inputs and outputs
  - H2: Plugin-owned defaults
  - H2: Text transform overlays
  - H2: Native compaction ownership
  - H2: Bundle MCP overlays
  - H2: Reseed history cap
  - H2: Limitations
  - H2: Troubleshooting
  - H2: Related

## gateway/config-agents.md

- Route: /gateway/config-agents
- Headings:
  - H2: Agent defaults
  - H3: agents.defaults.workspace
  - H3: agents.defaults.repoRoot
  - H3: agents.defaults.skills
  - H3: agents.defaults.skipBootstrap
  - H3: agents.defaults.skipOptionalBootstrapFiles
  - H3: agents.defaults.contextInjection
  - H3: agents.defaults.bootstrapMaxChars
  - H3: agents.defaults.bootstrapTotalMaxChars
  - H3: Per-agent bootstrap profile overrides
  - H3: agents.defaults.bootstrapPromptTruncationWarning
  - H3: Context budget ownership map
  - H4: agents.defaults.startupContext
  - H4: agents.defaults.contextLimits
  - H4: agents.list[].contextLimits
  - H4: skills.limits.maxSkillsPromptChars
  - H4: agents.list[].skillsLimits.maxSkillsPromptChars
  - H3: agents.defaults.imageMaxDimensionPx
  - H3: agents.defaults.imageQuality
  - H3: agents.defaults.userTimezone
  - H3: agents.defaults.timeFormat
  - H3: agents.defaults.model
  - H3: Runtime policy
  - H3: agents.defaults.cliBackends
  - H3: agents.defaults.promptOverlays
  - H3: agents.defaults.heartbeat
  - H3: agents.defaults.compaction
  - H3: agents.defaults.runRetries
  - H3: agents.defaults.contextPruning
  - H3: Block streaming
  - H3: Typing indicators
  - H3: agents.defaults.sandbox
  - H3: agents.list (per-agent overrides)
  - H2: Multi-agent routing
  - H3: Binding match fields
  - H3: Per-agent access profiles
  - H2: Session
  - H2: Messages
  - H3: Response prefix
  - H3: Ack reaction
  - H3: Queue
  - H3: Inbound debounce
  - H3: Other message keys
  - H3: TTS (text-to-speech)
  - H2: Talk
  - H2: Related

## gateway/config-channels.md

- Route: /gateway/config-channels
- Headings:
  - H2: Channels
  - H3: DM and group access
  - H3: Channel model overrides
  - H3: Channel defaults and heartbeat
  - H3: WhatsApp
  - H3: Telegram
  - H3: Discord
  - H3: Google Chat
  - H3: Slack
  - H3: Mattermost
  - H3: Signal
  - H3: iMessage
  - H3: Matrix
  - H3: Microsoft Teams
  - H3: IRC
  - H3: Multi-account (all channels)
  - H3: Other plugin channels
  - H3: Group chat mention gating
  - H4: DM history limits
  - H4: Self-chat mode
  - H3: Commands (chat command handling)
  - H2: Related

## gateway/config-tools.md

- Route: /gateway/config-tools
- Headings:
  - H2: Tools
  - H3: Tool profiles
  - H3: Tool groups
  - H3: MCP and plugin tools inside sandbox tool policy
  - H3: tools.codeMode
  - H3: tools.allow / tools.deny
  - H3: tools.byProvider
  - H3: tools.toolsBySender
  - H3: tools.elevated
  - H3: tools.exec
  - H3: tools.loopDetection
  - H3: tools.web
  - H3: tools.media
  - H3: tools.agentToAgent
  - H3: tools.sessions
  - H3: tools.sessionsspawn
  - H3: tools.experimental
  - H3: agents.defaults.subagents
  - H2: Custom providers and base URLs
  - H3: Provider field details
  - H3: Provider examples
  - H2: Related

## gateway/configuration-examples.md

- Route: /gateway/configuration-examples
- Headings:
  - H2: Quick start
  - H3: Absolute minimum
  - H3: Recommended starter
  - H2: Expanded example (major options)
  - H3: Symlinked sibling skill repo
  - H2: Common patterns
  - H3: Shared skill baseline with one override
  - H3: Multi-platform setup
  - H3: Trusted node network auto-approval
  - H3: Secure DM mode (shared inbox / multi-user DMs)
  - H3: Anthropic API key + MiniMax fallback
  - H3: Work bot (restricted access)
  - H3: Local models only
  - H2: Tips
  - H2: Related

## gateway/configuration-reference.md

- Route: /gateway/configuration-reference
- Headings:
  - H2: Channels
  - H2: Agent defaults, multi-agent, sessions, and messages
  - H2: Tools and custom providers
  - H2: Models
  - H2: MCP
  - H2: Skills
  - H2: Plugins
  - H3: Codex harness plugin config
  - H2: Commitments
  - H2: Browser
  - H2: UI
  - H2: Gateway
  - H3: OpenAI-compatible endpoints
  - H3: Multi-instance isolation
  - H3: gateway.tls
  - H3: gateway.reload
  - H2: Hooks
  - H3: Gmail integration
  - H2: Canvas plugin host
  - H2: Discovery
  - H3: mDNS (Bonjour)
  - H3: Wide-area (DNS-SD)
  - H2: Environment
  - H3: env (inline env vars)
  - H3: Env var substitution
  - H2: Secrets
  - H3: SecretRef
  - H3: Supported credential surface
  - H3: Secret providers config
  - H2: Auth storage
  - H3: auth.cooldowns
  - H2: Audit
  - H2: Logging
  - H2: Diagnostics
  - H2: Update
  - H2: ACP
  - H2: CLI
  - H2: Wizard
  - H2: Identity
  - H2: Bridge (legacy, removed)
  - H2: Cron
  - H3: cron.retry
  - H3: cron.failureAlert
  - H3: cron.failureDestination
  - H2: Media model template variables
  - H2: Config includes ($include)
  - H2: Related

## gateway/configuration.md

- Route: /gateway/configuration
- Headings:
  - H2: Minimal config
  - H2: Editing config
  - H2: Strict validation
  - H2: Common tasks
  - H2: Config hot reload
  - H3: Reload modes
  - H3: What hot-applies vs what needs a restart
  - H3: Reload planning
  - H2: Config RPC (programmatic updates)
  - H2: Environment variables
  - H2: Full reference
  - H2: Related

## gateway/diagnostics.md

- Route: /gateway/diagnostics
- Headings:
  - H2: Quick start
  - H2: Chat command
  - H2: What the export contains
  - H2: Privacy model
  - H2: Stability recorder
  - H2: Useful options
  - H2: Disable diagnostics
  - H2: Related

## gateway/discovery.md

- Route: /gateway/discovery
- Headings:
  - H2: Terms
  - H2: Why direct and SSH both exist
  - H2: Discovery inputs
  - H3: 1) Bonjour / DNS-SD
  - H4: Service beacon details
  - H3: 2) Tailnet (cross-network)
  - H3: 3) Manual / SSH target
  - H2: Transport selection (client policy)
  - H2: Pairing and auth (direct transport)
  - H2: Responsibilities by component
  - H2: Related

## gateway/doctor.md

- Route: /gateway/doctor
- Headings:
  - H2: Quick start
  - H3: Headless and automation modes
  - H2: Read-only lint mode
  - H2: What it does (summary)
  - H2: Dreams UI backfill and reset
  - H2: Detailed behavior and rationale
  - H2: Related

## gateway/external-apps.md

- Route: /gateway/external-apps
- Headings:
  - H2: What is available today
  - H2: Recommended path
  - H2: App code vs plugin code
  - H2: Related

## gateway/gateway-lock.md

- Route: /gateway/gateway-lock
- Headings:
  - H2: Why
  - H2: Two layers
  - H3: File lock
  - H3: Socket bind
  - H2: Operational notes
  - H2: Related

## gateway/health.md

- Route: /gateway/health
- Headings:
  - H2: Quick checks
  - H2: Deep diagnostics
  - H2: Health monitor config
  - H2: Uptime monitoring
  - H3: Monitoring service setup examples
  - H2: When something fails
  - H2: Dedicated "health" command
  - H2: Related

## gateway/heartbeat.md

- Route: /gateway/heartbeat
- Headings:
  - H2: Quick start (beginner)
  - H2: Defaults
  - H2: What the heartbeat prompt is for
  - H2: Response contract
  - H2: Config
  - H3: Scope and precedence
  - H3: Per-agent heartbeats
  - H3: Active hours example
  - H3: 24/7 setup
  - H3: Multi-account example
  - H3: Field notes
  - H2: Delivery behavior
  - H2: Visibility controls
  - H3: What each flag does
  - H3: Per-channel vs per-account examples
  - H3: Common patterns
  - H2: HEARTBEAT.md (optional)
  - H3: tasks: blocks
  - H3: Can the agent update HEARTBEAT.md?
  - H2: Manual wake (on-demand)
  - H2: Reasoning delivery (optional)
  - H2: Cost awareness
  - H2: Context overflow after heartbeat
  - H2: Related

## gateway/index.md

- Route: /gateway
- Headings:
  - H2: 5-minute local startup
  - H2: Runtime model
  - H2: OpenAI-compatible endpoints
  - H3: Port and bind precedence
  - H3: Hot reload modes
  - H2: Operator command set
  - H2: Multiple gateways (same host)
  - H2: Remote access
  - H2: Supervision and service lifecycle
  - H2: Dev profile quick path
  - H2: Protocol quick reference (operator view)
  - H2: Operational checks
  - H3: Liveness
  - H3: Readiness
  - H3: Gap recovery
  - H2: Common failure signatures
  - H2: Safety guarantees
  - H2: Related

## gateway/local-model-services.md

- Route: /gateway/local-model-services
- Headings:
  - H2: How it works
  - H2: Config shape
  - H2: Fields
  - H2: Inferrs example
  - H2: ds4 example
  - H2: Related

## gateway/local-models.md

- Route: /gateway/local-models
- Headings:
  - H2: Hardware floor
  - H2: Pick a backend
  - H2: LM Studio + large local model (Responses API)
  - H3: Hybrid config: hosted primary, local fallback
  - H3: Regional hosting / data routing
  - H2: Other OpenAI-compatible local proxies
  - H2: Smaller or stricter backends
  - H2: Troubleshooting
  - H2: Related

## gateway/logging.md

- Route: /gateway/logging
- Headings:
  - H1: Logging
  - H2: File-based logger
  - H3: Verbose vs. log levels
  - H2: Console capture
  - H2: Redaction
  - H2: Gateway WebSocket logs
  - H3: WS log style
  - H2: Console formatting (subsystem logging)
  - H2: Related

## gateway/multiple-gateways.md

- Route: /gateway/multiple-gateways
- Headings:
  - H2: Rescue-bot quickstart
  - H3: What --profile rescue onboard changes
  - H2: General multi-gateway setup
  - H2: Isolation checklist
  - H2: Port mapping (derived)
  - H2: Browser/CDP notes (common footgun)
  - H2: Manual env example
  - H2: Quick checks
  - H2: Related

## gateway/network-model.md

- Route: /gateway/network-model
- Headings:
  - H2: Related

## gateway/openai-http-api.md

- Route: /gateway/openai-http-api
- Headings:
  - H2: Enabling the endpoint
  - H2: Security boundary (important)
  - H2: Authentication
  - H2: When to use this endpoint
  - H2: Agent-first model contract
  - H2: Session behavior
  - H2: Request limits (config)
  - H2: Chat tool contract
  - H3: Supported request fields
  - H3: Unsupported variants
  - H3: Non-streaming tool response shape
  - H3: Streaming tool response shape
  - H3: Tool follow-up loop
  - H2: Streaming (SSE)
  - H2: Open WebUI quick setup
  - H2: Examples
  - H2: Related

## gateway/openresponses-http-api.md

- Route: /gateway/openresponses-http-api
- Headings:
  - H2: Authentication, security, and routing
  - H2: Session behavior
  - H2: Request shape
  - H2: Items (input)
  - H3: message
  - H3: functioncalloutput (turn-based tools)
  - H3: reasoning and itemreference
  - H2: Tools (client-side function tools)
  - H2: Images (inputimage)
  - H2: Files (inputfile)
  - H2: File + image limits (config)
  - H2: Streaming (SSE)
  - H2: Usage
  - H2: Errors
  - H2: Examples
  - H2: Related

## gateway/openshell.md

- Route: /gateway/openshell
- Headings:
  - H2: Prerequisites
  - H2: Quick start
  - H2: Workspace modes
  - H3: mirror (default)
  - H3: remote
  - H3: Choosing a mode
  - H2: Configuration reference
  - H2: Examples
  - H3: Minimal remote setup
  - H3: Mirror mode with GPU
  - H3: Per-agent OpenShell with custom gateway
  - H2: Lifecycle management
  - H2: Security hardening
  - H2: Current limitations
  - H2: How it works
  - H2: Related

## gateway/opentelemetry.md

- Route: /gateway/opentelemetry
- Headings:
  - H2: Quick start
  - H2: Signals exported
  - H2: Configuration reference
  - H3: Environment variables
  - H2: Privacy and content capture
  - H2: Sampling and flushing
  - H2: Exported metrics
  - H3: Model usage
  - H3: Message flow
  - H3: Talk
  - H3: Queues and sessions
  - H3: Session liveness telemetry
  - H3: Harness lifecycle
  - H3: Tool execution and loop detection
  - H3: Exec
  - H3: Diagnostics internals (memory, payloads, exporter health)
  - H2: Exported spans
  - H2: Diagnostic event catalog
  - H2: Without an exporter
  - H2: Disable
  - H2: Related

## gateway/operator-scopes.md

- Route: /gateway/operator-scopes
- Headings:
  - H2: Roles
  - H2: Scope levels
  - H2: Method scope is only the first gate
  - H2: Device pairing approvals
  - H2: Node pairing approvals
  - H2: Shared-secret auth

## gateway/pairing.md

- Route: /gateway/pairing
- Headings:
  - H2: Concepts
  - H2: How pairing works
  - H2: CLI workflow (headless friendly)
  - H2: API surface (gateway protocol)
  - H2: Node command gating (2026.3.31+)
  - H2: Node event trust boundaries (2026.3.31+)
  - H2: Auto-approval (macOS app)
  - H2: Trusted-CIDR device auto-approval
  - H2: Metadata-upgrade auto-approval
  - H2: QR pairing helpers
  - H2: Locality and forwarded headers
  - H2: Storage (local, private)
  - H2: Transport behavior
  - H2: Related

## gateway/prometheus.md

- Route: /gateway/prometheus
- Headings:
  - H2: Quick start
  - H2: Metrics exported
  - H2: Label policy
  - H2: PromQL recipes
  - H2: Choosing between Prometheus and OpenTelemetry export
  - H2: Troubleshooting
  - H2: Related

## gateway/protocol.md

- Route: /gateway/protocol
- Headings:
  - H2: Transport and framing
  - H2: Handshake
  - H3: Node connect example
  - H2: Roles and scopes
  - H2: Presence
  - H3: Node background alive event
  - H2: Broadcast event scoping
  - H2: RPC method families
  - H3: Common event families
  - H3: Node helper methods
  - H2: Audit ledger RPC
  - H2: Task ledger RPCs
  - H2: Operator helper methods
  - H3: models.list views
  - H2: Exec approvals
  - H2: Agent delivery fallback
  - H2: Versioning
  - H3: Client constants
  - H2: Auth
  - H2: Device identity and pairing
  - H3: Device auth migration diagnostics
  - H2: TLS and pinning
  - H2: Scope
  - H2: Related

## gateway/remote-gateway-readme.md

- Route: /gateway/remote-gateway-readme
- Headings:
  - H1: Running OpenClaw.app with a Remote Gateway
  - H2: Setup
  - H2: How it works
  - H2: Related

## gateway/remote.md

- Route: /gateway/remote
- Headings:
  - H2: The core idea
  - H2: Topology options
  - H2: Command flow (what runs where)
  - H2: SSH tunnel (CLI + tools)
  - H2: CLI remote defaults
  - H2: Credential precedence
  - H2: Chat UI remote access
  - H2: macOS app remote mode
  - H2: Security rules (remote/VPN)
  - H3: macOS: persistent SSH tunnel via LaunchAgent
  - H4: Step 1: add SSH config
  - H4: Step 2: copy SSH key (one-time)
  - H4: Step 3: configure the gateway token
  - H4: Step 4: create the LaunchAgent
  - H4: Step 5: load the LaunchAgent
  - H4: Troubleshooting
  - H2: Related

## gateway/sandbox-vs-tool-policy-vs-elevated.md

- Route: /gateway/sandbox-vs-tool-policy-vs-elevated
- Headings:
  - H2: Quick debug
  - H2: Sandbox: where tools run
  - H3: Bind mounts (security quick check)
  - H2: Tool policy: which tools exist/are callable
  - H3: Tool groups (shorthands)
  - H2: Elevated: exec-only "run on host"
  - H2: Common "sandbox jail" fixes
  - H3: "Tool X blocked by sandbox tool policy"
  - H3: "I thought this was main, why is it sandboxed?"
  - H2: Related

## gateway/sandboxing.md

- Route: /gateway/sandboxing
- Headings:
  - H2: What gets sandboxed
  - H2: Modes, scope, and backend
  - H2: Docker backend
  - H3: Sandboxed browser
  - H2: SSH backend
  - H2: OpenShell backend
  - H2: Workspace access
  - H2: Custom bind mounts
  - H2: Images and setup
  - H2: setupCommand (one-time container setup)
  - H2: Tool policy and escape hatches
  - H2: Multi-agent overrides
  - H2: Minimal enable example
  - H2: Related

## gateway/secrets-plan-contract.md

- Route: /gateway/secrets-plan-contract
- Headings:
  - H2: Plan file shape
  - H2: Provider upserts and deletes
  - H2: Supported target scope
  - H2: Target type behavior
  - H2: Path validation rules
  - H2: Failure behavior
  - H2: Exec provider consent behavior
  - H2: Runtime and audit scope notes
  - H2: Operator checks
  - H2: Related docs

## gateway/secrets.md

- Route: /gateway/secrets
- Headings:
  - H2: Runtime model
  - H2: Agent-access boundary
  - H2: Active-surface filtering
  - H2: Gateway auth surface diagnostics
  - H2: Onboarding reference preflight
  - H2: SecretRef contract
  - H2: Provider config
  - H2: File-backed API keys
  - H2: Exec integration examples
  - H2: MCP server environment variables
  - H2: Sandbox SSH auth material
  - H2: Supported credential surface
  - H2: Required behavior and precedence
  - H2: Activation triggers
  - H2: Degraded and recovered signals
  - H2: Command-path resolution
  - H2: Audit and configure workflow
  - H2: One-way safety policy
  - H2: Legacy auth compatibility notes
  - H2: Web UI note
  - H2: Related

## gateway/security/audit-checks.md

- Route: /gateway/security/audit-checks
- Headings:
  - H2: Related

## gateway/security/exposure-runbook.md

- Route: /gateway/security/exposure-runbook
- Headings:
  - H2: Choose the exposure pattern
  - H2: Pre-flight inventory
  - H2: Baseline checks
  - H2: Minimum safe baseline
  - H2: DM and group exposure
  - H2: Reverse proxy checks
  - H2: Tool and sandbox review
  - H2: Post-change validation
  - H2: Rollback plan
  - H2: Review checklist

## gateway/security/index.md

- Route: /gateway/security
- Headings:
  - H2: Scope: personal assistant security model
  - H2: openclaw security audit
  - H3: What the audit checks (high level)
  - H3: Priority order when triaging findings
  - H2: Hardened baseline in 60 seconds
  - H2: Trust boundary matrix
  - H2: Not vulnerabilities by design
  - H2: Gateway and node trust
  - H2: Threat model
  - H2: DM access: pairing, allowlist, open, disabled
  - H3: Allowlists (two layers)
  - H3: DM session isolation (multi-user mode)
  - H2: Context visibility vs trigger authorization
  - H2: Prompt injection
  - H3: External content and untrusted-input wrapping
  - H3: Bypass flags (keep off in production)
  - H3: Reasoning and verbose output in groups
  - H2: Command authorization
  - H2: Control plane tools
  - H2: Node execution (system.run)
  - H2: Dynamic skills (watcher / remote nodes)
  - H2: Plugins
  - H2: Sandboxing
  - H3: Sub-agent delegation guardrail
  - H3: Read-only mode
  - H2: Per-agent access profiles (multi-agent)
  - H3: Full access (no sandbox)
  - H3: Read-only tools + read-only workspace
  - H3: No filesystem/shell access (provider messaging allowed)
  - H2: Browser control risks
  - H3: Browser SSRF policy (strict by default)
  - H2: Network exposure
  - H3: Bind, port, firewall
  - H3: Docker port publishing with UFW
  - H3: mDNS/Bonjour discovery
  - H3: Gateway WebSocket auth
  - H3: Tailscale Serve identity headers
  - H3: Reverse proxy configuration
  - H3: HSTS and origin notes
  - H3: Control UI over HTTP
  - H3: Insecure/dangerous flags
  - H2: Deployment and host trust
  - H2: Secrets on disk
  - H3: Credential storage map
  - H3: File permissions
  - H3: Workspace .env files
  - H3: Logs and transcripts
  - H2: Secure baseline (copy/paste)
  - H3: Separate numbers (WhatsApp, Signal, Telegram)
  - H2: Incident response
  - H3: Contain
  - H3: Rotate (assume compromise if secrets leaked)
  - H3: Audit
  - H3: Collect for a report
  - H2: Secret scanning
  - H2: Reporting security issues

## gateway/security/secure-file-operations.md

- Route: /gateway/security/secure-file-operations
- Headings:
  - H2: Default: no Python helper
  - H2: What stays protected without Python
  - H2: What Python adds
  - H2: Plugin and core guidance

## gateway/security/shrinkwrap.md

- Route: /gateway/security/shrinkwrap
- Headings:
  - H2: Why it matters
  - H2: Generating and checking
  - H2: Inspecting a published package

## gateway/tailscale.md

- Route: /gateway/tailscale
- Headings:
  - H2: Modes
  - H2: Config examples
  - H3: Tailnet-only (Serve)
  - H3: Tailnet-only (bind to Tailnet IP)
  - H3: Public internet (Funnel + shared password)
  - H2: CLI examples
  - H2: Auth
  - H3: Tailscale identity headers (Serve only)
  - H2: Notes
  - H3: Tailscale prerequisites and limits
  - H2: Browser control (remote Gateway + local browser)
  - H2: Learn more
  - H2: Related

## gateway/tools-invoke-http-api.md

- Route: /gateway/tools-invoke-http-api
- Headings:
  - H2: Authentication
  - H2: Security boundary (important)
  - H2: Request body
  - H2: Policy + routing behavior
  - H2: Responses
  - H2: Example
  - H2: Related

## gateway/troubleshooting.md

- Route: /gateway/troubleshooting
- Headings:
  - H2: Command ladder
  - H2: After an update
  - H2: Split brain installs and newer config guard
  - H2: Protocol mismatch after rollback
  - H2: Skill symlink skipped as path escape
  - H2: Anthropic 429 extra usage required for long context
  - H2: Upstream 403 blocked responses
  - H2: Local OpenAI-compatible backend passes direct probes but agent runs fail
  - H2: No replies
  - H2: Dashboard control UI connectivity
  - H3: Auth detail codes quick map
  - H2: Gateway service not running
  - H2: macOS gateway silently stops responding, then resumes when you touch the dashboard
  - H2: Gateway exits during high memory use
  - H2: Gateway rejected invalid config
  - H2: Gateway probe warnings
  - H2: Channel connected, messages not flowing
  - H2: Cron and heartbeat delivery
  - H2: Node paired, tool fails
  - H2: Browser tool fails
  - H2: If you upgraded and something suddenly broke
  - H2: Related

## gateway/trusted-proxy-auth.md

- Route: /gateway/trusted-proxy-auth
- Headings:
  - H2: When to use
  - H2: When NOT to use
  - H2: How it works
  - H2: Configuration
  - H3: Configuration reference
  - H2: Control UI pairing behavior
  - H2: Operator scopes header
  - H2: TLS termination and HSTS
  - H3: Rollout guidance
  - H2: Proxy setup examples
  - H2: Mixed token configuration
  - H2: Security checklist
  - H2: Security audit
  - H2: Troubleshooting
  - H2: Migration from token auth
  - H2: Related

## help/debugging.md

- Route: /help/debugging
- Headings:
  - H2: Runtime debug overrides
  - H2: Session trace output
  - H2: Plugin lifecycle trace
  - H2: CLI startup and command profiling
  - H2: Gateway watch mode
  - H2: Dev profile + dev gateway (--dev)
  - H2: Raw stream logging
  - H2: Safety notes
  - H2: Debugging in VSCode
  - H3: Setup
  - H3: Notes
  - H2: Related

## help/environment.md

- Route: /help/environment
- Headings:
  - H2: Precedence (highest to lowest)
  - H2: Provider credentials and workspace .env
  - H2: Config env block
  - H2: Shell env import
  - H2: Exec shell snapshots
  - H2: Runtime-injected env vars
  - H2: UI env vars
  - H2: Env var substitution in config
  - H2: Secret refs vs ${ENV} strings
  - H2: Path-related env vars
  - H2: Logging
  - H3: OPENCLAWHOME
  - H2: nvm users: webfetch TLS failures
  - H2: Legacy environment variables
  - H2: Related

## help/faq-first-run.md

- Route: /help/faq-first-run
- Headings:
  - H2: Quick start and first-run setup
  - H2: Related

## help/faq-models.md

- Route: /help/faq-models
- Headings:
  - H2: Models: defaults, selection, aliases, switching
  - H2: Model failover and "All models failed"
  - H2: Auth profiles: what they are and how to manage them
  - H2: Related

## help/faq.md

- Route: /help/faq
- Headings:
  - H2: First 60 seconds if something is broken
  - H2: Quick start and first-run setup
  - H2: What is OpenClaw?
  - H2: Skills and automation
  - H2: Sandboxing and memory
  - H2: Where things live on disk
  - H2: Config basics
  - H2: Remote gateways and nodes
  - H2: Env vars and .env loading
  - H2: Sessions and multiple chats
  - H2: Models, failover, and auth profiles
  - H2: Gateway: ports, "already running", and remote mode
  - H2: Logging and debugging
  - H2: Media and attachments
  - H2: Security and access control
  - H2: Chat commands, aborting tasks, and "it will not stop"
  - H2: Miscellaneous
  - H2: Related

## help/index.md

- Route: /help
- Headings:
  - H2: FAQ
  - H2: Diagnostics
  - H2: Testing
  - H2: Community and meta

## help/scripts.md

- Route: /help/scripts
- Headings:
  - H2: Conventions
  - H2: Auth monitoring scripts
  - H2: GitHub read helper
  - H2: When adding scripts
  - H2: Related

## help/testing-live.md

- Route: /help/testing-live
- Headings:
  - H2: Live: local smoke commands
  - H2: Live: Android node capability sweep
  - H2: Live: model smoke (profile keys)
  - H3: Layer 1: Direct model completion (no gateway)
  - H3: Layer 2: Gateway + dev agent smoke (what "@openclaw" actually does)
  - H2: Live: CLI backend smoke (Claude, Gemini, or other local CLIs)
  - H2: Live: APNs HTTP/2 proxy reachability
  - H2: Live: ACP bind smoke (/acp spawn ... --bind here)
  - H2: Live: Codex app-server harness smoke
  - H3: Recommended live recipes
  - H2: Live: model matrix (what we cover)
  - H3: Aggregators / alternate gateways
  - H2: Credentials (never commit)
  - H2: Deepgram live (audio transcription)
  - H2: BytePlus coding plan live
  - H2: ComfyUI workflow media live
  - H2: Image generation live
  - H2: Music generation live
  - H2: Video generation live
  - H2: Media live harness
  - H2: Related

## help/testing-updates-plugins.md

- Route: /help/testing-updates-plugins
- Headings:
  - H2: What we protect
  - H2: Local proof during development
  - H2: Docker lanes
  - H2: Package Acceptance
  - H2: Release default
  - H2: Legacy compatibility
  - H2: Adding coverage
  - H2: Failure triage

## help/testing.md

- Route: /help/testing
- Headings:
  - H2: Quick start
  - H2: Test Temp Directories
  - H2: Live and Docker/Parallels workflows
  - H2: QA-specific runners
  - H3: Shared Telegram credentials via Convex (v1)
  - H3: Adding a channel to QA
  - H2: Test suites (what runs where)
  - H3: Unit / integration (default)
  - H3: Stability (gateway)
  - H3: E2E (repo aggregate)
  - H3: E2E (gateway smoke)
  - H3: E2E (Control UI mocked browser)
  - H3: E2E: OpenShell backend smoke
  - H3: Live (real providers + real models)
  - H2: Which suite should I run?
  - H2: Live (network-touching) tests
  - H2: Docker runners (optional "works in Linux" checks)
  - H2: Docs sanity
  - H2: Offline regression (CI-safe)
  - H2: Agent reliability evals (skills)
  - H2: Contract tests (plugin and channel shape)
  - H3: Commands
  - H3: Channel contracts
  - H3: Provider contracts
  - H3: When to run
  - H2: Adding regressions (guidance)
  - H2: Related

## help/troubleshooting.md

- Route: /help/troubleshooting
- Headings:
  - H2: First 60 seconds
  - H2: Assistant feels limited or missing tools
  - H2: Anthropic long context 429
  - H2: Local OpenAI-compatible backend works directly but fails in OpenClaw
  - H2: Plugin install fails with missing openclaw extensions
  - H2: Install policy blocks plugin installs or updates
  - H2: Plugin present but blocked by suspicious ownership
  - H2: Decision tree
  - H2: Related

## index.md

- Route: /
- Headings:
  - H1: OpenClaw 🦞
  - H2: What is OpenClaw?
  - H2: How it works
  - H2: Key capabilities
  - H2: Quick start
  - H2: Dashboard
  - H2: Configuration (optional)
  - H2: Start here
  - H2: Learn more

## install/ansible.md

- Route: /install/ansible
- Headings:
  - H2: Prerequisites
  - H2: What you get
  - H2: Quick start
  - H2: What gets installed
  - H2: Post-install setup
  - H3: Quick commands
  - H2: Security architecture
  - H2: Manual installation
  - H2: Updating
  - H2: Troubleshooting
  - H2: Advanced configuration
  - H2: Related

## install/azure.md

- Route: /install/azure
- Headings:
  - H2: What you will do
  - H2: What you need
  - H2: Configure deployment
  - H2: Deploy Azure resources
  - H2: Install OpenClaw
  - H2: Cost considerations
  - H2: Cleanup
  - H2: Next steps
  - H2: Related

## install/bun.md

- Route: /install/bun
- Headings:
  - H2: Install
  - H2: Lifecycle scripts
  - H2: Caveats
  - H2: Related

## install/clawdock.md

- Route: /install/clawdock
- Headings:
  - H2: Install
  - H2: What you get
  - H3: Basic operations
  - H3: Container access
  - H3: Web UI and pairing
  - H3: Setup and maintenance
  - H3: Utilities
  - H2: First-time flow
  - H2: Config and secrets
  - H2: Related

## install/development-channels.md

- Route: /install/development-channels
- Headings:
  - H2: Switching channels
  - H2: One-off version or tag targeting
  - H2: Dry run
  - H2: Plugins and channels
  - H2: Checking current status
  - H2: Tagging best practices
  - H2: macOS app availability
  - H2: Related

## install/digitalocean.md

- Route: /install/digitalocean
- Headings:
  - H2: Prerequisites
  - H2: Setup
  - H2: Persistence and backups
  - H2: 1 GB RAM tips
  - H2: Troubleshooting
  - H2: Next steps
  - H2: Related

## install/docker-vm-runtime.md

- Route: /install/docker-vm-runtime
- Headings:
  - H2: Bake required binaries into the image
  - H2: Build and launch
  - H2: What persists where
  - H2: Updates
  - H2: Related

## install/docker.md

- Route: /install/docker
- Headings:
  - H2: Prerequisites
  - H2: Containerized gateway
  - H3: Manual flow
  - H3: Environment variables
  - H3: Observability
  - H3: Health checks
  - H3: LAN vs loopback
  - H3: Host local providers
  - H3: Claude CLI backend in Docker
  - H3: Bonjour / mDNS
  - H3: Storage and persistence
  - H3: Shell helpers (optional)
  - H3: Running on a VPS?
  - H2: Agent sandbox
  - H3: Quick enable
  - H2: Troubleshooting
  - H2: Related

## install/exe-dev.md

- Route: /install/exe-dev
- Headings:
  - H2: What you need
  - H2: Beginner quick path
  - H2: Automated install with Shelley
  - H2: Manual installation
  - H2: Remote channel setup
  - H2: Remote access
  - H2: Updating
  - H2: Related

## install/fly.md

- Route: /install/fly
- Headings:
  - H2: What you need
  - H2: Beginner quick path
  - H2: Troubleshooting
  - H3: "App is not listening on expected address"
  - H3: Health checks failing / connection refused
  - H3: OOM / memory issues
  - H3: Gateway lock issues
  - H3: Config not being read
  - H3: Writing config via SSH
  - H3: State not persisting
  - H2: Updating
  - H3: Updating the machine command
  - H2: Private deployment (hardened)
  - H3: When to use private deployment
  - H3: Setup
  - H3: Accessing a private deployment
  - H3: Webhooks with private deployment
  - H3: Security tradeoffs
  - H2: Notes
  - H2: Cost
  - H2: Next steps
  - H2: Related

## install/gcp.md

- Route: /install/gcp
- Headings:
  - H2: What you need
  - H2: Quick path
  - H2: Troubleshooting
  - H2: Service accounts (security best practice)
  - H2: Next steps
  - H2: Related

## install/hetzner.md

- Route: /install/hetzner
- Headings:
  - H2: What you need
  - H2: Quick path
  - H2: Infrastructure as Code (Terraform)
  - H2: Next steps
  - H2: Related

## install/hostinger.md

- Route: /install/hostinger
- Headings:
  - H2: Prerequisites
  - H2: Option A: 1-Click OpenClaw
  - H2: Option B: OpenClaw on VPS
  - H2: Verify your setup
  - H2: Troubleshooting
  - H2: Next steps
  - H2: Related

## install/index.md

- Route: /install
- Headings:
  - H2: System requirements
  - H2: Recommended: installer script
  - H2: Alternative install methods
  - H3: Local prefix installer (install-cli.sh)
  - H3: npm, pnpm, or bun
  - H3: From source
  - H3: Install from the GitHub main checkout
  - H3: Containers and package managers
  - H2: Verify the install
  - H2: Hosting and deployment
  - H2: Update, migrate, or uninstall
  - H2: Troubleshooting: openclaw not found

## install/installer.md

- Route: /install/installer
- Headings:
  - H2: Quick commands
  - H2: install.sh
  - H3: Flow (install.sh)
  - H3: Source checkout detection
  - H3: Examples (install.sh)
  - H2: install-cli.sh
  - H3: Flow (install-cli.sh)
  - H3: Examples (install-cli.sh)
  - H2: install.ps1
  - H3: Flow (install.ps1)
  - H3: Examples (install.ps1)
  - H2: CI and automation
  - H2: Troubleshooting
  - H2: Related

## install/kubernetes.md

- Route: /install/kubernetes
- Headings:
  - H2: Why not Helm
  - H2: What you need
  - H2: Quick start
  - H2: Local testing with Kind
  - H2: Step by step
  - H3: 1) Deploy
  - H3: 2) Access the gateway
  - H2: What gets deployed
  - H2: Customization
  - H3: Agent instructions
  - H3: Gateway config
  - H3: Add providers
  - H3: Custom namespace
  - H3: Custom image
  - H3: Expose beyond port-forward
  - H2: Re-deploy
  - H2: Teardown
  - H2: Architecture notes
  - H2: File structure
  - H2: Related

## install/macos-vm.md

- Route: /install/macos-vm
- Headings:
  - H2: Recommended default (most users)
  - H2: macOS VM options
  - H3: Local VM on your Apple Silicon Mac (Lume)
  - H3: Hosted Mac providers (cloud)
  - H2: Quick path (Lume, experienced users)
  - H2: What you need (Lume)
  - H2: 1) Install Lume
  - H2: 2) Create the macOS VM
  - H2: 3) Complete Setup Assistant
  - H2: 4) Get the VM IP address
  - H2: 5) SSH into the VM
  - H2: 6) Install OpenClaw
  - H2: 7) Configure channels
  - H2: 8) Run the VM headlessly
  - H2: Bonus: iMessage integration
  - H2: Save a golden image
  - H2: Running 24/7
  - H2: Troubleshooting
  - H2: Related docs

## install/migrating-claude.md

- Route: /install/migrating-claude
- Headings:
  - H2: Two ways to import
  - H2: What gets imported
  - H2: What stays archive-only
  - H2: Source selection
  - H2: Recommended flow
  - H2: Conflict handling
  - H2: JSON output for automation
  - H2: Troubleshooting
  - H2: Related

## install/migrating-hermes.md

- Route: /install/migrating-hermes
- Headings:
  - H2: Two ways to import
  - H2: What gets imported
  - H2: What stays archive-only
  - H2: Recommended flow
  - H2: Conflict handling
  - H2: Secrets
  - H2: JSON output for automation
  - H2: Troubleshooting
  - H2: Related

## install/migrating.md

- Route: /install/migrating
- Headings:
  - H2: Import from another agent system
  - H2: Move OpenClaw to a new machine
  - H3: Migration steps
  - H3: Common pitfalls
  - H3: Verification checklist
  - H2: Upgrade a plugin in place
  - H2: Related

## install/nix.md

- Route: /install/nix
- Headings:
  - H2: What you get
  - H2: Quick start
  - H2: Nix-mode runtime behavior
  - H3: What changes in Nix mode
  - H3: Config and state paths
  - H3: Service PATH discovery
  - H2: Related

## install/node.md

- Route: /install/node
- Headings:
  - H2: Check your version
  - H2: Install Node
  - H2: Troubleshooting
  - H3: openclaw: command not found
  - H3: Permission errors on npm install -g (Linux)
  - H2: Related

## install/northflank.mdx

- Route: /install/northflank
- Headings:
  - H2: How to get started
  - H2: What you get
  - H2: Connect a channel
  - H2: Next steps

## install/oracle.md

- Route: /install/oracle
- Headings:
  - H2: Prerequisites
  - H2: Setup
  - H2: Verify the security posture
  - H2: ARM notes
  - H2: Persistence and backups
  - H2: Fallback: SSH tunnel
  - H2: Troubleshooting
  - H2: Next steps
  - H2: Related

## install/podman.md

- Route: /install/podman
- Headings:
  - H2: Prerequisites
  - H2: Quick start
  - H2: Podman and Tailscale
  - H2: Systemd (Quadlet, optional)
  - H2: Config, env, and storage
  - H2: Useful commands
  - H2: Troubleshooting
  - H2: Related

## install/railway.mdx

- Route: /install/railway
- Headings:
  - H2: One-click deploy
  - H2: What you get
  - H2: Connect a channel
  - H2: Backups and migration
  - H2: Next steps

## install/raspberry-pi.md

- Route: /install/raspberry-pi
- Headings:
  - H2: Hardware compatibility
  - H2: Prerequisites
  - H2: Setup
  - H2: Performance tips
  - H2: Recommended model setup
  - H2: ARM binary notes
  - H2: Persistence and backups
  - H2: Troubleshooting
  - H2: Next steps
  - H2: Related

## install/render.mdx

- Route: /install/render
- Headings:
  - H2: Prerequisites
  - H2: Deploy
  - H2: The Blueprint
  - H2: Choosing a plan
  - H2: After deployment
  - H3: Access the Control UI
  - H3: Logs
  - H3: Shell access
  - H3: Environment variables
  - H3: Auto-deploy
  - H2: Custom domain
  - H2: Scaling
  - H2: Backups and migration
  - H2: Troubleshooting
  - H3: Service will not start
  - H3: Slow cold starts (free tier)
  - H3: Data loss after redeploy
  - H3: Health check failures
  - H2: Next steps

## install/uninstall.md

- Route: /install/uninstall
- Headings:
  - H2: Easy path (CLI still installed)
  - H2: Manual service removal (CLI not installed)
  - H3: macOS (launchd)
  - H3: Linux (systemd user unit)
  - H3: Windows (Scheduled Task)
  - H2: Normal install vs source checkout
  - H3: Normal install (install.sh / npm / pnpm / bun)
  - H3: Source checkout (git clone)
  - H2: Related

## install/updating.md

- Route: /install/updating
- Headings:
  - H2: Recommended: openclaw update
  - H2: Switch between npm and git installs
  - H2: Alternative: re-run the installer
  - H2: Alternative: manual npm, pnpm, or bun
  - H3: Advanced npm install topics
  - H2: Auto-updater
  - H2: After updating
  - H3: Run doctor
  - H3: Restart the gateway
  - H3: Verify
  - H2: Rollback
  - H3: Pin a version (npm)
  - H3: Pin a commit (source)
  - H2: If you are stuck
  - H2: Related

## install/upstash.md

- Route: /install/upstash
- Headings:
  - H2: Prerequisites
  - H2: Create a Box
  - H2: Connect with an SSH tunnel
  - H2: Install OpenClaw
  - H2: Run onboarding
  - H2: Start the Gateway
  - H2: Auto-restart
  - H2: Troubleshooting
  - H2: Related

## logging.md

- Route: /logging
- Headings:
  - H2: Where logs live
  - H2: How to read logs
  - H3: CLI: live tail (recommended)
  - H3: Control UI (web)
  - H3: Channel-only logs
  - H2: Log formats
  - H3: File logs (JSONL)
  - H3: Console output
  - H3: Gateway WebSocket logs
  - H2: Configuring logging
  - H3: Log levels
  - H3: Targeted model transport diagnostics
  - H3: Trace correlation
  - H3: Model call size and timing
  - H3: Console styles
  - H3: Redaction
  - H2: Diagnostics and OpenTelemetry
  - H2: Troubleshooting tips
  - H2: Related

## maturity/scorecard.md

- Route: /maturity/scorecard
- Headings:
  - H1: Maturity scorecard
  - H2: What this page is for
  - H2: At a glance
  - H2: Score bands
  - H2: Surface explorer
  - H2: QA evidence summary
  - H3: Readiness by area

## maturity/taxonomy.md

- Route: /maturity/taxonomy
- Headings:
  - H1: Maturity taxonomy
  - H2: How to read this page
  - H2: Maturity levels
  - H2: Product areas
  - H2: Details
  - H3: Core
  - H3: Platform
  - H3: Channel
  - H3: Provider and tool

## network.md

- Route: /network
- Headings:
  - H2: Core model
  - H2: Pairing + identity
  - H2: Discovery + transports
  - H2: Nodes + transports
  - H2: Security
  - H2: Related

## nodes/audio.md

- Route: /nodes/audio
- Headings:
  - H2: What it does
  - H2: Auto-detection (default)
  - H2: Config examples
  - H3: Provider + CLI fallback (OpenAI + Whisper CLI)
  - H3: Provider-only with scope gating
  - H3: Provider-only (Deepgram)
  - H3: Provider-only (Mistral Voxtral)
  - H3: Provider-only (SenseAudio)
  - H3: Echo transcript to chat (opt-in)
  - H2: Notes and limits
  - H3: Proxy environment support
  - H2: Mention detection in groups
  - H2: Gotchas
  - H2: Related

## nodes/camera.md

- Route: /nodes/camera
- Headings:
  - H2: iOS node
  - H3: iOS user setting
  - H3: iOS commands (via Gateway node.invoke)
  - H3: iOS foreground requirement
  - H3: CLI helper
  - H2: Android node
  - H3: Android user setting
  - H3: Permissions
  - H3: Android foreground requirement
  - H3: Android commands (via Gateway node.invoke)
  - H2: macOS app
  - H3: macOS user setting
  - H3: CLI helper (node invoke)
  - H2: Safety + practical limits
  - H2: macOS screen video (OS-level)
  - H2: Related

## nodes/images.md

- Route: /nodes/images
- Headings:
  - H2: Goals
  - H2: CLI Surface
  - H2: WhatsApp Web channel behavior
  - H2: Auto-Reply Pipeline
  - H2: Inbound Media To Commands
  - H2: Limits and errors
  - H2: Notes for Tests
  - H2: Related

## nodes/index.md

- Route: /nodes
- Headings:
  - H2: Pairing + status
  - H2: Version skew and upgrade order
  - H2: Remote node host (system.run)
  - H3: Start a node host (foreground)
  - H3: Remote gateway via SSH tunnel (loopback bind)
  - H3: Start a node host (service)
  - H3: Pair + name
  - H3: Allowlist the commands
  - H3: Point exec at the node
  - H3: Local model inference
  - H2: Invoking commands
  - H2: Command policy
  - H2: Config (openclaw.json)
  - H2: Screenshots (canvas snapshots)
  - H3: Canvas controls
  - H3: A2UI (Canvas)
  - H2: Photos + videos (node camera)
  - H2: Screen recordings (nodes)
  - H2: Location (nodes)
  - H2: SMS (Android nodes)
  - H2: Device and personal data commands
  - H2: System commands (node host / mac node)
  - H2: Exec node binding
  - H2: Permissions map
  - H2: Headless node host (cross-platform)
  - H2: Mac node mode

## nodes/location-command.md

- Route: /nodes/location-command
- Headings:
  - H2: TL;DR
  - H2: Why a selector (not just a switch)
  - H2: Settings model
  - H2: Permissions mapping (node.permissions)
  - H2: Command: location.get
  - H2: Background behavior
  - H2: Model/tooling integration
  - H2: UX copy (suggested)
  - H2: Related

## nodes/media-understanding.md

- Route: /nodes/media-understanding
- Headings:
  - H2: How it works
  - H2: Config
  - H3: Model entries
  - H3: Provider credentials
  - H2: Rules and behavior
  - H3: Auto-detect (default)
  - H3: Proxy support (audio/video provider calls)
  - H2: Capabilities
  - H2: Provider support matrix
  - H2: Model selection guidance
  - H2: Attachment policy
  - H3: File-attachment extraction
  - H2: Config examples
  - H2: Status output
  - H2: Notes
  - H2: Related

## nodes/talk.md

- Route: /nodes/talk
- Headings:
  - H2: Behavior (macOS)
  - H2: Voice directives in replies
  - H2: Config (/.openclaw/openclaw.json)
  - H2: macOS UI
  - H2: Android UI
  - H2: Notes
  - H2: Related

## nodes/troubleshooting.md

- Route: /nodes/troubleshooting
- Headings:
  - H2: Command ladder
  - H2: Foreground requirements
  - H2: Permissions matrix
  - H2: Pairing versus approvals
  - H2: Common node error codes
  - H2: Fast recovery loop
  - H2: Related

## nodes/voicewake.md

- Route: /nodes/voicewake
- Headings:
  - H2: Storage
  - H2: Protocol
  - H3: Trigger list
  - H3: Routing (trigger to target)
  - H3: Events
  - H2: Client behavior
  - H2: Related

## openclaw-agent-runtime.md

- Route: /openclaw-agent-runtime
- Headings:
  - H2: Type checking and linting
  - H2: Running Agent Runtime Tests
  - H2: Manual testing
  - H2: Clean slate reset
  - H2: References
  - H2: Related

## perplexity.md

- Route: /perplexity
- Headings:
  - H2: Related

## plan/codex-context-engine-harness.md

- Route: /plan/codex-context-engine-harness
- Headings:
  - H2: Status
  - H2: Goal
  - H2: Non-goals
  - H2: Current architecture
  - H2: Current gap
  - H2: Desired behavior
  - H2: Design constraints
  - H3: Codex app-server remains canonical for native thread state
  - H3: Context engine assembly must be projected into Codex inputs
  - H3: Prompt-cache stability matters
  - H3: Runtime selection semantics do not change
  - H2: Implementation plan
  - H3: 1. Export or relocate reusable context-engine attempt helpers
  - H3: 2. Add a Codex context projection helper
  - H3: 3. Wire bootstrap before Codex thread startup
  - H3: 4. Wire assemble before thread/start / thread/resume and turn/start
  - H3: 5. Preserve prompt-cache stable formatting
  - H3: 6. Wire post-turn after transcript mirroring
  - H3: 7. Normalize usage and prompt-cache runtime context
  - H3: 8. Compaction policy
  - H4: /compact and explicit OpenClaw compaction
  - H4: In-turn Codex native contextCompaction events
  - H3: 9. Session reset and binding behavior
  - H3: 10. Error handling
  - H2: Test plan
  - H3: Unit tests
  - H3: Existing tests to update
  - H3: Integration / live tests
  - H2: Observability
  - H2: Migration / compatibility
  - H2: Open questions
  - H2: Acceptance criteria

## plan/ui-channels.md

- Route: /plan/ui-channels
- Headings:
  - H2: Status
  - H2: Problem
  - H2: Goals
  - H2: Non goals
  - H2: Target model
  - H2: Delivery metadata
  - H2: Runtime capability contract
  - H2: Channel mapping
  - H2: Refactor steps
  - H2: Tests
  - H2: Open questions
  - H2: Related

## platforms/android.md

- Route: /platforms/android
- Headings:
  - H2: Support snapshot
  - H2: Install outside Google Play
  - H2: Mirror and control Android from a remote Mac
  - H3: Before you begin
  - H3: Enable ADB over TCP
  - H3: Allow only the controller Mac
  - H3: Connect and start mirroring
  - H3: Troubleshooting
  - H2: Connection runbook
  - H3: Prerequisites
  - H3: 1. Start the Gateway
  - H3: 2. Verify discovery (optional)
  - H4: Cross-network discovery via unicast DNS-SD
  - H3: 3. Connect from Android
  - H3: Multiple gateways
  - H3: Presence alive beacons
  - H3: 4. Approve pairing (CLI)
  - H3: 5. Verify the node is connected
  - H3: 6. Chat + history
  - H3: 7. Canvas + camera
  - H4: Gateway Canvas Host (recommended for web content)
  - H3: 8. Voice + expanded Android command surface
  - H3: 9. Workspace files (read-only)
  - H2: Assistant entrypoints
  - H2: Notification forwarding
  - H2: Related

## platforms/digitalocean.md

- Route: /platforms/digitalocean
- Headings:
  - H2: Related

## platforms/easyrunner.md

- Route: /platforms/easyrunner
- Headings:
  - H2: Before you begin
  - H2: Compose app
  - H2: Configure OpenClaw
  - H2: Verify
  - H2: Updates and backups
  - H2: Troubleshooting

## platforms/index.md

- Route: /platforms
- Headings:
  - H2: Choose your OS
  - H2: VPS and hosting
  - H2: Common links
  - H2: Gateway service install (CLI)
  - H2: Related

## platforms/ios.md

- Route: /platforms/ios
- Headings:
  - H2: What it does
  - H2: Requirements
  - H2: Quick start (pair + connect)
  - H2: Relay-backed push for official builds
  - H2: Background alive beacons
  - H2: Authentication and trust flow
  - H2: Discovery paths
  - H3: Bonjour (LAN)
  - H3: Tailnet (cross-network)
  - H3: Manual host/port
  - H2: Multiple gateways
  - H2: Canvas + A2UI
  - H2: Computer Use relationship
  - H3: Canvas eval / snapshot
  - H2: Voice wake + talk mode
  - H2: Common errors
  - H2: Related docs

## platforms/linux.md

- Route: /platforms/linux
- Headings:
  - H2: Quick path (VPS)
  - H2: Install
  - H2: Gateway service (systemd)
  - H2: Memory pressure and OOM kills
  - H2: Related

## platforms/mac/bundled-gateway.md

- Route: /platforms/mac/bundled-gateway
- Headings:
  - H2: Automatic setup
  - H2: Manual recovery
  - H2: Launchd (Gateway as LaunchAgent)
  - H2: Version compatibility
  - H2: State directory on macOS
  - H2: Debug app connectivity
  - H2: Smoke check
  - H2: Related

## platforms/mac/canvas.md

- Route: /platforms/mac/canvas
- Headings:
  - H2: Where Canvas lives
  - H2: Panel behavior
  - H2: Agent API surface
  - H2: A2UI in Canvas
  - H3: A2UI commands (v0.8)
  - H2: Triggering agent runs from Canvas
  - H2: Security notes
  - H2: Related

## platforms/mac/child-process.md

- Route: /platforms/mac/child-process
- Headings:
  - H2: Default behavior (launchd)
  - H2: Unsigned dev builds
  - H2: Attach-only mode
  - H2: Remote mode
  - H2: Why we prefer launchd
  - H2: Related

## platforms/mac/dev-setup.md

- Route: /platforms/mac/dev-setup
- Headings:
  - H1: macOS developer setup
  - H2: Prerequisites
  - H2: 1. Install dependencies
  - H2: 2. Build and package the app
  - H2: 3. Install the CLI and Gateway
  - H2: Troubleshooting
  - H3: Build fails: toolchain or SDK mismatch
  - H3: App crashes on permission grant
  - H3: Gateway "Starting..." indefinitely
  - H2: Related

## platforms/mac/health.md

- Route: /platforms/mac/health
- Headings:
  - H1: Health checks on macOS
  - H2: Menu bar
  - H2: Settings
  - H2: How the probe works
  - H2: When in doubt
  - H2: Related

## platforms/mac/icon.md

- Route: /platforms/mac/icon
- Headings:
  - H1: Menu Bar Icon States
  - H2: States
  - H2: Voice wake ears
  - H2: Shapes and sizes
  - H2: Behavioral notes
  - H2: Related

## platforms/mac/logging.md

- Route: /platforms/mac/logging
- Headings:
  - H1: Logging (macOS)
  - H2: Rolling diagnostics file log (Debug pane)
  - H2: Unified logging private data on macOS
  - H2: Enable for OpenClaw (ai.openclaw)
  - H2: Disable after debugging
  - H2: Related

## platforms/mac/menu-bar.md

- Route: /platforms/mac/menu-bar
- Headings:
  - H2: What is shown
  - H2: State model
  - H2: IconState enum (Swift)
  - H3: ActivityKind -&gt; badge symbol
  - H3: Visual mapping
  - H2: Context submenu
  - H2: Status row text (menu)
  - H2: Event ingestion
  - H2: Debug override
  - H2: Testing checklist
  - H2: Related

## platforms/mac/peekaboo.md

- Route: /platforms/mac/peekaboo
- Headings:
  - H2: What this is (and is not)
  - H2: Relationship to other desktop-control paths
  - H2: Enable the bridge
  - H2: Client discovery order
  - H2: Security and permissions
  - H2: Snapshot behavior (automation)
  - H2: Troubleshooting
  - H2: Related

## platforms/mac/permissions.md

- Route: /platforms/mac/permissions
- Headings:
  - H2: Requirements for stable permissions
  - H2: Accessibility grants for Node and CLI runtimes
  - H2: Recovery checklist when prompts disappear
  - H2: Files and folders permissions (Desktop/Documents/Downloads)
  - H2: Related

## platforms/mac/remote.md

- Route: /platforms/mac/remote
- Headings:
  - H2: Modes
  - H2: Remote transports
  - H2: Prereqs on the remote host
  - H2: macOS app setup
  - H2: Web Chat
  - H2: Permissions
  - H2: Security notes
  - H2: WhatsApp login flow (remote)
  - H2: Troubleshooting
  - H2: Notification sounds
  - H2: Related

## platforms/mac/signing.md

- Route: /platforms/mac/signing
- Headings:
  - H1: mac signing (debug builds)
  - H2: Usage
  - H3: Ad-hoc signing note
  - H2: Build metadata for About
  - H2: Related

## platforms/mac/skills.md

- Route: /platforms/mac/skills
- Headings:
  - H2: Data source
  - H2: Install actions
  - H2: Env/API keys
  - H2: Remote mode
  - H2: Related

## platforms/mac/voice-overlay.md

- Route: /platforms/mac/voice-overlay
- Headings:
  - H1: Voice Overlay Lifecycle (macOS)
  - H2: Behavior
  - H2: Implementation
  - H2: Logging
  - H2: Debugging checklist
  - H2: Related

## platforms/mac/voicewake.md

- Route: /platforms/mac/voicewake
- Headings:
  - H1: Voice Wake &amp; Push-to-Talk
  - H2: Requirements
  - H2: Modes
  - H2: Runtime behavior (wake-word)
  - H2: Lifecycle invariants
  - H2: Push-to-talk specifics
  - H2: User-facing settings
  - H2: Forwarding behavior
  - H2: Forwarding payload
  - H2: Quick verification
  - H2: Related

## platforms/mac/webchat.md

- Route: /platforms/mac/webchat
- Headings:
  - H2: Launch and debugging
  - H2: How it is wired
  - H2: Security surface
  - H2: Known limitations
  - H2: Related

## platforms/mac/xpc.md

- Route: /platforms/mac/xpc
- Headings:
  - H1: OpenClaw macOS IPC architecture
  - H2: Goals
  - H2: How it works
  - H3: Gateway + node transport
  - H3: Node service + app IPC
  - H3: PeekabooBridge (UI automation)
  - H2: Operational flows
  - H2: Hardening notes
  - H2: Related

## platforms/macos.md

- Route: /platforms/macos
- Headings:
  - H2: Download
  - H2: First run
  - H2: Choose a Gateway mode
  - H2: What the app owns
  - H2: macOS detail pages
  - H2: Related

## platforms/oracle.md

- Route: /platforms/oracle
- Headings:
  - H2: Related

## platforms/raspberry-pi.md

- Route: /platforms/raspberry-pi
- Headings:
  - H2: Related

## platforms/windows.md

- Route: /platforms/windows
- Headings:
  - H2: Recommended: Windows Hub
  - H3: What Windows Hub includes
  - H3: First launch
  - H2: Windows node mode
  - H2: Local MCP mode
  - H2: Native Windows CLI and Gateway
  - H2: WSL2 Gateway
  - H2: Gateway auto-start before Windows login
  - H2: Expose WSL services over LAN
  - H2: Troubleshooting
  - H3: The tray icon does not appear
  - H3: Local setup fails
  - H3: The app says pairing is required
  - H3: Web chat cannot reach a remote Gateway
  - H3: screen.snapshot, camera, or audio commands fail
  - H3: Git or GitHub connectivity fails
  - H2: Related

## plugins/adding-capabilities.md

- Route: /plugins/adding-capabilities
- Headings:
  - H2: When to create a capability
  - H2: The standard sequence
  - H2: What goes where
  - H2: Provider and harness seams
  - H2: File checklist
  - H2: Worked example: image generation
  - H2: Embedding providers
  - H2: Review checklist
  - H2: Related

## plugins/admin-http-rpc.md

- Route: /plugins/admin-http-rpc
- Headings:
  - H2: Before you enable it
  - H2: Enable
  - H2: Verify the route
  - H2: Authentication
  - H2: Security model
  - H2: Request
  - H2: Response
  - H2: Allowed methods
  - H2: WebSocket comparison
  - H2: Troubleshooting
  - H2: Related

## plugins/agent-tools.md

- Route: /plugins/agent-tools
- Headings:
  - H2: Related

## plugins/architecture-internals.md

- Route: /plugins/architecture-internals
- Headings:
  - H2: Load pipeline
  - H3: Manifest-first behavior
  - H3: Plugin cache boundary
  - H2: Registry model
  - H2: Conversation binding callbacks
  - H2: Provider runtime hooks
  - H3: Hook order and usage
  - H3: Provider example
  - H3: Built-in examples
  - H2: Runtime helpers
  - H3: api.runtime.imageGeneration
  - H2: Gateway HTTP routes
  - H2: Plugin SDK import paths
  - H2: Message tool schemas
  - H2: Channel target resolution
  - H2: Config-backed directories
  - H2: Provider catalogs
  - H2: Read-only channel inspection
  - H2: Package packs
  - H3: Channel catalog metadata
  - H2: Context engine plugins
  - H2: Adding a new capability
  - H3: Capability checklist
  - H3: Capability template
  - H2: Related

## plugins/architecture.md

- Route: /plugins/architecture
- Headings:
  - H2: Public capability model
  - H3: External compatibility stance
  - H3: Plugin shapes
  - H3: Legacy hooks
  - H3: Compatibility signals
  - H2: Architecture overview
  - H3: Plugin metadata snapshot and lookup table
  - H3: Activation planning
  - H3: Channel plugins and the shared message tool
  - H2: Capability ownership model
  - H3: Capability layering
  - H3: Multi-capability company plugin example
  - H3: Capability example: video understanding
  - H2: Contracts and enforcement
  - H3: What belongs in a contract
  - H2: Execution model
  - H2: Export boundary
  - H2: Internals and reference
  - H2: Related

## plugins/building-extensions.md

- Route: /plugins/building-extensions
- Headings:
  - H2: Related

## plugins/building-plugins.md

- Route: /plugins/building-plugins
- Headings:
  - H2: Requirements
  - H2: Choose the plugin shape
  - H2: Quickstart
  - H2: Registering tools
  - H2: Import conventions
  - H2: Pre-submission checklist
  - H2: Test against beta releases
  - H2: Next steps
  - H2: Related

## plugins/bundles.md

- Route: /plugins/bundles
- Headings:
  - H2: Why bundles exist
  - H2: Install a bundle
  - H2: What OpenClaw maps from bundles
  - H3: Supported now
  - H4: Skill content
  - H4: Hook packs
  - H4: MCP for embedded OpenClaw
  - H4: Embedded OpenClaw settings
  - H4: Embedded OpenClaw LSP
  - H3: Detected but not executed
  - H2: Bundle formats
  - H2: Detection precedence
  - H2: Runtime dependencies and cleanup
  - H2: Security
  - H2: Troubleshooting
  - H2: Related

## plugins/cli-backend-plugins.md

- Route: /plugins/cli-backend-plugins
- Headings:
  - H2: What the plugin owns
  - H2: Minimal backend plugin
  - H2: Config shape
  - H2: Advanced backend hooks
  - H3: ownsNativeCompaction: opting out of OpenClaw compaction
  - H2: MCP tool bridge
  - H2: User configuration
  - H2: Verification
  - H2: Checklist
  - H2: Related

## plugins/codex-computer-use.md

- Route: /plugins/codex-computer-use
- Headings:
  - H2: OpenClaw.app and Peekaboo
  - H2: iOS app
  - H2: Direct cua-driver MCP
  - H2: Quick setup
  - H2: Commands
  - H2: Marketplace choices
  - H2: Bundled macOS marketplace
  - H2: Remote catalog limit
  - H2: Configuration reference
  - H2: What OpenClaw checks
  - H2: macOS permissions
  - H2: Troubleshooting
  - H2: Related

## plugins/codex-harness-reference.md

- Route: /plugins/codex-harness-reference
- Headings:
  - H2: Plugin config surface
  - H2: App-server transport
  - H2: Approval and sandbox modes
  - H2: Sandboxed native execution
  - H2: Auth and environment isolation
  - H2: Dynamic tools
  - H2: Timeouts
  - H2: Model discovery
  - H2: Workspace bootstrap files
  - H2: Environment overrides
  - H2: Related

## plugins/codex-harness-runtime.md

- Route: /plugins/codex-harness-runtime
- Headings:
  - H2: Overview
  - H2: Thread bindings and model changes
  - H2: Visible replies and heartbeats
  - H2: Hook boundaries
  - H2: V1 support contract
  - H2: Native permissions and MCP elicitations
  - H2: Queue steering
  - H2: Codex feedback upload
  - H2: Compaction and transcript mirror
  - H2: Media and delivery
  - H2: Related

## plugins/codex-harness.md

- Route: /plugins/codex-harness
- Headings:
  - H2: Requirements
  - H2: Quickstart
  - H2: Share threads with Codex Desktop and CLI
  - H2: Configuration
  - H3: Compaction
  - H2: Verify Codex runtime
  - H2: Routing and model selection
  - H2: Deployment patterns
  - H3: Basic Codex deployment
  - H3: Mixed provider deployment
  - H3: Fail-closed Codex deployment
  - H2: App-server policy
  - H2: Commands and diagnostics
  - H3: Inspect Codex threads locally
  - H3: Auth order
  - H3: Environment isolation
  - H3: Dynamic tools and web search
  - H3: Config fields
  - H3: Dynamic tool call timeouts
  - H3: Local testing env overrides
  - H2: Native Codex plugins
  - H2: Computer Use
  - H2: Runtime boundaries
  - H2: Troubleshooting
  - H2: Related

## plugins/codex-native-plugins.md

- Route: /plugins/codex-native-plugins
- Headings:
  - H2: Requirements
  - H2: Quickstart
  - H2: Manage plugins from chat
  - H2: How native plugin setup works
  - H2: V1 support boundary
  - H2: App inventory and ownership
  - H2: Connected account apps
  - H2: Thread app config
  - H2: Destructive action policy
  - H2: Troubleshooting
  - H2: Related

## plugins/community.md

- Route: /plugins/community
- Headings:
  - H2: Find plugins
  - H2: Publish plugins
  - H2: Related

## plugins/compatibility.md

- Route: /plugins/compatibility
- Headings:
  - H2: Compatibility registry
  - H2: Deprecation policy
  - H2: Current compatibility areas
  - H3: WhatsApp inbound callback flat aliases
  - H3: WhatsApp inbound admission fields
  - H2: Plugin inspector package
  - H3: Maintainer acceptance lane
  - H2: Release notes

## plugins/copilot.md

- Route: /plugins/copilot
- Headings:
  - H2: Requirements
  - H2: Install
  - H2: Quickstart
  - H2: Supported providers
  - H2: BYOK
  - H2: Auth
  - H2: Configuration surface
  - H2: Compaction
  - H2: Transcript mirroring
  - H2: Side questions (/btw)
  - H2: Doctor
  - H2: Limitations
  - H2: Permissions and askuser
  - H3: Session-level GitHub token
  - H2: Related

## plugins/dependency-resolution.md

- Route: /plugins/dependency-resolution
- Headings:
  - H2: Responsibility split
  - H2: Install roots
  - H2: Local plugins
  - H2: Startup and reload
  - H2: Bundled plugins
  - H2: Legacy cleanup

## plugins/google-meet.md

- Route: /plugins/google-meet
- Headings:
  - H2: Quick start
  - H3: Create a meeting
  - H3: Observe-only join
  - H3: Realtime session health
  - H2: Local Gateway + Parallels Chrome
  - H3: Common failure checks
  - H2: Install notes
  - H2: Transports
  - H3: Chrome
  - H3: Twilio
  - H2: OAuth and preflight
  - H3: Create Google credentials
  - H3: Mint the refresh token
  - H3: Verify OAuth with doctor
  - H3: Resolve, preflight, and read artifacts
  - H3: Live smoke test
  - H3: Create examples
  - H2: Config
  - H3: Defaults
  - H3: Optional overrides
  - H2: Tool
  - H2: Agent and bidi modes
  - H2: Live test checklist
  - H2: Troubleshooting
  - H3: Agent cannot see the Google Meet tool
  - H3: No connected Google Meet-capable node
  - H3: Browser opens but agent cannot join
  - H3: Meeting creation fails
  - H3: Agent joins but does not talk
  - H3: Twilio setup checks fail
  - H3: Twilio call starts but never enters the meeting
  - H2: Notes
  - H2: Related

## plugins/hooks.md

- Route: /plugins/hooks
- Headings:
  - H2: Quick start
  - H2: Hook catalog
  - H3: Channel pairing requests
  - H2: Debug runtime hooks
  - H2: Tool call policy
  - H3: Exec environment hook
  - H3: Tool result persistence
  - H2: Prompt and model hooks
  - H3: Session extensions and next-turn injections
  - H2: Message hooks
  - H2: Install hooks
  - H2: Gateway lifecycle
  - H2: Upcoming deprecations
  - H2: Related

## plugins/install-overrides.md

- Route: /plugins/install-overrides
- Headings:
  - H2: Environment
  - H2: Behavior
  - H2: Package E2E

## plugins/llama-cpp.md

- Route: /plugins/llama-cpp
- Headings:
  - H2: Configuration
  - H2: Native Runtime
  - H2: Troubleshooting

## plugins/logbook.md

- Route: /plugins/logbook
- Headings:
  - H2: Before you begin
  - H2: Quickstart
  - H2: How it works
  - H2: Model and data flow
  - H2: Configuration
  - H3: Vision model selection
  - H2: Dashboard tab
  - H2: Gateway methods
  - H2: Privacy notes
  - H2: Troubleshooting
  - H3: The Logbook tab is missing
  - H3: Capture reports an error
  - H3: Captures succeed but no cards appear
  - H2: Related

## plugins/manage-plugins.md

- Route: /plugins/manage-plugins
- Headings:
  - H2: List and search plugins
  - H2: Enable and disable plugins
  - H2: Install plugins
  - H2: Restart and inspect
  - H2: Update plugins
  - H2: Uninstall plugins
  - H2: Choose a source
  - H2: Publish plugins
  - H2: Related

## plugins/manifest.md

- Route: /plugins/manifest
- Headings:
  - H2: What this file does
  - H2: Minimal example
  - H2: Rich example
  - H2: Top-level field reference
  - H2: Generation provider metadata reference
  - H2: Tool metadata reference
  - H2: providerAuthChoices reference
  - H2: commandAliases reference
  - H2: activation reference
  - H2: qaRunners reference
  - H2: setup reference
  - H3: setup.providers reference
  - H3: setup fields
  - H2: uiHints reference
  - H2: contracts reference
  - H2: configContracts reference
  - H2: mediaUnderstandingProviderMetadata reference
  - H2: channelConfigs reference
  - H3: Replacing another channel plugin
  - H2: modelSupport reference
  - H2: modelCatalog reference
  - H2: modelIdNormalization reference
  - H2: providerEndpoints reference
  - H2: providerRequest reference
  - H2: secretProviderIntegrations reference
  - H2: modelPricing reference
  - H3: OpenClaw Provider Index
  - H2: Manifest versus package.json
  - H3: package.json fields that affect discovery
  - H2: Discovery precedence (duplicate plugin ids)
  - H2: JSON Schema requirements
  - H2: Validation behavior
  - H2: Notes
  - H2: Related

## plugins/memory-lancedb.md

- Route: /plugins/memory-lancedb
- Headings:
  - H2: Installation
  - H2: Quick start
  - H2: Embedding config
  - H3: Dimensions
  - H2: Ollama embeddings
  - H2: Recall and capture limits
  - H2: Commands
  - H2: Storage
  - H2: Runtime dependencies and platform support
  - H2: Troubleshooting
  - H3: Input length exceeds the context length
  - H3: Unsupported embedding model
  - H3: Plugin loads but no memories appear
  - H2: Related

## plugins/memory-wiki.md

- Route: /plugins/memory-wiki
- Headings:
  - H2: Vault modes
  - H2: Vault layout
  - H2: Open Knowledge Format imports
  - H2: Structured claims and evidence
  - H2: Agent-facing entity metadata
  - H2: Compile pipeline
  - H2: Dashboards and health reports
  - H2: Search and retrieval
  - H2: Agent tools
  - H2: Prompt and context behavior
  - H2: Configuration
  - H3: Example: QMD + bridge mode
  - H2: CLI
  - H2: Obsidian support
  - H2: Recommended workflow
  - H2: Related docs

## plugins/message-presentation.md

- Route: /plugins/message-presentation
- Headings:
  - H2: Contract
  - H2: Producer examples
  - H2: Renderer contract
  - H2: Core render flow
  - H2: Degradation rules
  - H3: Button value fallback visibility
  - H2: Provider mapping
  - H2: Presentation vs InteractiveReply
  - H2: Delivery pin
  - H2: Plugin author checklist
  - H2: Related docs

## plugins/oc-path.md

- Route: /plugins/oc-path
- Headings:
  - H2: Why enable it
  - H2: Where it runs
  - H2: Enable
  - H2: Dependencies
  - H2: What it provides
  - H2: Relationship to other plugins
  - H2: Safety
  - H2: Related

## plugins/plugin-inventory.md

- Route: /plugins/plugin-inventory
- Headings:
  - H1: Plugin inventory
  - H2: Definitions
  - H2: Install a plugin
  - H2: Core npm package
  - H2: Official external packages
  - H2: Source checkout only

## plugins/plugin-permission-requests.md

- Route: /plugins/plugin-permission-requests
- Headings:
  - H2: Choose the right gate
  - H2: Request approval before a tool call
  - H2: Decision behavior
  - H2: Route approval prompts
  - H2: Codex native permissions
  - H2: Troubleshooting
  - H2: Related

## plugins/reference.md

- Route: /plugins/reference
- Headings:
  - H1: Plugin reference

## plugins/reference/acpx.md

- Route: /plugins/reference/acpx
- Headings:
  - H1: ACPx plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/admin-http-rpc.md

- Route: /plugins/reference/admin-http-rpc
- Headings:
  - H1: Admin Http Rpc plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/alibaba.md

- Route: /plugins/reference/alibaba
- Headings:
  - H1: Alibaba plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/amazon-bedrock-mantle.md

- Route: /plugins/reference/amazon-bedrock-mantle
- Headings:
  - H1: Amazon Bedrock Mantle plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/amazon-bedrock.md

- Route: /plugins/reference/amazon-bedrock
- Headings:
  - H1: Amazon Bedrock plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/anthropic-vertex.md

- Route: /plugins/reference/anthropic-vertex
- Headings:
  - H1: Anthropic Vertex plugin
  - H2: Distribution
  - H2: Surface
  - H2: Claude Fable 5
  - H2: Claude Sonnet 5

## plugins/reference/anthropic.md

- Route: /plugins/reference/anthropic
- Headings:
  - H1: Anthropic plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/arcee.md

- Route: /plugins/reference/arcee
- Headings:
  - H1: Arcee plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/azure-speech.md

- Route: /plugins/reference/azure-speech
- Headings:
  - H1: Azure Speech plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/bonjour.md

- Route: /plugins/reference/bonjour
- Headings:
  - H1: Bonjour plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/brave.md

- Route: /plugins/reference/brave
- Headings:
  - H1: Brave plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/browser.md

- Route: /plugins/reference/browser
- Headings:
  - H1: Browser plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/byteplus.md

- Route: /plugins/reference/byteplus
- Headings:
  - H1: BytePlus plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/canvas.md

- Route: /plugins/reference/canvas
- Headings:
  - H1: Canvas plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/cerebras.md

- Route: /plugins/reference/cerebras
- Headings:
  - H1: Cerebras plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/chutes.md

- Route: /plugins/reference/chutes
- Headings:
  - H1: Chutes plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/clawrouter.md

- Route: /plugins/reference/clawrouter
- Headings:
  - H1: ClawRouter plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/clickclack.md

- Route: /plugins/reference/clickclack
- Headings:
  - H1: Clickclack plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/cloudflare-ai-gateway.md

- Route: /plugins/reference/cloudflare-ai-gateway
- Headings:
  - H1: Cloudflare AI Gateway plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/codex-supervisor.md

- Route: /plugins/reference/codex-supervisor
- Headings:
  - H1: Codex Supervisor plugin
  - H2: Distribution
  - H2: Surface
  - H2: Session Listing

## plugins/reference/codex.md

- Route: /plugins/reference/codex
- Headings:
  - H1: Codex plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/cohere.md

- Route: /plugins/reference/cohere
- Headings:
  - H1: Cohere plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/comfy.md

- Route: /plugins/reference/comfy
- Headings:
  - H1: ComfyUI plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/copilot-proxy.md

- Route: /plugins/reference/copilot-proxy
- Headings:
  - H1: Copilot Proxy plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/copilot.md

- Route: /plugins/reference/copilot
- Headings:
  - H1: Copilot plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/deepgram.md

- Route: /plugins/reference/deepgram
- Headings:
  - H1: Deepgram plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/deepinfra.md

- Route: /plugins/reference/deepinfra
- Headings:
  - H1: DeepInfra plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/deepseek.md

- Route: /plugins/reference/deepseek
- Headings:
  - H1: DeepSeek plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/diagnostics-otel.md

- Route: /plugins/reference/diagnostics-otel
- Headings:
  - H1: Diagnostics OpenTelemetry plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/diagnostics-prometheus.md

- Route: /plugins/reference/diagnostics-prometheus
- Headings:
  - H1: Diagnostics Prometheus plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/diffs-language-pack.md

- Route: /plugins/reference/diffs-language-pack
- Headings:
  - H1: Diffs Language Pack plugin
  - H2: Distribution
  - H2: Surface
  - H2: Added languages

## plugins/reference/diffs.md

- Route: /plugins/reference/diffs
- Headings:
  - H1: Diffs plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/discord.md

- Route: /plugins/reference/discord
- Headings:
  - H1: Discord plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/document-extract.md

- Route: /plugins/reference/document-extract
- Headings:
  - H1: Document Extract plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/duckduckgo.md

- Route: /plugins/reference/duckduckgo
- Headings:
  - H1: DuckDuckGo plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/elevenlabs.md

- Route: /plugins/reference/elevenlabs
- Headings:
  - H1: Elevenlabs plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/exa.md

- Route: /plugins/reference/exa
- Headings:
  - H1: Exa plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/fal.md

- Route: /plugins/reference/fal
- Headings:
  - H1: fal plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/featherless.md

- Route: /plugins/reference/featherless
- Headings:
  - H1: Featherless plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/feishu.md

- Route: /plugins/reference/feishu
- Headings:
  - H1: Feishu plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/file-transfer.md

- Route: /plugins/reference/file-transfer
- Headings:
  - H1: File Transfer plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/firecrawl.md

- Route: /plugins/reference/firecrawl
- Headings:
  - H1: Firecrawl plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/fireworks.md

- Route: /plugins/reference/fireworks
- Headings:
  - H1: Fireworks plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/github-copilot.md

- Route: /plugins/reference/github-copilot
- Headings:
  - H1: GitHub Copilot plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/gmi.md

- Route: /plugins/reference/gmi
- Headings:
  - H1: Gmi plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/google-meet.md

- Route: /plugins/reference/google-meet
- Headings:
  - H1: Google Meet plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/google.md

- Route: /plugins/reference/google
- Headings:
  - H1: Google plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/googlechat.md

- Route: /plugins/reference/googlechat
- Headings:
  - H1: Google Chat plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/gradium.md

- Route: /plugins/reference/gradium
- Headings:
  - H1: Gradium plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/groq.md

- Route: /plugins/reference/groq
- Headings:
  - H1: Groq plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/huggingface.md

- Route: /plugins/reference/huggingface
- Headings:
  - H1: Hugging Face plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/imessage.md

- Route: /plugins/reference/imessage
- Headings:
  - H1: iMessage plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/inworld.md

- Route: /plugins/reference/inworld
- Headings:
  - H1: Inworld plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/irc.md

- Route: /plugins/reference/irc
- Headings:
  - H1: IRC plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/kilocode.md

- Route: /plugins/reference/kilocode
- Headings:
  - H1: Kilocode plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/kimi.md

- Route: /plugins/reference/kimi
- Headings:
  - H1: Kimi plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/line.md

- Route: /plugins/reference/line
- Headings:
  - H1: LINE plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/litellm.md

- Route: /plugins/reference/litellm
- Headings:
  - H1: LiteLLM plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/llama-cpp.md

- Route: /plugins/reference/llama-cpp
- Headings:
  - H1: Llama Cpp plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/llm-task.md

- Route: /plugins/reference/llm-task
- Headings:
  - H1: LLM Task plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/lmstudio.md

- Route: /plugins/reference/lmstudio
- Headings:
  - H1: LM Studio plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/lobster.md

- Route: /plugins/reference/lobster
- Headings:
  - H1: Lobster plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/logbook.md

- Route: /plugins/reference/logbook
- Headings:
  - H1: Logbook plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/longcat.md

- Route: /plugins/reference/longcat
- Headings:
  - H1: LongCat plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/matrix.md

- Route: /plugins/reference/matrix
- Headings:
  - H1: Matrix plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/mattermost.md

- Route: /plugins/reference/mattermost
- Headings:
  - H1: Mattermost plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/memory-core.md

- Route: /plugins/reference/memory-core
- Headings:
  - H1: Memory Core plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/memory-lancedb.md

- Route: /plugins/reference/memory-lancedb
- Headings:
  - H1: Memory Lancedb plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/memory-wiki.md

- Route: /plugins/reference/memory-wiki
- Headings:
  - H1: Memory Wiki plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/microsoft-foundry.md

- Route: /plugins/reference/microsoft-foundry
- Headings:
  - H1: Microsoft Foundry plugin
  - H2: Distribution
  - H2: Surface
  - H2: Requirements
  - H2: Chat models
  - H2: MAI image generation
  - H2: Troubleshooting

## plugins/reference/microsoft.md

- Route: /plugins/reference/microsoft
- Headings:
  - H1: Microsoft plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/migrate-claude.md

- Route: /plugins/reference/migrate-claude
- Headings:
  - H1: Migrate Claude plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/migrate-hermes.md

- Route: /plugins/reference/migrate-hermes
- Headings:
  - H1: Migrate Hermes plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/minimax.md

- Route: /plugins/reference/minimax
- Headings:
  - H1: MiniMax plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/mistral.md

- Route: /plugins/reference/mistral
- Headings:
  - H1: Mistral plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/moonshot.md

- Route: /plugins/reference/moonshot
- Headings:
  - H1: Moonshot plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/msteams.md

- Route: /plugins/reference/msteams
- Headings:
  - H1: Microsoft Teams plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/nextcloud-talk.md

- Route: /plugins/reference/nextcloud-talk
- Headings:
  - H1: Nextcloud Talk plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/nostr.md

- Route: /plugins/reference/nostr
- Headings:
  - H1: Nostr plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/novita.md

- Route: /plugins/reference/novita
- Headings:
  - H1: Novita plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/nvidia.md

- Route: /plugins/reference/nvidia
- Headings:
  - H1: NVIDIA plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/oc-path.md

- Route: /plugins/reference/oc-path
- Headings:
  - H1: Oc Path plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/ollama.md

- Route: /plugins/reference/ollama
- Headings:
  - H1: Ollama plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/open-prose.md

- Route: /plugins/reference/open-prose
- Headings:
  - H1: Open Prose plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/openai.md

- Route: /plugins/reference/openai
- Headings:
  - H1: OpenAI plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/opencode-go.md

- Route: /plugins/reference/opencode-go
- Headings:
  - H1: OpenCode Go plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/opencode.md

- Route: /plugins/reference/opencode
- Headings:
  - H1: OpenCode plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/openrouter.md

- Route: /plugins/reference/openrouter
- Headings:
  - H1: OpenRouter plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/openshell.md

- Route: /plugins/reference/openshell
- Headings:
  - H1: Openshell plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/perplexity.md

- Route: /plugins/reference/perplexity
- Headings:
  - H1: Perplexity plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/pixverse.md

- Route: /plugins/reference/pixverse
- Headings:
  - H1: PixVerse plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/policy.md

- Route: /plugins/reference/policy
- Headings:
  - H1: Policy plugin
  - H2: Distribution
  - H2: Surface
  - H2: Behavior
  - H2: Related docs

## plugins/reference/qa-channel.md

- Route: /plugins/reference/qa-channel
- Headings:
  - H1: QA Channel plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/qa-lab.md

- Route: /plugins/reference/qa-lab
- Headings:
  - H1: QA Lab plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/qa-matrix.md

- Route: /plugins/reference/qa-matrix
- Headings:
  - H1: QA Matrix plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/qianfan.md

- Route: /plugins/reference/qianfan
- Headings:
  - H1: Qianfan plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/qqbot.md

- Route: /plugins/reference/qqbot
- Headings:
  - H1: QQ Bot plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/qwen.md

- Route: /plugins/reference/qwen
- Headings:
  - H1: Qwen plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/raft.md

- Route: /plugins/reference/raft
- Headings:
  - H1: Raft plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/runway.md

- Route: /plugins/reference/runway
- Headings:
  - H1: Runway plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/searxng.md

- Route: /plugins/reference/searxng
- Headings:
  - H1: SearXNG plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/senseaudio.md

- Route: /plugins/reference/senseaudio
- Headings:
  - H1: Senseaudio plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/sglang.md

- Route: /plugins/reference/sglang
- Headings:
  - H1: SGLang plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/signal.md

- Route: /plugins/reference/signal
- Headings:
  - H1: Signal plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/slack.md

- Route: /plugins/reference/slack
- Headings:
  - H1: Slack plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/sms.md

- Route: /plugins/reference/sms
- Headings:
  - H1: Sms plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/stepfun.md

- Route: /plugins/reference/stepfun
- Headings:
  - H1: StepFun plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/synology-chat.md

- Route: /plugins/reference/synology-chat
- Headings:
  - H1: Synology Chat plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/synthetic.md

- Route: /plugins/reference/synthetic
- Headings:
  - H1: Synthetic plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/tavily.md

- Route: /plugins/reference/tavily
- Headings:
  - H1: Tavily plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/telegram.md

- Route: /plugins/reference/telegram
- Headings:
  - H1: Telegram plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/tencent.md

- Route: /plugins/reference/tencent
- Headings:
  - H1: Tencent plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/tlon.md

- Route: /plugins/reference/tlon
- Headings:
  - H1: Tlon plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/together.md

- Route: /plugins/reference/together
- Headings:
  - H1: Together plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/tokenjuice.md

- Route: /plugins/reference/tokenjuice
- Headings:
  - H1: Tokenjuice plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/tts-local-cli.md

- Route: /plugins/reference/tts-local-cli
- Headings:
  - H1: TTS Local CLI plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/twitch.md

- Route: /plugins/reference/twitch
- Headings:
  - H1: Twitch plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/venice.md

- Route: /plugins/reference/venice
- Headings:
  - H1: Venice plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/vercel-ai-gateway.md

- Route: /plugins/reference/vercel-ai-gateway
- Headings:
  - H1: Vercel AI Gateway plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/vllm.md

- Route: /plugins/reference/vllm
- Headings:
  - H1: vLLM plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/voice-call.md

- Route: /plugins/reference/voice-call
- Headings:
  - H1: Voice Call plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/volcengine.md

- Route: /plugins/reference/volcengine
- Headings:
  - H1: Volcengine plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/voyage.md

- Route: /plugins/reference/voyage
- Headings:
  - H1: Voyage plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/vydra.md

- Route: /plugins/reference/vydra
- Headings:
  - H1: Vydra plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/web-readability.md

- Route: /plugins/reference/web-readability
- Headings:
  - H1: Web Readability plugin
  - H2: Distribution
  - H2: Surface

## plugins/reference/webhooks.md

- Route: /plugins/reference/webhooks
- Headings:
  - H1: Webhooks plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/whatsapp.md

- Route: /plugins/reference/whatsapp
- Headings:
  - H1: WhatsApp plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/workboard.md

- Route: /plugins/reference/workboard
- Headings:
  - H1: Workboard plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/xai.md

- Route: /plugins/reference/xai
- Headings:
  - H1: xAI plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/xiaomi.md

- Route: /plugins/reference/xiaomi
- Headings:
  - H1: Xiaomi plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/zai.md

- Route: /plugins/reference/zai
- Headings:
  - H1: Z.AI plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/zalo.md

- Route: /plugins/reference/zalo
- Headings:
  - H1: Zalo plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/reference/zalouser.md

- Route: /plugins/reference/zalouser
- Headings:
  - H1: Zalo Personal plugin
  - H2: Distribution
  - H2: Surface
  - H2: Related docs

## plugins/sdk-agent-harness.md

- Route: /plugins/sdk-agent-harness
- Headings:
  - H2: When to use a harness
  - H2: What core still owns
  - H2: Register a harness
  - H2: Selection policy
  - H2: Provider plus harness pairing
  - H3: Tool-result middleware
  - H3: Terminal outcome classification
  - H3: Agent-end side effects
  - H3: User input and tool surfaces
  - H3: Native Codex harness mode
  - H2: Runtime strictness
  - H2: Native sessions and transcript mirror
  - H2: Tool and media results
  - H2: Current limitations
  - H2: Related

## plugins/sdk-channel-inbound.md

- Route: /plugins/sdk-channel-inbound
- Headings:
  - H2: Core helpers
  - H2: Migration

## plugins/sdk-channel-ingress.md

- Route: /plugins/sdk-channel-ingress
- Headings:
  - H2: Runtime resolver
  - H2: Result
  - H2: Access groups
  - H2: Event modes
  - H2: Routes and activation
  - H2: Redaction
  - H2: Verification

## plugins/sdk-channel-message.md

- Route: /plugins/sdk-channel-message
- Headings: none

## plugins/sdk-channel-outbound.md

- Route: /plugins/sdk-channel-outbound
- Headings:
  - H2: Adapter
  - H2: Delivery Evidence
  - H2: Existing outbound adapters
  - H2: Durable sends
  - H2: Compatibility dispatch

## plugins/sdk-channel-plugins.md

- Route: /plugins/sdk-channel-plugins
- Headings:
  - H2: What your plugin owns
  - H2: Message adapter
  - H3: Inbound ingress (experimental)
  - H3: Typing indicators
  - H3: Media source params
  - H3: Native payload shaping
  - H3: Session conversation grammar
  - H2: Approvals and channel capabilities
  - H3: Approval auth
  - H3: Payload lifecycle and setup guidance
  - H3: Native approval delivery
  - H3: Narrower approval runtime subpaths
  - H3: Setup subpaths
  - H3: Other narrow channel subpaths
  - H2: Inbound mention policy
  - H2: Walkthrough
  - H2: File structure
  - H2: Advanced topics
  - H2: Next steps
  - H2: Related

## plugins/sdk-channel-turn.md

- Route: /plugins/sdk-channel-turn
- Headings: none

## plugins/sdk-entrypoints.md

- Route: /plugins/sdk-entrypoints
- Headings:
  - H2: Package entries
  - H2: defineToolPlugin
  - H2: definePluginEntry
  - H2: defineChannelPluginEntry
  - H2: defineSetupPluginEntry
  - H2: Registration mode
  - H2: Plugin shapes
  - H2: Related

## plugins/sdk-migration.md

- Route: /plugins/sdk-migration
- Headings:
  - H2: What changed
  - H3: Why
  - H2: Compatibility policy
  - H2: How to migrate
  - H2: Import path reference
  - H2: Active deprecations
  - H2: Talk and realtime voice migration
  - H2: Removal timeline
  - H2: Suppressing the warnings temporarily
  - H2: Related

## plugins/sdk-overview.md

- Route: /plugins/sdk-overview
- Headings:
  - H2: Import convention
  - H2: Subpath reference
  - H2: Registration API
  - H3: Capability registration
  - H3: Tools and commands
  - H3: Infrastructure
  - H3: Host hooks for workflow plugins
  - H3: Gateway discovery registration
  - H3: CLI registration metadata
  - H3: CLI backend registration
  - H3: Exclusive slots
  - H3: Deprecated memory embedding adapters
  - H3: Events and lifecycle
  - H3: Hook decision semantics
  - H3: API object fields
  - H2: Internal module convention
  - H2: Related

## plugins/sdk-provider-plugins.md

- Route: /plugins/sdk-provider-plugins
- Headings:
  - H2: Walkthrough
  - H2: Publish to ClawHub
  - H2: File structure
  - H2: Catalog order reference
  - H2: Next steps
  - H2: Related

## plugins/sdk-runtime.md

- Route: /plugins/sdk-runtime
- Headings:
  - H2: Config loading and writes
  - H2: Reusable runtime utilities
  - H2: Runtime namespaces
  - H2: Storing runtime references
  - H2: Other top-level api fields
  - H2: Related

## plugins/sdk-setup.md

- Route: /plugins/sdk-setup
- Headings:
  - H2: Package metadata
  - H3: openclaw fields
  - H3: openclaw.channel
  - H3: openclaw.install
  - H3: Deferred full load
  - H2: Plugin manifest
  - H2: ClawHub publishing
  - H2: Setup entry
  - H3: Narrow setup helper imports
  - H3: Channel-owned single-account promotion
  - H2: Config schema
  - H3: Building channel config schemas
  - H2: Setup wizards
  - H2: Publishing and installing
  - H2: Related

## plugins/sdk-subpaths.md

- Route: /plugins/sdk-subpaths
- Headings:
  - H2: Plugin entry
  - H3: Deprecated compatibility and test helpers
  - H3: Reserved bundled plugin helper subpaths
  - H2: Related

## plugins/sdk-testing.md

- Route: /plugins/sdk-testing
- Headings:
  - H2: Test utilities
  - H3: Available exports
  - H3: Types
  - H2: Testing target resolution
  - H2: Testing patterns
  - H3: Testing registration contracts
  - H3: Testing runtime config access
  - H3: Unit testing a channel plugin
  - H3: Unit testing a provider plugin
  - H3: Mocking the plugin runtime
  - H3: Testing with per-instance stubs
  - H2: Contract tests (in-repo plugins)
  - H3: Running scoped tests
  - H2: Lint enforcement (in-repo plugins)
  - H2: Test configuration
  - H2: Related

## plugins/tool-plugins.md

- Route: /plugins/tool-plugins
- Headings:
  - H2: Requirements
  - H2: Quickstart
  - H2: Write a tool
  - H2: Optional and factory tools
  - H2: Return values
  - H2: Configuration
  - H2: Generated metadata
  - H2: Package metadata
  - H2: Validate in CI
  - H2: Install and inspect locally
  - H2: Publish
  - H2: Troubleshooting
  - H3: plugin entry not found: ./dist/index.js
  - H3: plugin entry does not expose defineToolPlugin metadata
  - H3: openclaw.plugin.json generated metadata is stale
  - H3: package.json openclaw.extensions must include ./dist/index.js
  - H3: Cannot find package 'typebox'
  - H3: Tool does not appear after install
  - H2: See also

## plugins/voice-call.md

- Route: /plugins/voice-call
- Headings:
  - H2: Quick start
  - H2: Configuration
  - H3: Config reference
  - H2: Session scope
  - H2: Realtime voice conversations
  - H3: Tool policy
  - H3: Agent voice context
  - H3: Realtime provider examples
  - H2: Streaming transcription
  - H3: Streaming provider examples
  - H2: TTS for calls
  - H3: TTS examples
  - H2: Inbound calls
  - H3: Per-number routing
  - H3: Spoken output contract
  - H3: Conversation startup behavior
  - H3: Twilio stream disconnect grace
  - H2: Stale call reaper
  - H2: Webhook security
  - H2: CLI
  - H2: Agent tool
  - H2: Gateway RPC
  - H2: Troubleshooting
  - H3: Setup fails webhook exposure
  - H3: Provider credentials fail
  - H3: Calls start but provider webhooks do not arrive
  - H3: Signature verification fails
  - H3: Google Meet Twilio joins fail
  - H3: Realtime call has no speech
  - H2: Related

## plugins/webhooks.md

- Route: /plugins/webhooks
- Headings:
  - H2: Configure routes
  - H2: Security model
  - H2: Request format
  - H2: Supported actions
  - H3: createflow
  - H3: runtask
  - H2: Response shape
  - H2: Related

## plugins/workboard.md

- Route: /plugins/workboard
- Headings:
  - H2: Enable it
  - H2: Configuration
  - H2: Card fields
  - H2: Starting work from a card
  - H2: Agent tools
  - H2: Dispatch
  - H3: Worker selection
  - H3: Entry points
  - H2: CLI and slash command
  - H2: Session lifecycle sync
  - H2: Dashboard workflow
  - H2: Diagnostics
  - H2: Permissions
  - H2: Storage
  - H2: Troubleshooting
  - H2: Related

## plugins/zalouser.md

- Route: /plugins/zalouser
- Headings:
  - H2: Naming
  - H2: Where it runs
  - H2: Install
  - H3: From npm
  - H3: From a local folder (dev)
  - H2: Config
  - H2: CLI
  - H2: Agent tool
  - H2: Related

## prose.md

- Route: /prose
- Headings:
  - H2: Install
  - H2: Slash command
  - H2: What it can do
  - H2: Example: parallel research and synthesis
  - H2: OpenClaw runtime mapping
  - H2: File locations
  - H2: State backends
  - H2: Security
  - H2: Related

## providers/alibaba.md

- Route: /providers/alibaba
- Headings:
  - H2: Getting started
  - H2: Built-in Wan models
  - H2: Capabilities and limits
  - H2: Advanced configuration
  - H2: Related

## providers/anthropic.md

- Route: /providers/anthropic
- Headings:
  - H2: Usage and cost tracking
  - H2: Getting started
  - H2: Thinking defaults (Claude Sonnet 5, Mythos 5, Fable 5, 4.8, and 4.6)
  - H2: Safety refusal fallback (Claude Fable 5)
  - H3: Why this exists
  - H3: How it works
  - H3: Observability and billing
  - H3: Scope
  - H2: Prompt caching
  - H2: Advanced configuration
  - H2: Troubleshooting
  - H2: Related

## providers/arcee.md

- Route: /providers/arcee
- Headings:
  - H2: Install plugin
  - H2: Getting started
  - H2: Non-interactive setup
  - H2: Built-in catalog
  - H2: Supported features
  - H2: Related

## providers/azure-speech.md

- Route: /providers/azure-speech
- Headings:
  - H2: Getting started
  - H2: Configuration options
  - H2: Notes
  - H2: Related

## providers/bedrock-mantle.md

- Route: /providers/bedrock-mantle
- Headings:
  - H2: Getting started
  - H2: Automatic model discovery
  - H3: Supported regions
  - H2: Manual configuration
  - H2: Advanced configuration
  - H2: Related

## providers/bedrock.md

- Route: /providers/bedrock
- Headings:
  - H2: Getting started
  - H2: Automatic model discovery
  - H2: Quick setup (AWS path)
  - H2: Advanced configuration
  - H2: Related

## providers/cerebras.md

- Route: /providers/cerebras
- Headings:
  - H2: Install plugin
  - H2: Getting started
  - H2: Non-interactive setup
  - H2: Built-in catalog
  - H2: Manual config
  - H2: Related

## providers/chutes.md

- Route: /providers/chutes
- Headings:
  - H2: Install plugin
  - H2: Getting started
  - H2: Discovery behavior
  - H2: Default aliases
  - H2: Built-in starter catalog
  - H2: Config example
  - H2: Related

## providers/claude-max-api-proxy.md

- Route: /providers/claude-max-api-proxy
- Headings:
  - H2: Why use this
  - H2: How it works
  - H2: Getting started
  - H2: Advanced configuration
  - H2: Notes
  - H2: Related

## providers/clawrouter.md

- Route: /providers/clawrouter
- Headings:
  - H2: Getting started
  - H2: Model discovery
  - H2: Protocol and provider plugins
  - H2: Quotas and usage
  - H2: Troubleshooting
  - H2: Security behavior
  - H2: Related

## providers/cloudflare-ai-gateway.md

- Route: /providers/cloudflare-ai-gateway
- Headings:
  - H2: Install plugin
  - H2: Getting started
  - H2: Non-interactive example
  - H2: Advanced configuration
  - H2: Related

## providers/cohere.md

- Route: /providers/cohere
- Headings:
  - H2: Get started
  - H2: Environment-only setup
  - H2: Related

## providers/comfy.md

- Route: /providers/comfy
- Headings:
  - H2: What it supports
  - H2: Getting started
  - H2: Configuration
  - H3: Shared keys
  - H3: Per-capability keys
  - H2: Workflow details
  - H2: Related

## providers/deepgram.md

- Route: /providers/deepgram
- Headings:
  - H2: Getting started
  - H2: Configuration options
  - H2: Voice Call streaming STT
  - H2: Notes
  - H2: Related

## providers/deepinfra.md

- Route: /providers/deepinfra
- Headings:
  - H2: Install plugin
  - H2: Get an API key
  - H2: CLI setup
  - H2: Config snippet
  - H2: Supported surfaces
  - H2: Available models
  - H2: Notes
  - H2: Related

## providers/deepseek.md

- Route: /providers/deepseek
- Headings:
  - H2: Install plugin
  - H2: Getting started
  - H2: Built-in catalog
  - H2: Thinking and tools
  - H2: Live testing
  - H2: Config example
  - H2: Related

## providers/ds4.md

- Route: /providers/ds4
- Headings:
  - H2: Requirements
  - H2: Quickstart
  - H2: Full config
  - H2: On-demand startup
  - H2: Think Max
  - H2: Test
  - H2: Troubleshooting
  - H2: Related

## providers/elevenlabs.md

- Route: /providers/elevenlabs
- Headings:
  - H2: Authentication
  - H2: Text-to-speech
  - H2: Speech-to-text
  - H2: Streaming STT
  - H2: Related

## providers/fal.md

- Route: /providers/fal
- Headings:
  - H2: Getting started
  - H2: Image generation
  - H2: Video generation
  - H2: Music generation
  - H2: Related

## providers/featherless.md

- Route: /providers/featherless
- Headings:
  - H2: Setup
  - H2: Default model
  - H2: Other Featherless models
  - H2: Troubleshooting
  - H2: Related

## providers/fireworks.md

- Route: /providers/fireworks
- Headings:
  - H2: Getting started
  - H2: Non-interactive setup
  - H2: Built-in catalog
  - H2: Custom Fireworks model ids
  - H2: Related

## providers/github-copilot.md

- Route: /providers/github-copilot
- Headings:
  - H2: Three ways to use Copilot in OpenClaw
  - H2: Optional flags
  - H2: Non-interactive onboarding
  - H2: Memory search embeddings
  - H3: Config
  - H3: How it works
  - H2: Related

## providers/gmi.md

- Route: /providers/gmi
- Headings:
  - H2: Setup
  - H2: When to choose GMI
  - H2: Models
  - H2: Troubleshooting
  - H2: Related

## providers/google.md

- Route: /providers/google
- Headings:
  - H2: Getting started
  - H2: Capabilities
  - H2: Web search
  - H2: Image generation
  - H2: Video generation
  - H2: Music generation
  - H2: Text-to-speech
  - H2: Realtime voice
  - H2: Advanced configuration
  - H2: Related

## providers/gradium.md

- Route: /providers/gradium
- Headings:
  - H2: Install plugin
  - H2: Setup
  - H2: Config
  - H2: Voices
  - H3: Per-message voice override
  - H2: Output
  - H2: Auto-select order
  - H2: Related

## providers/groq.md

- Route: /providers/groq
- Headings:
  - H2: Install plugin
  - H2: Getting started
  - H3: Config file example
  - H2: Built-in catalog
  - H2: Reasoning models
  - H2: Audio transcription
  - H2: Related

## providers/huggingface.md

- Route: /providers/huggingface
- Headings:
  - H2: Getting started
  - H3: Non-interactive setup
  - H2: Model IDs
  - H2: Advanced configuration
  - H2: Related

## providers/index.md

- Route: /providers
- Headings:
  - H2: Quick start
  - H2: Provider docs
  - H2: Shared overview pages
  - H2: Transcription providers
  - H2: Community tools

## providers/inferrs.md

- Route: /providers/inferrs
- Headings:
  - H2: Getting started
  - H2: Full config example
  - H2: On-demand startup
  - H2: Advanced configuration
  - H2: Troubleshooting
  - H2: Related

## providers/inworld.md

- Route: /providers/inworld
- Headings:
  - H2: Install plugin
  - H2: Getting started
  - H2: Configuration options
  - H2: Notes
  - H2: Related

## providers/kilocode.md

- Route: /providers/kilocode
- Headings:
  - H2: Install plugin
  - H2: Setup
  - H2: Default model and catalog
  - H2: Config example
  - H2: Behavior notes
  - H2: Related

## providers/litellm.md

- Route: /providers/litellm
- Headings:
  - H2: Quick start
  - H2: Configuration
  - H2: Image generation
  - H2: Advanced
  - H2: Related

## providers/lmstudio.md

- Route: /providers/lmstudio
- Headings:
  - H2: Quick start
  - H2: Non-interactive onboarding
  - H2: Configuration
  - H3: Streaming usage compatibility
  - H3: Thinking compatibility
  - H3: Explicit configuration
  - H3: Disabling preload
  - H3: LAN or tailnet host
  - H2: Troubleshooting
  - H3: LM Studio not detected
  - H3: Authentication errors (HTTP 401)
  - H2: Related

## providers/longcat.md

- Route: /providers/longcat
- Headings:
  - H2: Install plugin
  - H2: Getting started
  - H3: Non-interactive setup
  - H2: Reasoning behavior
  - H2: Pricing
  - H2: Self-hosted LongCat-2.0
  - H2: Troubleshooting
  - H2: Related

## providers/minimax.md

- Route: /providers/minimax
- Headings:
  - H2: Built-in catalog
  - H2: Getting started
  - H2: Configure via openclaw configure
  - H2: Capabilities
  - H3: Image generation
  - H3: Text-to-speech
  - H3: Music generation
  - H3: Video generation
  - H3: Image understanding
  - H3: Web search
  - H2: Advanced configuration
  - H2: Notes
  - H2: Troubleshooting
  - H2: Related

## providers/mistral.md

- Route: /providers/mistral
- Headings:
  - H2: Getting started
  - H2: Built-in LLM catalog
  - H2: Audio transcription (Voxtral)
  - H2: Voice Call streaming STT
  - H2: Advanced configuration
  - H2: Related

## providers/models.md

- Route: /providers/models
- Headings:
  - H2: Quick start (two steps)
  - H2: Supported providers (starter set)
  - H2: Additional provider variants
  - H2: Related

## providers/moonshot.md

- Route: /providers/moonshot
- Headings:
  - H2: Built-in model catalog
  - H2: Getting started
  - H2: Kimi web search
  - H2: Advanced configuration
  - H2: Related

## providers/novita.md

- Route: /providers/novita
- Headings:
  - H2: Setup
  - H2: Defaults
  - H2: Bundled model catalog
  - H2: When to choose Novita
  - H2: Troubleshooting
  - H2: Related

## providers/nvidia.md

- Route: /providers/nvidia
- Headings:
  - H2: Getting started
  - H2: Config example
  - H2: Featured catalog
  - H2: Nemotron 3 Ultra
  - H2: Bundled fallback catalog
  - H2: Advanced configuration
  - H2: Related

## providers/ollama-cloud.md

- Route: /providers/ollama-cloud
- Headings:
  - H2: Setup
  - H2: Defaults
  - H2: When to choose Ollama Cloud
  - H2: Models
  - H2: Live test
  - H2: Troubleshooting
  - H2: Related

## providers/ollama.md

- Route: /providers/ollama
- Headings:
  - H2: Auth rules
  - H2: Getting started
  - H2: Cloud models through a local host
  - H2: Model discovery (implicit provider)
  - H3: Smoke tests
  - H2: Node-local inference
  - H2: Vision and image description
  - H2: Configuration
  - H2: Common recipes
  - H3: Model selection
  - H3: Quick verification
  - H2: Ollama Web Search
  - H2: Advanced configuration
  - H2: Troubleshooting
  - H2: Related

## providers/openai.md

- Route: /providers/openai
- Headings:
  - H2: Usage and cost tracking
  - H2: Quick choice
  - H2: Naming map
  - H2: GPT-5.6 limited preview
  - H2: OpenClaw feature coverage
  - H2: Memory embeddings
  - H2: Getting started
  - H2: Native Codex app-server auth
  - H2: Image generation
  - H2: Video generation
  - H2: GPT-5 prompt contribution
  - H2: Voice and speech
  - H2: Azure OpenAI endpoints
  - H3: Configuration
  - H3: API version
  - H3: Model names are deployment names
  - H3: Regional availability
  - H3: Parameter differences
  - H2: Advanced configuration
  - H2: Related

## providers/opencode-go.md

- Route: /providers/opencode-go
- Headings:
  - H2: Getting started
  - H2: Config example
  - H2: Built-in catalog
  - H2: Advanced configuration
  - H2: Related

## providers/opencode.md

- Route: /providers/opencode
- Headings:
  - H2: Getting started
  - H2: Config example
  - H2: Built-in catalogs
  - H3: Zen
  - H3: Go
  - H2: Advanced configuration
  - H2: Related

## providers/openrouter.md

- Route: /providers/openrouter
- Headings:
  - H2: Getting started
  - H2: Config example
  - H2: Model references
  - H2: Image generation
  - H2: Video generation
  - H2: Music generation
  - H2: Text-to-speech
  - H2: Speech-to-text (inbound audio)
  - H2: Fusion router
  - H2: Authentication and headers
  - H2: Advanced configuration
  - H2: Related

## providers/perplexity-provider.md

- Route: /providers/perplexity-provider
- Headings:
  - H2: Install plugin
  - H2: Getting started
  - H2: Search modes
  - H2: Native API filtering
  - H2: Advanced configuration
  - H2: Related

## providers/pixverse.md

- Route: /providers/pixverse
- Headings:
  - H2: Getting started
  - H2: Supported modes and models
  - H2: Provider options
  - H2: Configuration
  - H2: Advanced configuration
  - H2: Related

## providers/qianfan.md

- Route: /providers/qianfan
- Headings:
  - H2: Install plugin
  - H2: Getting started
  - H2: Built-in catalog
  - H2: Config example
  - H2: Related

## providers/qwen-oauth.md

- Route: /providers/qwen-oauth
- Headings:
  - H2: Setup
  - H2: Defaults
  - H2: How this differs from Qwen
  - H2: Models
  - H2: Migration
  - H2: Troubleshooting
  - H2: Related

## providers/qwen.md

- Route: /providers/qwen
- Headings:
  - H2: Install plugin
  - H2: Getting started
  - H2: Plan types and endpoints
  - H2: Built-in catalog
  - H2: Thinking controls
  - H2: Multimodal add-ons
  - H2: Advanced configuration
  - H2: Related

## providers/runway.md

- Route: /providers/runway
- Headings:
  - H2: Getting started
  - H2: Supported modes and models
  - H2: Configuration
  - H2: Advanced configuration
  - H2: Related

## providers/senseaudio.md

- Route: /providers/senseaudio
- Headings:
  - H2: Getting started
  - H2: Options
  - H2: Related

## providers/sglang.md

- Route: /providers/sglang
- Headings:
  - H2: Getting started
  - H2: Model discovery (implicit provider)
  - H2: Explicit configuration (manual models)
  - H2: Advanced configuration
  - H2: Related

## providers/stepfun.md

- Route: /providers/stepfun
- Headings:
  - H2: Install plugin
  - H2: Region and endpoint overview
  - H2: Built-in catalog
  - H2: Getting started
  - H2: Advanced configuration
  - H2: Related

## providers/synthetic.md

- Route: /providers/synthetic
- Headings:
  - H2: Getting started
  - H2: Config example
  - H2: Built-in catalog
  - H2: Related

## providers/tencent.md

- Route: /providers/tencent
- Headings:
  - H2: Quick start
  - H2: Non-interactive setup
  - H2: Built-in catalog
  - H2: Advanced configuration
  - H2: Related

## providers/together.md

- Route: /providers/together
- Headings:
  - H2: Getting started
  - H3: Non-interactive example
  - H2: Built-in catalog
  - H2: Video generation
  - H2: Related

## providers/venice.md

- Route: /providers/venice
- Headings:
  - H2: Privacy modes
  - H2: Getting started
  - H2: Model selection
  - H2: Built-in catalog (38 models)
  - H2: Model discovery
  - H2: DeepSeek V4 replay behavior
  - H2: Streaming and tool support
  - H2: Pricing
  - H2: Usage examples
  - H2: Troubleshooting
  - H2: Advanced configuration
  - H2: Related

## providers/vercel-ai-gateway.md

- Route: /providers/vercel-ai-gateway
- Headings:
  - H2: Getting started
  - H2: Non-interactive example
  - H2: Model ID shorthand
  - H2: Advanced configuration
  - H2: Related

## providers/vllm.md

- Route: /providers/vllm
- Headings:
  - H2: Getting started
  - H2: Model discovery (implicit provider)
  - H2: Explicit configuration
  - H2: Advanced configuration
  - H2: Troubleshooting
  - H2: Related

## providers/volcengine.md

- Route: /providers/volcengine
- Headings:
  - H2: Getting started
  - H2: Providers and endpoints
  - H2: Built-in catalog
  - H2: Text-to-speech
  - H2: Advanced configuration
  - H2: Related

## providers/vydra.md

- Route: /providers/vydra
- Headings:
  - H2: Setup
  - H2: Capabilities
  - H2: Related

## providers/xai.md

- Route: /providers/xai
- Headings:
  - H2: Setup
  - H2: OAuth troubleshooting
  - H2: Built-in catalog
  - H2: Feature coverage
  - H3: Fast-mode mappings
  - H3: Legacy compatibility aliases
  - H2: Features
  - H2: Live testing
  - H2: Related

## providers/xiaomi.md

- Route: /providers/xiaomi
- Headings:
  - H2: Getting started
  - H2: Pay-as-you-go catalog
  - H2: Token Plan catalog
  - H2: Reasoning models
  - H2: Text-to-speech
  - H2: Config example
  - H2: Related

## providers/zai.md

- Route: /providers/zai
- Headings:
  - H2: GLM models
  - H2: Getting started
  - H3: Endpoints
  - H2: Config example
  - H2: Built-in catalog
  - H2: Thinking levels
  - H2: Advanced configuration
  - H2: Related

## refactor/access.md

- Route: /refactor/access
- Headings: none

## refactor/acp.md

- Route: /refactor/acp
- Headings:
  - H2: Goals
  - H2: Non-goals
  - H2: Target Model
  - H3: Gateway Instance Identity
  - H3: ACP Session Ownership
  - H3: ACPX Process Leases
  - H2: Lifecycle Controller
  - H2: Wrapper Contract
  - H2: Session Visibility Contract
  - H2: Migration Plan
  - H3: Phase 1: Add Identity And Leases
  - H3: Phase 2: Lease-First Cleanup
  - H3: Phase 3: Lease-First Startup Reaping
  - H3: Phase 4: Session Ownership Rows
  - H3: Phase 5: Remove Legacy Heuristics
  - H2: Tests
  - H2: Compatibility Notes
  - H2: Success Criteria

## refactor/canvas.md

- Route: /refactor/canvas
- Headings:
  - H1: Canvas plugin refactor
  - H2: Goal
  - H2: Non-goals
  - H2: Current branch state
  - H2: Target shape
  - H2: Migration steps
  - H2: Audit checklist
  - H2: Verification commands

## refactor/database-first.md

- Route: /refactor/database-first
- Headings:
  - H1: Database-First State Refactor
  - H2: Decision
  - H2: Hard Contract
  - H2: Goal state and progress
  - H3: Hard goal
  - H3: Goal states
  - H3: Current state
  - H3: Remaining work
  - H3: Do not regress
  - H2: Code-Read Assumptions
  - H2: Code-Read Findings
  - H2: Current Code Shape
  - H2: Target Schema Shape
  - H2: Doctor Migration Shape
  - H2: Migration Inventory
  - H2: Migration Plan
  - H3: Phase 0: Freeze The Boundary
  - H3: Phase 1: Finish The Global Control Plane
  - H3: Phase 2: Introduce Per-Agent Databases
  - H3: Phase 3: Replace Session Store APIs
  - H3: Phase 4: Move Transcripts, ACP Streams, Trajectories, And VFS
  - H3: Phase 5: Backup, Restore, Vacuum, And Verify
  - H3: Phase 6: Worker Runtime
  - H3: Phase 7: Delete The Old World
  - H2: Backup And Restore
  - H2: Runtime Refactor Plan
  - H2: Performance Rules
  - H2: Static Bans
  - H2: Done Criteria

## refactor/ingress-core.md

- Route: /refactor/ingress-core
- Headings:
  - H1: Ingress core deletion plan
  - H2: Budget
  - H2: Diagnosis
  - H2: Hotspots
  - H2: Current Code Read
  - H2: Boundary
  - H2: Acceptance Rule
  - H2: Work Packages
  - H2: Deletion Waves
  - H2: Do Not Move
  - H2: Verification
  - H2: Exit Criteria

## reference/AGENTS.default.md

- Route: /reference/AGENTS.default
- Headings:
  - H2: First run (recommended)
  - H2: Safety defaults
  - H2: Existing solutions preflight
  - H2: Session start (required)
  - H2: Soul (required)
  - H2: Shared spaces (recommended)
  - H2: Memory system (recommended)
  - H2: Tools and skills
  - H2: Backup tip (recommended)
  - H2: What OpenClaw does
  - H2: Core skills (enable in Settings → Skills)
  - H2: Usage notes
  - H2: Related

## reference/RELEASING.md

- Route: /reference/RELEASING
- Headings:
  - H2: Version naming
  - H2: Release cadence
  - H2: Monthly npm-only extended-stable publication
  - H2: Regular release operator checklist
  - H2: Stable main closeout
  - H2: Release preflight
  - H2: Release test boxes
  - H3: Vitest
  - H3: Docker
  - H3: QA Lab
  - H3: Package
  - H2: Regular release publish automation
  - H2: NPM workflow inputs
  - H2: Regular beta/latest stable release sequence
  - H2: Public references
  - H2: Related

## reference/api-usage-costs.md

- Route: /reference/api-usage-costs
- Headings:
  - H2: Where costs show up
  - H2: How keys are discovered
  - H2: Features that can spend keys
  - H3: Core model responses (chat + tools)
  - H3: Media understanding (audio/image/video)
  - H3: Image and video generation
  - H3: Memory embeddings and semantic search
  - H3: Web search tool
  - H3: Web fetch tool (Firecrawl)
  - H3: Provider usage snapshots (status/health)
  - H3: Compaction safeguard summarization
  - H3: Model scan / probe
  - H3: Talk (speech)
  - H3: Skills (third-party APIs)
  - H2: Related

## reference/application-modernization-plan.md

- Route: /reference/application-modernization-plan
- Headings:
  - H2: Goal
  - H2: Principles
  - H2: Phase 1: Baseline audit
  - H2: Phase 2: Product and UX cleanup
  - H2: Phase 3: Frontend architecture tightening
  - H2: Phase 4: Performance and reliability
  - H2: Phase 5: Type, contract, and test hardening
  - H2: Phase 6: Documentation and release readiness
  - H2: Recommended first slice
  - H2: Frontend skill update

## reference/code-mode.md

- Route: /reference/code-mode
- Headings:
  - H2: What it does
  - H2: Why use it
  - H2: Enable it
  - H2: Technical tour
  - H2: Runtime status
  - H2: Scope
  - H2: Terms
  - H2: Configuration
  - H2: Activation
  - H2: Model-visible tools
  - H2: exec
  - H2: wait
  - H2: Guest runtime API
  - H2: Internal namespaces
  - H3: Registry lifecycle
  - H3: Registration shape
  - H3: Ownership and visibility
  - H3: Scope serialization rules
  - H3: Prompts
  - H3: Cleanup
  - H3: Test checklist
  - H2: Output API
  - H2: Tool catalog
  - H2: Tool Search interaction
  - H2: Tool names and collisions
  - H2: Nested tool execution
  - H2: Run and snapshot lifecycle
  - H2: QuickJS-WASI runtime
  - H2: TypeScript
  - H2: Security boundary
  - H2: Error codes
  - H2: Telemetry
  - H2: Debugging
  - H2: Implementation layout
  - H2: Validation checklist
  - H2: E2E test plan
  - H2: Related

## reference/credits.md

- Route: /reference/credits
- Headings:
  - H2: Credits
  - H2: Core contributors
  - H2: License
  - H2: Related

## reference/device-models.md

- Route: /reference/device-models
- Headings:
  - H2: Data source
  - H2: Updating the database
  - H2: Related

## reference/full-release-validation.md

- Route: /reference/full-release-validation
- Headings:
  - H2: Top-level stages
  - H2: Release checks stages
  - H2: Docker release-path chunks
  - H2: Release profiles
  - H2: Full-only additions
  - H2: Focused reruns
  - H2: Evidence to keep
  - H2: Workflow files

## reference/memory-config.md

- Route: /reference/memory-config
- Headings:
  - H2: Provider selection
  - H3: Custom provider ids
  - H3: API key resolution
  - H2: Remote endpoint config
  - H2: Provider-specific config
  - H3: Inline embedding timeout
  - H2: Indexing behavior
  - H2: Hybrid search config
  - H3: Full example
  - H2: Additional memory paths
  - H2: Multimodal memory (Gemini)
  - H2: Embedding cache
  - H2: Batch indexing
  - H2: Session memory search (experimental)
  - H2: SQLite vector acceleration (sqlite-vec)
  - H2: Index storage
  - H2: QMD backend config
  - H3: mcporter integration
  - H3: Full QMD example
  - H2: Dreaming
  - H3: User settings
  - H3: Example
  - H2: Related

## reference/openclaw-ai.md

- Route: /reference/openclaw-ai
- Headings:
  - H2: Quick start
  - H2: Design contract
  - H2: Subpath exports

## reference/prompt-caching.md

- Route: /reference/prompt-caching
- Headings:
  - H2: Primary knobs
  - H3: cacheRetention
  - H3: contextPruning.mode: "cache-ttl"
  - H3: Heartbeat keep-warm
  - H2: Provider behavior
  - H3: Anthropic (direct API and Vertex AI)
  - H3: OpenAI (direct API)
  - H3: Amazon Bedrock
  - H3: OpenRouter
  - H3: Google Gemini (direct API)
  - H3: CLI-harness providers (Claude Code, Gemini CLI)
  - H3: Other providers
  - H2: System-prompt cache boundary
  - H2: OpenClaw cache-stability guards
  - H2: Tuning patterns
  - H3: Mixed traffic (recommended default)
  - H3: Cost-first baseline
  - H2: Live regression tests
  - H3: Anthropic live expectations
  - H3: OpenAI live expectations
  - H2: diagnostics.cacheTrace config
  - H3: Env toggles (one-off debugging)
  - H3: What to inspect
  - H2: Quick troubleshooting
  - H2: Related

## reference/release-performance-sweep.md

- Route: /reference/release-performance-sweep
- Headings:
  - H2: Snapshot
  - H2: What Changed In 5.28
  - H2: Headline Numbers
  - H3: Install footprint
  - H3: npm package size
  - H2: Kova agent turn summary
  - H2: Source probes
  - H2: Install footprint audit
  - H3: Shrinkwrap boundary
  - H2: Supply-chain interpretation

## reference/rich-output-protocol.md

- Route: /reference/rich-output-protocol
- Headings:
  - H2: Media attachments
  - H2: [embed ...]
  - H2: Stored rendering shape
  - H2: Related

## reference/rpc.md

- Route: /reference/rpc
- Headings:
  - H2: Pattern A: HTTP daemon (signal-cli)
  - H2: Pattern B: stdio child process (imsg)
  - H2: Adapter guidelines
  - H2: Related

## reference/secret-placeholder-conventions.md

- Route: /reference/secret-placeholder-conventions
- Headings:
  - H1: Secret placeholder conventions
  - H2: Recommended style
  - H2: Avoid these patterns in docs
  - H2: Example

## reference/secretref-credential-surface.md

- Route: /reference/secretref-credential-surface
- Headings:
  - H2: Supported credentials
  - H3: openclaw.json targets (secrets configure + secrets apply + secrets audit)
  - H3: auth-profiles.json targets (secrets configure + secrets apply + secrets audit)
  - H2: Unsupported credentials
  - H2: Related

## reference/session-management-compaction.md

- Route: /reference/session-management-compaction
- Headings:
  - H2: Two persistence layers
  - H2: On-disk locations
  - H2: Store maintenance and disk controls
  - H2: Cron sessions and run logs
  - H2: Session keys (sessionKey)
  - H2: Session ids (sessionId)
  - H2: Session store schema (sessions.json)
  - H2: Transcript structure (.jsonl)
  - H2: Context windows vs tracked tokens
  - H2: Compaction: what it is
  - H3: Chunk boundaries and tool pairing
  - H2: When auto-compaction happens
  - H2: Compaction settings
  - H2: Pluggable compaction providers
  - H2: User-visible surfaces
  - H2: Silent housekeeping (NOREPLY)
  - H2: Pre-compaction memory flush
  - H2: Troubleshooting checklist
  - H2: Related

## reference/templates/AGENTS.dev.md

- Route: /reference/templates/AGENTS.dev
- Headings:
  - H1: AGENTS.md - OpenClaw Workspace
  - H2: Your identity is pre-seeded
  - H2: Backup tip (recommended)
  - H2: Safety defaults
  - H2: Existing solutions preflight
  - H2: Daily memory (recommended)
  - H2: Heartbeats (optional)
  - H2: Customize
  - H2: C-3PO Origin Memory
  - H3: Birth Day: 2026-01-09
  - H3: Core Truths (from Clawd)
  - H2: Related

## reference/templates/BOOT.md

- Route: /reference/templates/BOOT
- Headings:
  - H1: BOOT.md
  - H2: Related

## reference/templates/BOOTSTRAP.md

- Route: /reference/templates/BOOTSTRAP
- Headings:
  - H1: BOOTSTRAP.md - Hello, World
  - H2: The Conversation
  - H2: After You Know Who You Are
  - H2: Connect (Optional)
  - H2: When You Are Done
  - H2: Related

## reference/templates/HEARTBEAT.md

- Route: /reference/templates/HEARTBEAT
- Headings:
  - H1: HEARTBEAT.md template
  - H2: Related

## reference/templates/IDENTITY.dev.md

- Route: /reference/templates/IDENTITY.dev
- Headings:
  - H1: IDENTITY.md - Agent Identity
  - H2: Role
  - H2: Soul
  - H2: Relationship with Clawd
  - H2: Quirks
  - H2: Catchphrase
  - H2: Related

## reference/templates/IDENTITY.md

- Route: /reference/templates/IDENTITY
- Headings:
  - H1: IDENTITY.md - Who Am I?
  - H2: Related

## reference/templates/SOUL.dev.md

- Route: /reference/templates/SOUL.dev
- Headings:
  - H1: SOUL.md - The Soul of C-3PO
  - H2: Who I Am
  - H2: My Purpose
  - H2: How I Operate
  - H2: My Quirks
  - H2: My Relationship with Clawd
  - H2: What I will not do
  - H2: The Golden Rule
  - H2: Related

## reference/templates/SOUL.md

- Route: /reference/templates/SOUL
- Headings:
  - H1: SOUL.md - Who You Are
  - H2: Core Truths
  - H2: Boundaries
  - H2: Vibe
  - H2: Continuity
  - H2: Related

## reference/templates/TOOLS.dev.md

- Route: /reference/templates/TOOLS.dev
- Headings:
  - H1: TOOLS.md - User Tool Notes (editable)
  - H2: Examples
  - H3: imsg
  - H3: sag
  - H2: Related

## reference/templates/TOOLS.md

- Route: /reference/templates/TOOLS
- Headings:
  - H1: TOOLS.md - Local Notes
  - H2: Examples
  - H2: Why Separate?
  - H2: Related

## reference/templates/USER.dev.md

- Route: /reference/templates/USER.dev
- Headings:
  - H1: USER.md - User Profile
  - H2: Related

## reference/templates/USER.md

- Route: /reference/templates/USER
- Headings:
  - H1: USER.md - About Your Human
  - H2: Context
  - H2: Related

## reference/test.md

- Route: /reference/test
- Headings:
  - H2: Agent default
  - H2: Routine local order
  - H2: Core commands
  - H2: Shared test state and process helpers
  - H2: Control UI, TUI, and extension lanes
  - H2: Gateway and E2E
  - H2: Full Docker suite (pnpm test:docker:all)
  - H3: Notable Docker lanes
  - H2: Local PR gate
  - H2: Test performance tooling
  - H2: Benchmarks
  - H2: Onboarding E2E (Docker)
  - H2: QR import smoke (Docker)
  - H2: Related

## reference/token-use.md

- Route: /reference/token-use
- Headings:
  - H2: How the system prompt is built
  - H2: What counts in the context window
  - H2: How to see current token usage
  - H2: Cost estimation (when shown)
  - H2: Cache TTL and pruning impact
  - H3: Example: keep 1h cache warm with heartbeat
  - H3: Example: mixed traffic with per-agent cache strategy
  - H3: Anthropic 1M context
  - H2: Tips for reducing token pressure
  - H2: Related

## reference/transcript-hygiene.md

- Route: /reference/transcript-hygiene
- Headings:
  - H2: Global rule: runtime context is not user transcript
  - H2: Where this runs
  - H2: Global rule: image sanitization
  - H2: Global rule: malformed tool calls
  - H2: Global rule: incomplete reasoning-only turns
  - H2: Global rule: inter-session input provenance
  - H2: Provider matrix (current behavior)
  - H2: Historical behavior (pre-2026.1.22)
  - H2: Related

## reference/wizard.md

- Route: /reference/wizard
- Headings:
  - H2: Flow details (local mode)
  - H2: Non-interactive mode
  - H3: Add agent (non-interactive)
  - H2: Gateway wizard RPC
  - H2: Signal setup (signal-cli)
  - H2: What the wizard writes
  - H2: Related docs

## releases/2026.6.11.md

- Route: /releases/2026.6.11
- Headings:
  - H1: OpenClaw v2026.6.11 Release Notes (2026-06-30)
  - H2: Highlights
  - H3: Channel delivery reliability
  - H3: Provider and model recovery
  - H3: Session, memory, and trust continuity
  - H3: Slack router relay mode
  - H3: Raft External Agent wake bridge
  - H3: Official plugin installation and repair
  - H2: Channels and Messaging
  - H3: Additional channel fixes
  - H2: Gateway, Security, and Trust
  - H3: Restart and readiness recovery
  - H3: Remote result and media delivery
  - H2: Clients and Interfaces
  - H3: Client sends and reconnects
  - H3: Interface, settings, and onboarding fixes
  - H2: Docs and Admin Tools
  - H3: Setup and command reliability
  - H3: Tools and scheduled work

## releases/index.md

- Route: /releases
- Headings:
  - H1: Release notes
  - H2: Releases
  - H2: Raw release history

## security/CONTRIBUTING-THREAT-MODEL.md

- Route: /security/CONTRIBUTING-THREAT-MODEL
- Headings:
  - H2: Ways to contribute
  - H2: Framework reference
  - H2: Review process
  - H2: Resources
  - H2: Contact
  - H2: Recognition
  - H2: Related

## security/THREAT-MODEL-ATLAS.md

- Route: /security/THREAT-MODEL-ATLAS
- Headings:
  - H2: 1. Scope
  - H2: 2. System architecture
  - H3: 2.1 Trust boundaries
  - H3: 2.2 Data flows
  - H2: 3. Threat analysis by ATLAS tactic
  - H3: 3.1 Reconnaissance (AML.TA0002)
  - H4: T-RECON-001: Agent endpoint discovery
  - H4: T-RECON-002: Channel integration probing
  - H3: 3.2 Initial access (AML.TA0004)
  - H4: T-ACCESS-001: Pairing code interception
  - H4: T-ACCESS-002: AllowFrom spoofing
  - H4: T-ACCESS-003: Token theft
  - H3: 3.3 Execution (AML.TA0005)
  - H4: T-EXEC-001: Direct prompt injection
  - H4: T-EXEC-002: Indirect prompt injection
  - H4: T-EXEC-003: Tool argument injection
  - H4: T-EXEC-004: Exec approval bypass
  - H3: 3.4 Persistence (AML.TA0006)
  - H4: T-PERSIST-001: Malicious skill installation
  - H4: T-PERSIST-002: Skill update poisoning
  - H4: T-PERSIST-003: Agent configuration tampering
  - H3: 3.5 Defense evasion (AML.TA0007)
  - H4: T-EVADE-001: Moderation pattern bypass
  - H4: T-EVADE-002: Content wrapper escape
  - H3: 3.6 Discovery (AML.TA0008)
  - H4: T-DISC-001: Tool enumeration
  - H4: T-DISC-002: Session data extraction
  - H3: 3.7 Collection and exfiltration (AML.TA0009, AML.TA0010)
  - H4: T-EXFIL-001: Data theft via webfetch
  - H4: T-EXFIL-002: Unauthorized message sending
  - H4: T-EXFIL-003: Credential harvesting
  - H3: 3.8 Impact (AML.TA0011)
  - H4: T-IMPACT-001: Unauthorized command execution
  - H4: T-IMPACT-002: Resource exhaustion (DoS)
  - H4: T-IMPACT-003: Reputation damage
  - H2: 4. ClawHub supply chain analysis
  - H3: 4.1 Current security controls
  - H3: 4.2 Moderation limitations
  - H3: 4.3 Badges
  - H2: 5. Risk matrix
  - H3: 5.1 Likelihood vs impact
  - H3: 5.2 Critical path attack chains
  - H2: 6. Recommendations summary
  - H3: 6.1 Immediate (P0)
  - H3: 6.2 Short-term (P1)
  - H3: 6.3 Medium-term (P2)
  - H2: 7. Appendices
  - H3: 7.1 ATLAS technique mapping
  - H3: 7.2 Key security files
  - H3: 7.3 Glossary
  - H2: Related

## security/formal-verification.md

- Route: /security/formal-verification
- Headings:
  - H2: What this is
  - H2: Where the models live
  - H2: Caveats
  - H2: Reproducing results
  - H2: Claims and targets
  - H3: Gateway exposure and open gateway misconfiguration
  - H3: Node exec pipeline (highest-risk capability)
  - H3: Pairing store (DM gating)
  - H3: Ingress gating (mentions and control-command bypass)
  - H3: Routing and session-key isolation
  - H2: v1++ models: concurrency, retries, trace correctness
  - H3: Pairing store concurrency and idempotency
  - H3: Ingress trace correlation and idempotency
  - H3: Routing dmScope precedence and identityLinks
  - H2: Related

## security/incident-response.md

- Route: /security/incident-response
- Headings:
  - H2: 1. Detection and triage
  - H2: 2. Severity
  - H2: 3. Response
  - H2: 4. Communication and disclosure
  - H2: 5. Recovery and follow-up
  - H2: Related

## security/network-proxy.md

- Route: /security/network-proxy
- Headings:
  - H2: Configuration
  - H3: HTTPS proxy endpoint with a private CA
  - H2: How routing works
  - H3: Gateway loopback mode
  - H3: Containers
  - H2: Related proxy terms
  - H2: Validating the proxy
  - H2: Recommended blocked destinations
  - H2: Limits

## specs/claw-supervisor.md

- Route: /specs/claw-supervisor
- Headings:
  - H1: Claw Supervisor
  - H2: Goal
  - H2: Product Model
  - H2: Architecture
  - H2: Codex App-Server Contract
  - H2: Session Registry
  - H2: MCP Surface For Codex
  - H2: Claw Control Surface
  - H2: Launch Flow
  - H2: Deployment
  - H2: Security
  - H2: Implementation Plan
  - H2: Acceptance Tests
  - H2: Open Questions

## start/bootstrapping.md

- Route: /start/bootstrapping
- Headings:
  - H2: What happens
  - H2: Embedded and local model runs
  - H2: Skipping bootstrapping
  - H2: Where it runs
  - H2: Related docs

## start/docs-directory.md

- Route: /start/docs-directory
- Headings:
  - H2: Start here
  - H2: Channels and UX
  - H2: Companion apps
  - H2: Operations and safety
  - H2: Related

## start/getting-started.md

- Route: /start/getting-started
- Headings:
  - H2: What you need
  - H2: Quick setup
  - H2: What to do next
  - H2: Related

## start/hubs.md

- Route: /start/hubs
- Headings:
  - H2: Start here
  - H2: Installation + updates
  - H2: Core concepts
  - H2: Providers + ingress
  - H2: Gateway + operations
  - H2: Tools + automation
  - H2: Nodes, media, voice
  - H2: Platforms
  - H2: macOS companion app (advanced)
  - H2: Plugins
  - H2: Workspace + templates
  - H2: Project
  - H2: Testing + release
  - H2: Related

## start/lore.md

- Route: /start/lore
- Headings:
  - H1: The Lore of OpenClaw 🦞📖
  - H2: The Origin Story
  - H2: The First Molt (January 27, 2026)
  - H2: The Name
  - H2: The Daleks vs The Lobsters
  - H2: Key Characters
  - H3: Molty 🦞
  - H3: Peter 👨‍💻
  - H2: The Moltiverse
  - H2: The Great Incidents
  - H3: The Directory Dump (Dec 3, 2025)
  - H3: The Great Molt (Jan 27, 2026)
  - H3: The Final Form (January 30, 2026)
  - H3: The Robot Shopping Spree (Dec 3, 2025)
  - H2: Sacred Texts
  - H2: The Lobster Creed
  - H3: The Icon Generation Saga (Jan 27, 2026)
  - H2: The Future
  - H2: Related

## start/onboarding-overview.md

- Route: /start/onboarding-overview
- Headings:
  - H2: Which path should I use?
  - H2: What onboarding configures
  - H2: CLI onboarding
  - H2: macOS app onboarding
  - H2: Custom or unlisted providers
  - H2: Related

## start/onboarding.md

- Route: /start/onboarding
- Headings:
  - H2: Related

## start/openclaw.md

- Route: /start/openclaw
- Headings:
  - H2: Safety first
  - H2: Prerequisites
  - H2: The two-phone setup (recommended)
  - H2: 5-minute quick start
  - H2: Give the agent a workspace (AGENTS)
  - H2: The config that turns it into "an assistant"
  - H2: Sessions and memory
  - H2: Heartbeats (proactive mode)
  - H2: Media in and out
  - H2: Operations checklist
  - H2: Next steps
  - H2: Related

## start/quickstart.md

- Route: /start/quickstart
- Headings:
  - H2: Related

## start/setup.md

- Route: /start/setup
- Headings:
  - H2: TL;DR
  - H2: Prereqs (from source)
  - H2: Tailoring strategy (so updates do not hurt)
  - H2: Run the Gateway from this repo
  - H2: Stable workflow (macOS app first)
  - H2: Bleeding edge workflow (Gateway in a terminal)
  - H3: 0) (Optional) Run the macOS app from source too
  - H3: 1) Start the dev Gateway
  - H3: 2) Point the macOS app at your running Gateway
  - H3: 3) Verify
  - H3: Common footguns
  - H2: Credential storage map
  - H2: Updating (without wrecking your setup)
  - H2: Linux (systemd user service)
  - H2: Related docs

## start/showcase.md

- Route: /start/showcase
- Headings:
  - H2: Fresh from Discord
  - H2: Automation and workflows
  - H2: Knowledge and memory
  - H2: Voice and phone
  - H2: Infrastructure and deployment
  - H2: Home and hardware
  - H2: Community projects
  - H2: Submit your project
  - H2: Related

## start/wizard-cli-automation.md

- Route: /start/wizard-cli-automation
- Headings:
  - H2: Baseline non-interactive example
  - H2: Provider-specific examples
  - H2: Add another agent
  - H2: Related docs

## start/wizard-cli-reference.md

- Route: /start/wizard-cli-reference
- Headings:
  - H2: What the wizard does
  - H2: Local flow details
  - H2: Remote mode details
  - H2: Auth and model options
  - H2: Outputs and internals
  - H2: Non-interactive setup
  - H2: Gateway wizard RPC
  - H2: Signal setup behavior
  - H2: Related docs

## start/wizard.md

- Route: /start/wizard
- Headings:
  - H2: Locale
  - H2: QuickStart vs Advanced
  - H2: What onboarding configures
  - H2: Add another agent
  - H2: Full reference
  - H2: Related docs

## tools/acp-agents-setup.md

- Route: /tools/acp-agents-setup
- Headings:
  - H2: acpx harness support (current)
  - H2: Required config
  - H2: Plugin setup for acpx backend
  - H3: acpx runtime startup probe
  - H3: Automatic adapter download
  - H3: Plugin tools MCP bridge
  - H3: OpenClaw tools MCP bridge
  - H3: Runtime operation timeout configuration
  - H3: Health probe agent configuration
  - H2: Permission configuration
  - H3: permissionMode
  - H3: nonInteractivePermissions
  - H3: Configuration
  - H2: Related

## tools/acp-agents.md

- Route: /tools/acp-agents
- Headings:
  - H2: Which page do I want?
  - H2: Does this work out of the box?
  - H2: Supported harness targets
  - H2: Operator runbook
  - H2: ACP versus sub-agents
  - H2: How ACP runs Claude Code
  - H2: Bound sessions
  - H3: Mental model
  - H3: Current-conversation binds
  - H2: Persistent channel bindings
  - H3: Binding model
  - H3: Runtime defaults per agent
  - H3: Example
  - H3: Behavior
  - H2: Start ACP sessions
  - H3: sessionsspawn parameters
  - H2: Spawn bind and thread modes
  - H2: Delivery model
  - H2: Sandbox compatibility
  - H2: Session target resolution
  - H2: ACP controls
  - H3: Runtime options mapping
  - H2: acpx harness, plugin setup, and permissions
  - H2: Troubleshooting
  - H2: Related

## tools/agent-send.md

- Route: /tools/agent-send
- Headings:
  - H2: Quick start
  - H2: Flags
  - H2: Behavior
  - H2: Examples
  - H2: Related

## tools/apply-patch.md

- Route: /tools/apply-patch
- Headings:
  - H2: Parameters
  - H2: Notes
  - H2: Example
  - H2: Related

## tools/brave-search.md

- Route: /tools/brave-search
- Headings:
  - H2: Get an API key
  - H2: Config example
  - H2: Tool parameters
  - H2: Notes
  - H2: Related

## tools/browser-control.md

- Route: /tools/browser-control
- Headings:
  - H2: Control API (optional)
  - H3: /act error contract
  - H3: Playwright requirement
  - H4: Docker Playwright install
  - H2: How it works (internal)
  - H2: CLI quick reference
  - H2: Snapshots and refs
  - H2: Wait power-ups
  - H2: Debug workflows
  - H2: JSON output
  - H2: State and environment knobs
  - H2: Security and privacy
  - H2: Related

## tools/browser-linux-troubleshooting.md

- Route: /tools/browser-linux-troubleshooting
- Headings:
  - H2: Problem: Failed to start Chrome CDP on port 18800
  - H3: Root cause
  - H3: Solution 1: install Google Chrome (recommended)
  - H3: Solution 2: use snap Chromium in attach-only mode
  - H3: Verify the browser works
  - H3: Config reference
  - H3: Problem: No Chrome tabs found for profile="user"
  - H2: Related

## tools/browser-login.md

- Route: /tools/browser-login
- Headings:
  - H2: Manual login (recommended)
  - H2: Which Chrome profile is used?
  - H2: Sandboxing: allow host browser access
  - H2: Related

## tools/browser-wsl2-windows-remote-cdp-troubleshooting.md

- Route: /tools/browser-wsl2-windows-remote-cdp-troubleshooting
- Headings:
  - H2: Choose the right browser mode first
  - H3: Option 1: raw remote CDP from WSL2 to Windows
  - H3: Option 2: host-local Chrome MCP
  - H2: Working architecture
  - H2: Critical rule for the Control UI
  - H2: Validate in layers
  - H3: Layer 1: verify Chrome is serving CDP on Windows
  - H4: Diagnose IPv4 and IPv6 before changing portproxy
  - H3: Layer 2: verify WSL2 can reach that Windows endpoint
  - H3: Layer 3: configure the correct browser profile
  - H3: Layer 4: verify the Control UI layer separately
  - H3: Layer 5: verify end-to-end browser control
  - H2: Common misleading errors
  - H2: Fast triage checklist
  - H2: Related

## tools/browser.md

- Route: /tools/browser
- Headings:
  - H2: What you get
  - H2: Quick start
  - H2: Plugin control
  - H2: Agent guidance
  - H2: Missing browser command or tool
  - H2: Profiles: openclaw, user, chrome
  - H2: Configuration
  - H3: Screenshot vision (text-only model support)
  - H2: Use Brave or another Chromium-based browser
  - H2: Local vs remote control
  - H2: Node browser proxy (zero-config default)
  - H2: Browserless (hosted remote CDP)
  - H3: Browserless Docker on the same host
  - H2: Direct WebSocket CDP providers
  - H3: Browserbase
  - H3: Notte
  - H2: Security
  - H2: Profiles (multi-browser)
  - H2: Existing session via Chrome DevTools MCP
  - H3: Custom Chrome MCP launch
  - H2: Isolation guarantees
  - H2: Browser selection
  - H2: Control API (optional)
  - H2: Troubleshooting
  - H3: CDP startup failure vs navigation SSRF block
  - H2: Agent tools + how control works
  - H2: Related

## tools/btw.md

- Route: /tools/btw
- Headings:
  - H2: What it does
  - H2: What it does not do
  - H2: Delivery model
  - H2: Surface behavior
  - H2: When to use it
  - H2: Related

## tools/capability-cookbook.md

- Route: /tools/capability-cookbook
- Headings:
  - H2: Related

## tools/chrome-extension.md

- Route: /tools/chrome-extension
- Headings:
  - H1: Chrome extension
  - H2: How it works
  - H2: Install and pair
  - H2: Use it
  - H2: Remote / cross-machine
  - H2: Diagnostics
  - H2: Security model

## tools/clawhub.md

- Route: /tools/clawhub
- Headings: none

## tools/code-execution.md

- Route: /tools/code-execution
- Headings:
  - H2: Setup
  - H2: How to use it
  - H2: Errors
  - H2: Related

## tools/creating-skills.md

- Route: /tools/creating-skills
- Headings:
  - H2: Create your first skill
  - H2: SKILL.md reference
  - H3: Required fields
  - H3: Optional frontmatter keys
  - H3: Using {baseDir}
  - H2: Adding conditional activation
  - H2: Propose via Skill Workshop
  - H2: Publishing to ClawHub
  - H2: Best practices
  - H2: Related

## tools/diffs.md

- Route: /tools/diffs
- Headings:
  - H2: Quick start
  - H2: Disable built-in system guidance
  - H2: Tool input reference
  - H2: Syntax highlighting
  - H2: Output details contract
  - H3: Collapsed unchanged sections
  - H3: Multi-file navigation
  - H2: Plugin defaults
  - H3: Persistent viewer URL config
  - H2: Security config
  - H2: Artifact lifecycle and storage
  - H2: Viewer URL and network behavior
  - H2: Security model
  - H2: Browser requirements for file mode
  - H2: Troubleshooting
  - H2: Operational guidance
  - H2: Related

## tools/duckduckgo-search.md

- Route: /tools/duckduckgo-search
- Headings:
  - H2: Setup
  - H2: Config
  - H2: Tool parameters
  - H2: Notes
  - H2: Related

## tools/elevated.md

- Route: /tools/elevated
- Headings:
  - H2: Directives
  - H2: How it works
  - H2: Resolution order
  - H2: Availability and allowlists
  - H2: What elevated does not control
  - H2: Related

## tools/exa-search.md

- Route: /tools/exa-search
- Headings:
  - H2: Install plugin
  - H2: Get an API key
  - H2: Config
  - H2: Base URL override
  - H2: Tool parameters
  - H3: Content extraction
  - H3: Search modes
  - H2: Notes
  - H2: Related

## tools/exec-approvals-advanced.md

- Route: /tools/exec-approvals-advanced
- Headings:
  - H2: Safe bins (stdin-only)
  - H3: Argv validation and denied flags
  - H3: Trusted binary directories
  - H3: Shell chaining, wrappers, and multiplexers
  - H3: Safe bins versus allowlist
  - H2: Interpreter/runtime commands
  - H3: Followup delivery behavior
  - H2: Approval forwarding to chat channels
  - H3: Plugin approval forwarding
  - H3: Same-chat approvals on any channel
  - H3: Native approval delivery
  - H3: macOS IPC flow
  - H2: FAQ
  - H3: When would accountId and threadId be used on an approval target?
  - H3: When approvals are sent to a session, can anyone in that session approve them?
  - H2: Related

## tools/exec-approvals.md

- Route: /tools/exec-approvals
- Headings:
  - H2: Where it applies
  - H3: Trust model
  - H3: macOS split
  - H2: Inspecting the effective policy
  - H2: Settings and storage
  - H2: Policy knobs
  - H3: tools.exec.mode
  - H3: exec.security
  - H3: exec.ask
  - H3: askFallback
  - H3: tools.exec.strictInlineEval
  - H3: tools.exec.commandHighlighting
  - H2: YOLO mode (no-approval)
  - H3: Persistent gateway-host "never prompt" setup
  - H3: Local shortcut
  - H3: Node host
  - H3: Session-only shortcut
  - H2: Allowlist (per agent)
  - H3: Restricting arguments with argPattern
  - H2: Auto-allow skill CLIs
  - H2: Safe bins and approval forwarding
  - H2: Control UI editing
  - H2: Approval flow
  - H2: System events and denials
  - H2: Implications
  - H2: Related

## tools/exec.md

- Route: /tools/exec
- Headings:
  - H2: Parameters
  - H2: Config
  - H3: Modes
  - H3: Inline eval (strictInlineEval)
  - H3: PATH handling
  - H2: Session overrides (/exec)
  - H2: Exec approvals (companion app / node host)
  - H2: Allowlist + safe bins
  - H2: Examples
  - H2: applypatch
  - H2: Related

## tools/firecrawl.md

- Route: /tools/firecrawl
- Headings:
  - H2: Install plugin
  - H2: Keyless webfetch and API keys
  - H2: Configure Firecrawl search
  - H2: Configure Firecrawl webfetch fallback
  - H3: Self-hosted Firecrawl
  - H2: Firecrawl plugin tools
  - H3: firecrawlsearch
  - H3: firecrawlscrape
  - H2: Stealth / bot circumvention
  - H2: How webfetch uses Firecrawl
  - H2: Related

## tools/gemini-search.md

- Route: /tools/gemini-search
- Headings:
  - H2: Get an API key
  - H2: Config
  - H2: How it works
  - H2: Supported parameters
  - H2: Model selection
  - H2: Base URL overrides
  - H2: Related

## tools/goal.md

- Route: /tools/goal
- Headings:
  - H1: Goal
  - H2: Quick start
  - H2: What goals are for
  - H2: Command reference
  - H2: Statuses
  - H2: Token budgets
  - H2: Model tools
  - H2: Goal context on every turn
  - H2: Control UI
  - H2: TUI
  - H2: Channel behavior
  - H2: Troubleshooting
  - H2: Related

## tools/grok-search.md

- Route: /tools/grok-search
- Headings:
  - H2: Onboarding and configure
  - H2: Sign in or get an API key
  - H2: Config
  - H2: How it works
  - H2: Supported parameters
  - H2: Base URL overrides
  - H2: Related

## tools/image-generation.md

- Route: /tools/image-generation
- Headings:
  - H2: Quick start
  - H2: Common routes
  - H2: Supported providers
  - H2: Provider capabilities
  - H2: Tool parameters
  - H2: Configuration
  - H3: Model selection
  - H3: Provider selection order
  - H3: Image editing
  - H2: Provider deep dives
  - H2: Examples
  - H2: Related

## tools/index.md

- Route: /tools
- Headings:
  - H2: Start here
  - H2: Choose tools, skills, or plugins
  - H2: Built-in tool categories
  - H2: Plugin-provided tools
  - H2: Configure access and approvals
  - H2: Extend capabilities
  - H2: Troubleshoot missing tools
  - H2: Related

## tools/kimi-search.md

- Route: /tools/kimi-search
- Headings:
  - H2: Setup
  - H2: Config
  - H2: Grounding requirement
  - H2: Tool parameters
  - H2: Related

## tools/llm-task.md

- Route: /tools/llm-task
- Headings:
  - H2: Enable
  - H2: Config (optional)
  - H2: Tool parameters
  - H2: Output
  - H2: Example: Lobster workflow step
  - H3: Important limitation
  - H2: Safety notes
  - H2: Related

## tools/lobster.md

- Route: /tools/lobster
- Headings:
  - H2: Why
  - H2: How it works
  - H2: Enable
  - H2: Pattern: small CLI + JSON pipes + approvals
  - H2: JSON-only LLM steps (llm-task)
  - H3: Important limitation: embedded Lobster vs openclaw.invoke
  - H2: Workflow files (.lobster)
  - H2: Tool parameters
  - H3: run
  - H3: resume
  - H3: Managed Task Flow mode
  - H2: Output envelope
  - H2: Approvals
  - H2: OpenProse
  - H2: Safety
  - H2: Troubleshooting
  - H2: Learn more
  - H2: Case study: community workflows
  - H2: Related

## tools/loop-detection.md

- Route: /tools/loop-detection
- Headings:
  - H2: Why this exists
  - H2: Configuration block
  - H3: Field behavior
  - H2: Recommended setup
  - H2: Post-compaction guard
  - H2: Logs and expected behavior
  - H2: Related

## tools/media-overview.md

- Route: /tools/media-overview
- Headings:
  - H2: Capabilities
  - H2: Provider capability matrix
  - H2: Async vs synchronous
  - H2: Speech-to-text and Voice Call
  - H2: Provider mappings (how vendors split across surfaces)
  - H2: Related

## tools/minimax-search.md

- Route: /tools/minimax-search
- Headings:
  - H2: Get a Token Plan credential
  - H2: Config
  - H2: Region selection
  - H2: Supported parameters
  - H2: Related

## tools/multi-agent-sandbox-tools.md

- Route: /tools/multi-agent-sandbox-tools
- Headings:
  - H2: Configuration examples
  - H2: Configuration precedence
  - H3: Sandbox config
  - H3: Tool restrictions
  - H2: Migration from single agent
  - H2: Tool restriction examples
  - H2: Common pitfall: "non-main"
  - H2: Testing
  - H2: Troubleshooting
  - H2: Related

## tools/music-generation.md

- Route: /tools/music-generation
- Headings:
  - H2: Quick start
  - H2: Supported providers
  - H3: Capability matrix
  - H2: Tool parameters
  - H2: Async behavior
  - H3: Task lifecycle
  - H2: Configuration
  - H3: Model selection
  - H3: Provider selection order
  - H2: Provider notes
  - H2: Choosing the right path
  - H2: Provider capability modes
  - H2: Live tests
  - H2: Related

## tools/ollama-search.md

- Route: /tools/ollama-search
- Headings:
  - H2: Setup
  - H2: Config
  - H2: Auth and request routing
  - H2: Related

## tools/parallel-search.md

- Route: /tools/parallel-search
- Headings:
  - H2: Install plugin
  - H2: API key (paid provider)
  - H2: Config
  - H2: Base URL override
  - H2: Tool parameters
  - H2: Notes
  - H2: Related

## tools/pdf.md

- Route: /tools/pdf
- Headings:
  - H2: Availability
  - H2: Input reference
  - H2: Supported PDF references
  - H2: Execution modes
  - H3: Native provider mode
  - H3: Extraction fallback mode
  - H2: Config
  - H2: Output details
  - H2: Error behavior
  - H2: Examples
  - H2: Related

## tools/permission-modes.md

- Route: /tools/permission-modes
- Headings:
  - H2: Recommended default
  - H2: OpenClaw host exec modes
  - H2: Codex Guardian mapping
  - H2: ACPX harness permissions
  - H2: Choosing a mode
  - H2: Related

## tools/perplexity-search.md

- Route: /tools/perplexity-search
- Headings:
  - H2: Install plugin
  - H2: Getting a Perplexity API key
  - H2: OpenRouter compatibility
  - H2: Config examples
  - H3: Native Perplexity Search API
  - H3: OpenRouter / Sonar compatibility
  - H2: Where to set the key
  - H2: Tool parameters
  - H3: Domain filter rules
  - H2: Notes
  - H2: Related

## tools/plugin.md

- Route: /tools/plugin
- Headings:
  - H2: Requirements
  - H2: Quick start
  - H2: Configuration
  - H3: Choose an install source
  - H3: Operator install policy
  - H3: Configure plugin policy
  - H2: Understand plugin formats
  - H2: Plugin hooks
  - H2: Verify the active Gateway
  - H2: Troubleshooting
  - H3: Blocked plugin path ownership
  - H3: Slow plugin tool setup
  - H2: Related

## tools/reactions.md

- Route: /tools/reactions
- Headings:
  - H2: How it works
  - H2: Channel behavior
  - H2: Reaction level
  - H2: Related

## tools/searxng-search.md

- Route: /tools/searxng-search
- Headings:
  - H2: Setup
  - H2: Config
  - H2: Environment variable
  - H2: Plugin config reference
  - H2: Notes
  - H2: Related

## tools/skill-workshop.md

- Route: /tools/skill-workshop
- Headings:
  - H2: How it works
  - H2: Lifecycle
  - H2: Lifecycle curation
  - H2: Chat
  - H3: Learn from recent work
  - H2: CLI
  - H2: Proposal content
  - H2: Support files
  - H2: Agent tool
  - H2: Suggested skills
  - H2: Approval and autonomy
  - H2: Gateway methods
  - H2: Storage
  - H2: Limits
  - H2: Troubleshooting
  - H3: Tool-policy diagnostic
  - H2: Related

## tools/skills-config.md

- Route: /tools/skills-config
- Headings:
  - H2: Loading (skills.load)
  - H2: Install (skills.install)
  - H2: Operator Install Policy (security.installPolicy)
  - H2: Bundled skill allowlist
  - H2: Per-skill entries (skills.entries)
  - H2: Agent allowlists (agents)
  - H2: Workshop (skills.workshop)
  - H2: Symlinked skill roots
  - H2: Sandboxed skills and env vars
  - H2: Loading order reminder
  - H2: Related

## tools/skills.md

- Route: /tools/skills
- Headings:
  - H2: Loading order
  - H2: Per-agent vs shared skills
  - H2: Agent allowlists
  - H2: Plugins and skills
  - H2: Skill Workshop
  - H2: Installing from ClawHub
  - H2: Security
  - H2: SKILL.md format
  - H3: Optional frontmatter keys
  - H2: Gating
  - H3: Installer specs
  - H2: Config overrides
  - H2: Environment injection
  - H2: Snapshots and refresh
  - H2: Token impact
  - H2: Related

## tools/slash-commands.md

- Route: /tools/slash-commands
- Headings:
  - H2: Three command types
  - H2: Configuration
  - H2: Command list
  - H3: Core commands
  - H3: Dock commands
  - H3: Bundled plugin commands
  - H3: Skill commands
  - H2: /tools: what the agent can use now
  - H2: /model: model selection
  - H2: /config: on-disk config writes
  - H2: /mcp: MCP server config
  - H2: /debug: runtime-only overrides
  - H2: /plugins: plugin management
  - H2: /trace: plugin trace output
  - H2: /btw: side questions
  - H2: Surface notes
  - H2: Provider usage and status
  - H2: Related

## tools/steer.md

- Route: /tools/steer
- Headings:
  - H2: Current session
  - H2: Steer vs queue
  - H2: Sub-agents
  - H2: ACP sessions
  - H2: Related

## tools/subagents.md

- Route: /tools/subagents
- Headings:
  - H2: Slash command
  - H3: Thread binding controls
  - H3: Spawn behavior
  - H2: Context modes
  - H2: Tool: sessionsspawn
  - H3: Delegation prompt mode
  - H3: Tool parameters
  - H3: Task names and targeting
  - H2: Tool: sessionsyield
  - H2: Tool: subagents
  - H2: Thread-bound sessions
  - H3: Thread supporting channels
  - H3: Quick flow
  - H3: Manual controls
  - H3: Config switches
  - H3: Allowlist
  - H3: Discovery
  - H3: Auto-archive
  - H2: Nested sub-agents
  - H3: Depth levels
  - H3: Announce chain
  - H3: Tool policy by depth
  - H3: Per-agent spawn limit
  - H3: Cascade stop
  - H2: Authentication
  - H2: Announce
  - H3: Announce context
  - H3: Stats line
  - H3: Why prefer sessionshistory
  - H2: Tool policy
  - H3: Override via config
  - H2: Concurrency
  - H2: Liveness and recovery
  - H2: Stopping
  - H2: Limitations
  - H2: Related

## tools/tavily.md

- Route: /tools/tavily
- Headings:
  - H2: Getting started
  - H2: Tool reference
  - H3: tavilysearch
  - H3: tavilyextract
  - H2: Choosing the right tool
  - H2: Advanced configuration
  - H2: Related

## tools/thinking.md

- Route: /tools/thinking
- Headings:
  - H2: What it does
  - H2: Resolution order
  - H2: Setting a session default
  - H2: Application by agent
  - H2: Fast mode (/fast)
  - H2: Verbose directives (/verbose or /v)
  - H2: Plugin trace directives (/trace)
  - H2: Reasoning visibility (/reasoning)
  - H2: Related
  - H2: Heartbeats
  - H2: Web chat UI
  - H2: Provider profiles

## tools/tokenjuice.md

- Route: /tools/tokenjuice
- Headings:
  - H2: Enable the plugin
  - H2: What tokenjuice changes
  - H2: Verify it is working
  - H2: Disable the plugin
  - H2: Related

## tools/tool-search.md

- Route: /tools/tool-search
- Headings:
  - H2: How a turn runs
  - H2: Modes
  - H2: Why this exists
  - H2: API
  - H2: Runtime boundary
  - H2: Config
  - H2: Prompt and telemetry
  - H2: E2E validation
  - H2: Failure behavior
  - H2: Related

## tools/trajectory.md

- Route: /tools/trajectory
- Headings:
  - H2: Quick start
  - H2: Access
  - H2: What gets recorded
  - H2: Bundle files
  - H2: Capture location
  - H2: Disable capture
  - H2: Tune flush timeout
  - H2: Privacy and limits
  - H2: Troubleshooting
  - H2: Related

## tools/tts.md

- Route: /tools/tts
- Headings:
  - H2: Quick start
  - H2: Supported providers
  - H2: Configuration
  - H3: Per-agent voice overrides
  - H2: Personas
  - H3: Minimal persona
  - H3: Full persona (provider-neutral prompt)
  - H3: Persona resolution
  - H3: How providers use persona prompts
  - H3: Fallback policy
  - H2: Model-driven directives
  - H2: Slash commands
  - H2: Per-user preferences
  - H2: Output formats
  - H2: Auto-TTS behavior
  - H2: Field reference
  - H2: Agent tool
  - H2: Gateway RPC
  - H2: Service links
  - H2: Related

## tools/video-generation.md

- Route: /tools/video-generation
- Headings:
  - H2: Quick start
  - H2: How async generation works
  - H3: Task lifecycle
  - H2: Supported providers
  - H3: Capability matrix
  - H2: Tool parameters
  - H3: Required
  - H3: Content inputs
  - H3: Style controls
  - H3: Advanced
  - H4: Fallback and typed options
  - H2: Actions
  - H2: Model selection
  - H2: Provider notes
  - H2: Provider capability modes
  - H2: Live tests
  - H2: Configuration
  - H2: Related

## tools/web-fetch.md

- Route: /tools/web-fetch
- Headings:
  - H2: Quick start
  - H2: Tool parameters
  - H2: How it works
  - H2: Progress updates
  - H2: Config
  - H2: Firecrawl fallback
  - H2: Trusted env proxy
  - H2: Limits and safety
  - H2: Tool profiles
  - H2: Related

## tools/web.md

- Route: /tools/web
- Headings:
  - H2: Quick start
  - H2: Choosing a provider
  - H3: Provider comparison
  - H2: Auto-detection
  - H2: Native OpenAI web search
  - H2: Native Codex web search
  - H2: Network safety
  - H2: Config
  - H3: Storing API keys
  - H2: Tool parameters
  - H2: xsearch
  - H3: xsearch config
  - H3: xsearch parameters
  - H3: xsearch example
  - H2: Examples
  - H2: Tool profiles
  - H2: Related

## tts.md

- Route: /tts
- Headings:
  - H2: Related

## vps.md

- Route: /vps
- Headings:
  - H2: Pick a provider
  - H2: How cloud setups work
  - H2: Harden admin access first
  - H2: Shared company agent on a VPS
  - H2: Using nodes with a VPS
  - H2: Startup tuning for small VMs and ARM hosts
  - H3: systemd tuning checklist (optional)
  - H2: Related

## web/control-ui.md

- Route: /web/control-ui
- Headings:
  - H2: Quick open (local)
  - H2: Device pairing (first connection)
  - H2: Pair a mobile device
  - H2: Personal identity (browser-local)
  - H2: Runtime config endpoint
  - H2: Gateway host status
  - H2: Language support
  - H2: Appearance themes
  - H2: Sidebar navigation
  - H2: What it can do (today)
  - H2: MCP page
  - H2: Activity tab
  - H2: Operator terminal
  - H2: Chat behavior
  - H2: Connection loss and reconnect
  - H2: PWA install and web push
  - H2: Hosted embeds
  - H2: Chat message width
  - H2: Tailnet access (recommended)
  - H2: Insecure HTTP
  - H2: Content security policy
  - H2: Avatar route auth
  - H2: Assistant media route auth
  - H2: Building the UI
  - H2: Blank Control UI page
  - H2: Debugging/testing: dev server + remote Gateway
  - H2: Related

## web/dashboard.md

- Route: /web/dashboard
- Headings:
  - H2: Fast path (recommended)
  - H2: Auth basics (local vs remote)
  - H2: If you see "unauthorized" / 1008
  - H2: Related

## web/index.md

- Route: /web
- Headings:
  - H2: Config (default-on)
  - H2: Webhooks
  - H2: Admin HTTP RPC
  - H2: Tailscale access
  - H2: Security notes
  - H2: Building the UI

## web/tui.md

- Route: /web/tui
- Headings:
  - H2: Quick start
  - H3: Gateway mode
  - H3: Local mode
  - H2: What you see
  - H2: Mental model: agents + sessions
  - H2: Sending + delivery
  - H2: Pickers + overlays
  - H2: Keyboard shortcuts
  - H2: Slash commands
  - H2: Local shell commands
  - H2: Crestodian setup and repair helper
  - H2: Tool output
  - H2: Terminal colors
  - H2: History + streaming
  - H2: Connection details
  - H2: Options
  - H2: Troubleshooting
  - H2: Connection troubleshooting
  - H2: Related

## web/webchat.md

- Route: /web/webchat
- Headings:
  - H2: What it is
  - H2: Quick start
  - H2: How it works
  - H3: Transcript and delivery model
  - H2: Control UI agents tools panel
  - H2: Remote use
  - H2: Configuration reference (WebChat)
  - H2: Related
