---
summary: "How session ownership and presence work when several people operate one agent"
read_when:
  - You share one OpenClaw agent with other operators
  - You want to hand a session to another person or agent, or filter sessions by owner
  - You are deciding whether one shared agent provides enough isolation
title: "Multi-user mode"
---

Multi-user mode lets several trusted people operate the same OpenClaw agent. It adds session ownership, participant history, live presence, and owner filtering so a team can tell who started work, who is responsible for it now, and who has been involved.

## Trust boundary

Everyone who can operate an agent can make it do anything that agent can do. Session ownership, visibility in the sidebar, and presence indicators are usability features, not security boundaries.

If people must not access each other's sessions, tools, credentials, or files, give them separate agents or separate gateway/host trust boundaries. Do not rely on owner avatars or filters for isolation.

## The three ownership layers

Every session carries up to three layers of attribution:

- **Creator** (immutable): new sessions record a write-once `createdActor` when the creation path can prove who caused it. Authenticated people use their durable Gateway profile id; sessions spawned by an agent record that agent's id. Sessions created without a proven actor remain unattributed. Sharing and visibility authority stays anchored on the creator, even after the owner changes.
- **Owner** (assignable): the person or agent currently responsible for the session, in the style of a GitHub issue assignee. It defaults to the creator and can be reassigned at any time; the assignment records who reassigned it and when. The sidebar avatar, the owner filter, and People sorting all follow the current owner.
- **Participants** (history): everyone who has actually prompted the session — authenticated people, channel senders, and requesting agents — recorded automatically at each turn. The session's own agent and passive viewers are never recorded. Participant history is bounded (up to 32 distinct actors per session) and recorded best-effort in the background, so it never delays a turn.

Human display names and avatars are resolved from the current Gateway profile when session rows are returned; agent actors resolve from the configured agent identity. OpenClaw does not store display labels on session entries, so renaming a profile or agent updates the ownership UI without rewriting session history.

## Assigning an owner

In the Control UI, the session context menu (kebab or right-click on a sidebar row, and the same menu on the chat header) offers:

- **Assign to me**: take responsibility for the session yourself.
- **Assign to…**: pick from a submenu of known people and configured agents.

Agents can reassign ownership with the [`sessions` tool](/concepts/session-tool#managing-session-settings-and-groups) using `action: "assign_owner"` with `ownerType` (`"human"` or `"agent"`) and `ownerId`, targeting the current session by default or another visible session via `sessionKey`.

Both paths call the Gateway method `sessions.assignOwner` (`operator.write`). Assignment requires an identified caller — an authenticated Gateway profile or a trusted agent identity — and is authorized by session visibility. Agent owner ids must name a configured agent. After assignment the avatar tooltip switches from "Created by" to "Owned by".

Reassigning the owner changes responsibility and display only. It does not transfer sharing authority (which stays with the creator) and does not grant or remove any access.

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
- Ringed or translucent presence avatars show people who are currently connected or watching; they come from live presence, not ownership, and disappear when those viewers leave.

When several people watch the same session, the transcript also shows a live typing indicator above the composer. Someone typing in the Control UI streams their draft text into the indicator bubble as they type; other typists show a three-dot bubble. Drafts are ephemeral presence: they are never persisted, never enter the session transcript or the model's context, and fade a moment after the typist pauses or sends.

When the loaded session list contains fewer than two distinct owner identities and no session has recorded outside participants, OpenClaw hides all ownership and owner-filter chrome. A single-user gateway therefore looks unchanged.

## People cards

Hover, focus, click, or tap a person in the sidebar's **Online** section to open their information card. Select **View activity** in the card to open that person's Activity page.

The card shows how long the person has been continuously connected, their reported app/device context and time zone, and their last observed activity during that online period. Opening a different session, typing, and sending a new message count as activity; connection heartbeats and agent responses do not. **Not observed yet** means no qualifying activity has been recorded, not that the person is inactive. These timing facts are ephemeral and reset after the person's final connection closes or the Gateway restarts.

People presence is shared with operators who have read access (`operator.read`, also implied by `operator.write` or `operator.admin`). Those readers may see other people's online and activity timing and reported time zone whether or not the person is watching a session. Node and pairing-only connections receive neither the presence inventory nor its activity-driven events. This does not change cross-reader IP visibility or provide isolation for all Gateway metadata; see [Who can see presence](/concepts/presence#who-can-see-presence).

**Viewing now** and **Recent sessions** link only to sessions available in your loaded session list. Recent sessions reflect reliable ownership or creation attribution, not a complete history of the person's contributions. Session update times describe the session, not when that person last acted. Connection descriptions and time zones are client-reported hints, not verified physical locations.

The Gateway also filters watched-session references for each recipient using `sessions.list` visibility rules, across connect snapshots, presence RPC responses, and events. Hidden or missing references are omitted without counts or placeholders; opening someone's card never borrows that person's session access.

## Agent-spawned sessions

Sessions an agent creates with `sessions_spawn` (`visible: true`) are attributed to the requesting agent: the creator and initial owner is the agent itself, and the sidebar shows the agent's configured identity name and avatar rather than an internal session key.

The accepted spawn result doubles as a receipt: it includes the child session key, the run id, a direct Control UI `sessionUrl` (omitted when the Control UI is disabled), and an `owner` record naming the requesting agent. When an agent acknowledges the spawn in a chat channel, it puts the session URL on the first line and `Owner: <label>` on the second, so you can open the session and see who is responsible at a glance. Reassign the session to yourself with **Assign to me** if you take the work over. See [Sub-agents](/tools/subagents) for the spawn lifecycle.

## Identity-scoped convenience state

When a connection has a durable Gateway profile, new-session preferences and picker recents follow that person across browsers. Preferences remain per agent, while recents are derived only from sessions that person created. Connections without a durable identity keep browser-local preferences and derive recents from the loaded session roster.

This state improves continuity; it is not an authorization or isolation boundary. Operator scopes still control actions, and a shared Gateway remains one trust domain for sessions, tools, credentials, and files.

## Drafts

Start a session as a draft to keep work in progress out of teammates' sidebars until you publish it. Drafts are never hidden from admins, who see other people's drafts with a faded ghost marker. This is a coordination feature, not a security boundary.

## Turn attribution

Turn sender attribution is best-effort. Steering can merge input into an active turn, so the transcript cannot always represent each person's contribution as a separate turn. Participant history records that an actor prompted the session, not which words were theirs.

GitHub-backed sign-in through Cloudflare Access or Tailscale Serve automatically verifies the person's GitHub account under **Settings → Profile → Identity**. Public `Co-authored-by` credit remains a separate, default-off **Git co-author credit** toggle. Attribution uses that explicit preference plus the durable profile participant records described above, not display names or the four-person facepile projection. See [User model](/concepts/user-model#gateway-profile-and-github-credit) for privacy, eligibility, bounds, account changes, and disabling future credit.

## Related

- [The main session](/concepts/main-session)
- [Session management](/concepts/session)
- [Session tools](/concepts/session-tool)
- [Presence](/concepts/presence)
- [Gateway security](/gateway/security)
