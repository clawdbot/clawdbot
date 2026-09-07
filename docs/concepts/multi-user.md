---
summary: "How session ownership, presence, and human mentions work when several people operate one agent"
read_when:
  - You share one OpenClaw agent with other operators
  - You want to hand a session to another person or agent, or filter sessions by owner
  - You want to mention a teammate or find mentions addressed to you
  - You are deciding whether one shared agent provides enough isolation
title: "Multi-user mode"
---

Multi-user mode lets several trusted people operate the same OpenClaw agent. It adds session ownership, participant history, live presence, and owner filtering so a team can tell who started work, who is responsible for it now, and who has been involved.

## Trust boundary

Everyone who can operate an agent can make it do anything that agent can do. Session ownership, visibility in the sidebar, and presence indicators are usability features, not security boundaries.

If people must not access each other's sessions, tools, credentials, or files, give them separate agents or separate gateway/host trust boundaries. Do not rely on owner avatars or filters for isolation.

An authenticated Control UI administrator with `operator.admin` can [manage any automation conversationally](/automation/cron-jobs#conversational-management) on that Gateway, including jobs created from another channel or by another person. This authority comes from the admitted administrator turn, without matching channel identities to Gateway profiles. It does not transfer the job's creator attribution or scheduled execution policy.

## The three ownership layers

Every session carries up to three layers of attribution:

- **Creator** (immutable): new sessions record a write-once `createdActor` when the creation path can prove who caused it. Human creators retain their source: a verified Gateway profile, a channel sender, or unknown historical attribution. Only a profile creator can receive implicit creator access, including through a verified profile merge. Matching channel, agent, or system IDs do not identify that person. Sharing and visibility authority stays anchored on the creator, even after the owner changes.
- **Owner** (assignable): the person or agent currently responsible for the session, in the style of a GitHub issue assignee. It defaults to the creator and can be reassigned at any time; the assignment records who reassigned it and when. The sidebar avatar, the owner filter, and People sorting all follow the current owner.
- **Participants** (history): authenticated people, channel senders, and requesting agents whose accepted input targets the session. The session's own agent and passive viewers are never recorded. New-identity admission is bounded at 32 records per session; repair can preserve larger existing histories. Participation is recorded best-effort in the background, so it never delays a turn.

Gateway profile display names and avatars are resolved from the current profile when session rows are returned; agent actors resolve from the configured agent identity. Participant aggregates do not store display labels, so renaming a profile or agent updates the ownership UI without rewriting participant history.

## Assigning an owner

In the Control UI, the session context menu (kebab or right-click on a sidebar row, and the same menu on the chat header) offers:

- **Assign to me**: take responsibility for the session yourself.
- **Assign to…**: pick any registered person or configured agent, including offline teammates and people who have not owned a session. Choices refresh when you open the menu and do not depend on session filters or archive status.

Agents can reassign ownership with the [`sessions` tool](/concepts/session-tool#managing-session-settings-and-groups) using `action: "assign_owner"` with `ownerType` (`"human"` or `"agent"`) and `ownerId`, targeting the current session by default or another visible session via `sessionKey`.

Both paths call the Gateway method `sessions.assignOwner` (`operator.write`). Assignment requires an identified caller — an authenticated Gateway profile or a trusted agent identity — and is authorized by session visibility. Agent owner ids must name a configured agent. After assignment the avatar tooltip switches from "Created by" to "Owned by".

Reassigning the owner changes responsibility and display only. It does not transfer sharing authority (which stays with the creator) and does not grant or remove any access.

Creator source follows scheduled jobs and inherited creation policies; a required sandbox is a restriction, not evidence of profile identity. Historical automations that lost their creator source retain their attribution and content, but do not receive a guessed profile grant. An administrator can manage their sharing or create a new, explicitly attributed session. Assigning an owner does not repair creator authority. See [Creator namespace migration](/reference/database-schemas#creator-namespace-migration) before upgrading.

## Per-person model accounts

Each teammate can sign in to a model account for their Gateway profile. New sessions they start prefer that account instead of the Gateway default. Available providers and sign-in methods come from the Gateway's provider plugins; selecting an account does not guarantee that every turn bills that account.

There are two sign-ins: the Gateway identifies **you**, then the provider authorizes **your model account**. CLI and web UI use the same personal account store on the selected Gateway. A shared server does not turn personal sign-in into shared credentials. System/agent credentials are a separate scope, managed through `models auth` on the machine running that OpenClaw installation.

There are four separate pieces:

| Piece            | What it means                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Saved account    | A credential owned by your Gateway profile. You can keep several accounts for a provider.             |
| New-chat default | The saved account your new chats prefer for that provider. Changing it does not repin existing chats. |
| Chat selection   | The account already selected for one chat. Collaborators and forks keep that selection.               |
| Sign-in attempt  | A temporary, cancellable operation. No account is saved until sign-in succeeds.                       |

Open **Settings → Profile → Connected accounts**, select **Add account**, then choose a provider and sign-in method. Adding an account needs an identified connection with `operator.write`.

- **Anthropic** accepts an API key for personal setup, not a Claude subscription token.
- **OpenAI** offers API key, ChatGPT/Codex browser sign-in, and device-code sign-in.
- **Grok (xAI)** offers API key and device sign-in.

The chooser shows only provider methods enabled for personal accounts on that Gateway. Follow its instructions and use the protected input for credentials or authorization codes. A browser callback can finish while an input is open; keep the Profile connection open until it reports the result. Saving credentials is separate from verifying a successful model request.

Before adding an account, check the **Gateway**, **Person**, and **Scope: Personal** rows. Account ownership follows the Gateway-assigned profile, not an unsaved display-name edit. Single-user connections can use the durable **Owner** profile; every device using that profile shares its accounts. To distinguish people on a shared server, use the Gateway's identity-bearing endpoint. If no profile is assigned, the section explains what is missing and links to **Connection settings** instead of showing credential inputs. Browser identity does not transfer to the CLI. See [personal-account CLI setup](/cli/models#personal-model-accounts).

The page lists saved accounts with friendly labels and marks the new-chat default. Select another saved account to change that default without signing in again. **Load more** continues through larger account lists. **Use Gateway defaults for new chats** clears the personal default; the saved accounts stay available.

The page reports the exact sign-in operation as pending, connected, cancelled, expired, or failed. **Cancel** asks the Gateway to retire that operation, including an exchange already in flight. Disconnecting, losing permission, or restarting the Gateway prevents an unfinished sign-in from starting another provider request or saving credentials; start a new sign-in after reconnecting. Refreshing profile identity does not interrupt account controls.

In **New session** or an existing chat, open the model menu and use **Account for this chat** to choose one of your saved accounts for the selected provider. The account picker remains available when **Automatic** has no eligible models. In New session, choosing an account previews eligible models before your first message. The selection applies to the session you create and can also be used for [draft-title preparation](/web/control-ui/sessions-and-sidebar#new-session-names) before you press Start; it does not change your new-chat default or saved model preference. Changing accounts discards the old title suggestion. In an existing chat, it changes that chat's selection.

The account control shows a collaborator a person-level label for someone else's personal account, not its private email, provider account label, or account id. The label describes the selection, not a billing receipt: configured shared failover accounts can still be used.

Chat status and model listings identify a selected personal credential as **personal account**, without exposing its private label, email, or account id.

The CLI uses the same Gateway operations through [`openclaw models accounts`](/cli/models#personal-model-accounts). Run `openclaw models accounts login` to choose a provider and method, or supply `login <provider> --method <id>` directly. Use `list` to inspect saved accounts. Each command shows the selected Gateway, verified person, and Personal scope. It targets that person, not `--agent` or the operating-system username.

Ask OpenClaw (Custodian) requires administrator access and a working configured inference route. Ask it to manage your personal model accounts, or enter `model accounts`. In the Control UI it opens **Settings → Profile → Connected accounts**; in a terminal it gives the CLI commands. If Custodian is unavailable, open **Connected accounts** or use the CLI directly. The handoff makes no change by itself. Complete sign-in in the protected controls or hidden terminal prompt, never in the conversation. Delegated agent requests cannot open or complete the human sign-in flow.

Credentials and the selected link are saved together in private, identity-scoped records in the shared state database (`state/openclaw.sqlite` under the Gateway state directory). There is no second account database or JSON sidecar. Pending sign-in operations live only in Gateway memory. Credentials are not added to the shared or agent-local auth stores, copied into global runtime snapshots, or included in automatic account rotation. Reconnecting replaces only a credential owned by that person. For ChatGPT, matching a workspace alone is not enough: the provider must also identify the same user. An administrator-linked shared account is never overwritten by a personal reconnect.

Administrators can still create shared profiles through the CLI (`openclaw models auth login --provider openai --profile-id openai:alice`, see [OAuth](/concepts/oauth)) and link them with `users.linkAuthProfile`. Attaching an existing shared credential is an admin decision; `users.unlinkAuthProfile` remains self-or-admin and `users.listAuthLinks` returns link metadata without secrets. A personal credential cannot be linked to another person's profile.

When a linked person creates a session, OpenClaw captures their default as that session's auth selection with the same strength as a `/model ...@profile` pin. This happens before an initial message is dispatched, including when creation and the first message are separate requests. Sessions first created by turn admission capture the default at that admission. The pin is **session-sticky**: teammates steering into that session use its selected account, and forks inherit it. An explicit `/model ...@profile -s` pin outranks the link. A fresh personal selection must belong to the authenticated human making it; knowing another person's account id is not permission to select it. Agent- and channel-originated turns do not create personal links. For runtimes using OpenClaw's auth fallback planner, the ordered shared profiles for the same provider remain failover candidates if the pinned account fails, just as with an explicit pin. Claude CLI requires its selected account and does not substitute shared profiles or its native login when that account cannot be used.

**Use Gateway defaults for new chats**, CLI `clear-default`, and API `users.unlinkAuthProfile` affect future sessions only. Changing a default does not repin existing chats, including unpinned chats using shared credentials. Adopting or forking an existing chat does not apply the current participant's default, and changing providers does not silently select their personal account. Use **Account for this chat** to make that explicit choice. Clearing a default neither deletes the saved credential nor revokes a provider token; revoke it with the provider if existing sessions must stop using it. Links and existing session credentials follow verified profile merges, but an explicit unlink on the surviving profile is not reversed by a merge.

This is account-selection convenience inside one trust domain, not isolation from administrators or code running as the Gateway OS user. On a compatible downgrade, older builds do not discover personal credentials as shared defaults; personal account selection is unavailable until a supporting version is restored.

## Finding sessions by owner

The sidebar's session filter menu gains an **Owners** section when ownership is visible:

- **All owners** shows everything (the default).
- A specific person or agent shows the sessions they currently own.
- **Involving me** shows sessions you own plus sessions where you have prompted at least once. This filter is evaluated by the Gateway against the full participant history and matches only your authenticated profile identity — channel-native sender ids are display-only and never match, so a numeric channel id cannot collide with your profile.

**Involving me** requires a signed-in Gateway profile. When the loaded sessions have multiple owners, **Group by Person** creates a section for each current owner, and the **Owners** sort mode orders those owner groups by name.

## Reading the avatars

The Control UI keeps ownership and presence visually distinct:

- A solid owner avatar on a session row is permanent for the lifetime of that session and always shows the current owner. It dims slightly while the owner is not connected.
- When other people or agents have prompted the session, the row avatar becomes a **pair-stack**: the owner stays in front, and either the single other participant peeks out behind, or a **+N** count summarizes several. The chat header shows the owner chip plus a participant facepile of up to four avatars. The owner is excluded from the participant display.
- Ringed or translucent presence avatars show people who are currently connected or watching; they come from live presence, not ownership, and disappear when those viewers leave. A person already shown by an owner or participant avatar is not repeated in that surface's live viewers. Participants summarized by a **+N** count can still appear individually as live viewers.
- Under **Group by Person**, the owner avatar in a section header shows a small green dot while that person is connected. It fades once they have been idle for a couple of minutes and disappears when they leave. Your own section never shows one.

When several people watch the same session, the transcript also shows a live typing indicator above the composer. Someone typing in the Control UI streams their draft text into the indicator bubble as they type; other typists show a three-dot bubble. Drafts are ephemeral presence: they are never persisted, never enter the session transcript or the model's context, and fade a moment after the typist pauses or sends.

When the loaded session list contains fewer than two distinct owner identities and no session has recorded outside participants, OpenClaw hides all ownership and owner-filter chrome. A single-user gateway therefore looks unchanged.

## People cards

Hover, focus, click, or tap a person in the sidebar's **Online** section to open their information card. Under **Group by Person**, the avatar and name in another person's section header open the same card; the chevron still collapses the section. An owner who is not connected gets a card marked **Offline** with only their recent sessions and the Activity link. For a qualified Gateway profile, select **View activity** in the card to open that person's Activity page. Unqualified viewers still have connection details and visible watched sessions, but no profile Activity link.

The card shows how long the person has been continuously connected, their reported app/device context and time zone, and their last observed activity during that online period. Opening a different session, typing, and sending a new message count as activity; connection heartbeats and agent responses do not. **Not observed yet** means no qualifying activity has been recorded, not that the person is inactive. These timing facts are ephemeral and reset after the person's final connection closes or the Gateway restarts.

People presence is shared with operators who have read access (`operator.read`, also implied by `operator.write` or `operator.admin`). Those readers may see other people's online and activity timing and reported time zone whether or not the person is watching a session. Node and pairing-only connections receive neither the presence inventory nor its activity-driven events. This does not change cross-reader IP visibility or provide isolation for all Gateway metadata; see [Who can see presence](/concepts/presence#who-can-see-presence).

**Viewing now** and **Recent sessions** link only to sessions available in your loaded session list. Recent sessions require the same recorded profile identity on both the viewer and the owner or creator; matching raw IDs are not enough. They are not a complete history of the person's contributions. Session update times describe the session, not when that person last acted. Connection descriptions and time zones are client-reported hints, not verified physical locations.

The Gateway also filters watched-session references for each recipient using `sessions.list` visibility rules, across connect snapshots, presence RPC responses, and events. Hidden or missing references are omitted without counts or placeholders; opening someone's card never borrows that person's session access.

## Mentioning people

In a normal Control UI chat, type `@` and select a person from the picker. The composer shows **Will notify** with your selected recipients. You can select up to ten mentions per message. Typing or pasting `@name` without selecting a person sends ordinary text and does not notify anyone. **Remove mention** clears the recipient selections while keeping the message text.

The picker includes known Gateway profiles eligible to read the session, including people who are offline. Its online indicator is only a connection hint, not an eligibility requirement. Sign in with a durable Gateway profile to use human mentions. A mention never adds session membership, changes visibility, or grants access; the Gateway rechecks the recipient's current access when creating and displaying it.

Mentions work for ordinary messages, queued or steered input, and the first message of a new session, including a remotely placed session. They are unavailable in incognito, Goal, catalog, suggestion-only, command-send, or terminal-launch modes. If selected mentions remain after switching to an unsupported mode, the composer blocks the send and asks you to remove them or return to a normal chat. It does not silently discard selected recipients.

## Temporary mentions Inbox

Open **Inbox → Mentions** to see messages addressed to your signed-in profile across accessible agents. Opening a mention opens its session without dismissing it. Select **Dismiss** to remove the entry from your Inbox; that change follows the same profile across connected browsers, without deleting the chat message.

Mentions are kept in Gateway memory for **up to seven days**, with at most **100 entries per profile**. Older entries can be evicted earlier by capacity limits. Refreshing or reconnecting to the same running Gateway reloads its current Inbox. A Gateway restart, including one during an upgrade, clears it. Old transcript messages do not repopulate the Inbox after restart. This is a temporary attention list, not a durable notification archive or delivery guarantee.

Human mentions add no SQLite tables, columns, or schema migration. The Inbox and its dismissals stay in memory; mention annotations use the existing message JSON, and notification preferences use existing preference records.

The Inbox works without browser notification permission. For optional alerts while away from the Control UI, enable **Someone mentions me** in [Notifications](/web/notifications#receive-human-mention-alerts). See [WebChat](/web/webchat#human-mention-delivery) for the send and retry contract.

## Agent-spawned sessions

Sessions an agent creates with `sessions_spawn` (`visible: true`) are attributed to the requesting agent: the creator and initial owner is the agent itself, and the sidebar shows the agent's configured identity name and avatar rather than an internal session key.

The accepted spawn result doubles as a receipt: it includes the child session key, the run id, a direct Control UI `sessionUrl` (omitted when the Control UI is disabled), and an `owner` record naming the requesting agent. When an agent acknowledges the spawn in a chat channel, it puts the session URL on the first line and `Owner: <label>` on the second, so you can open the session and see who is responsible at a glance. Reassign the session to yourself with **Assign to me** if you take the work over. See [Sub-agents](/tools/subagents) for the spawn lifecycle.

## Identity-scoped convenience state

When a connection has a durable Gateway profile, new-session preferences and picker recents follow that person across browsers. Preferences remain per agent, while recents are derived only from sessions that person created. Connections without a durable identity keep browser-local preferences and derive recents from the loaded session roster.

Single-user Gateways give unidentified operators one shared owner profile, including device-token reconnects. With `gateway.roles` configured, this applies only to token/password connections. Devices using that profile share its identity and preferences; use per-person sign-in to distinguish teammates. See [Gateway profiles](/concepts/user-model#gateway-profile-and-github-credit).

This state improves continuity; it is not an authorization or isolation boundary. Operator scopes still control actions, and a shared Gateway remains one trust domain for sessions, tools, credentials, and files.

## Drafts

Start a session as a draft to keep work in progress out of teammates' sidebars until you publish it. Drafts are never hidden from admins, who see other people's drafts with a faded ghost marker. This is a coordination feature, not a security boundary.

Catalog listings and progress updates recheck current session visibility for each recipient. Cached provider results do not preserve access to a session that has become draft or incognito. An adopted thread remains bound to its original session instance and plugin ownership; deleting and recreating a session key does not transfer the old thread to the new creator. Catalog reads and mutations also recheck the stored session after provider enumeration.

## Turn attribution

Turn sender attribution is best-effort. Steering can merge input into an active turn, so the transcript cannot always represent each person's contribution as a separate turn. Participant history records that an actor prompted the session, not which words were theirs.

Participant identity is separate from a display name and from authorization. An authenticated Gateway profile, an OpenClaw agent, and a remote sender remain distinct even when their IDs match. Channel plugins supply the remote identity domain and identifier kind when they can prove them. Otherwise, OpenClaw retains an unresolved observation; it does not guess a profile from a sender ID, local account label, or UUID shape. Profile merges resolve through the existing profile aliases. An accepted input updates an already retained current profile row, or a retained alias when no current row exists, even at the 32-record admission bound. Historical rows keep their raw IDs; this does not rewrite transcripts or other agent databases.

Profile participation records accepted externally authored input, including accepted steering into an active turn and session-targeted interactive input. Synthetic runs, internal messages, and bot or ambient work do not establish personal profile activity. A participant record is an aggregate, not an exact replay-safe lifetime input count. Reset preserves the logical session's participants; deleting the session removes them even when transcript archives are retained.

The normal admission limit is 32 identities per logical session. Existing identities can continue to contribute at that limit. Repair preserves already-retained larger histories instead of discarding them. The four-avatar header is only a preview: the Gateway evaluates person filters before pagination and preview truncation. Activity reports associated sessions, including verified creation or assigned responsibility, rather than claiming that session recency is a person's last input. Limited history and truncated results are identified as incomplete.

The schema-18 migration preserves historical membership and recorded contribution aggregates. Earlier writers could merge profile and channel timestamps, so ambiguous first and last input times become unknown. A later accepted input establishes a new recorded last time, but cannot recover a first-ever input time. No transcript, display-name, or UUID-based backfill runs. See [Database schemas](/reference/database-schemas#participant-identity-migration).

New transcript messages keep qualified sender identity separate from display names. Only qualified profile senders get profile portraits, person Activity links, or recognition as the signed-in person, and only their messages clear that profile's typing indicator. A matching channel sender ID is not enough. Write hooks can redact sender identity, but cannot replace it with another trusted identity. Suggestion attribution identifies the suggestion's author rather than the operator who accepts it.

Older or otherwise unqualified messages retain their saved text and sender labels, with initials instead of inferred profile portraits and no person Activity link. OpenClaw does not rewrite those messages or reconstruct their authors from UUIDs, profile lookups, or participant history. This can remove profile presentation from an older message that really was profile-authored, because it did not record enough evidence to establish that fact. Transcript attribution, participant aggregates, and creator-based access decisions remain separate contracts; attribution and participation never grant session access.

GitHub-backed sign-in through Cloudflare Access or Tailscale Serve automatically verifies the person's GitHub account under **Settings → Profile → Identity**. Public `Co-authored-by` credit remains a separate **Git co-author credit** toggle, on by default for verified accounts. Attribution uses that preference plus the durable profile participant records described above, not display names or the four-person facepile projection. See [User model](/concepts/user-model#gateway-profile-and-github-credit) for privacy, eligibility, bounds, account changes, and disabling future credit.

## Related

- [The main session](/concepts/main-session)
- [Session management](/concepts/session)
- [Session tools](/concepts/session-tool)
- [Presence](/concepts/presence)
- [Gateway security](/gateway/security)
