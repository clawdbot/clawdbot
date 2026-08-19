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

**Involving me** requires a signed-in Gateway profile. The **People** sort mode groups sessions by current owner and orders the groups by name.

## Reading the avatars

The Control UI keeps ownership and presence visually distinct:

- A solid owner avatar on a session row is permanent for the lifetime of that session and always shows the current owner. It dims slightly while the owner is not connected.
- When other people or agents have prompted the session, the row avatar becomes a **pair-stack**: the owner stays in front, and either the single other participant peeks out behind, or a **+N** count summarizes several. The chat header shows the owner chip plus a participant facepile of up to four avatars. The owner is excluded from the participant display.
- Ringed or translucent presence avatars show people who are currently connected or watching; they come from live presence, not ownership, and disappear when those viewers leave.

When the loaded session list contains fewer than two distinct owner identities and no session has recorded outside participants, OpenClaw hides all ownership and owner-filter chrome. A single-user gateway therefore looks unchanged.

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

Authenticated people can link a GitHub account under **Settings → Profile → Identity**. Linking is an explicit opt-in to public `Co-authored-by` credit on commits an agent creates from sessions they have prompted. Attribution uses the durable profile participant records described above, not display names or the four-person facepile projection. See [User model](/concepts/user-model#gateway-profile-and-github-credit) for privacy, eligibility, bounds, and unlink behavior.

## Related

- [The main session](/concepts/main-session)
- [Session management](/concepts/session)
- [Session tools](/concepts/session-tool)
- [Presence](/concepts/presence)
- [Gateway security](/gateway/security)
