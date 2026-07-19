---
summary: "How the mac app embeds the gateway WebChat and how to debug it"
read_when:
  - Debugging mac WebChat view or loopback port
title: "WebChat (macOS)"
---

The macOS menu bar app embeds the WebChat UI as a native SwiftUI view. It connects to the Gateway and defaults to the primary session for the selected agent (`main`, or `global` when `session.scope` is `global`).

The full chat window is a native split view:

- **Sessions sidebar**: searchable session list with pinned, gateway-backed group, and recent sections. Spawned child sessions nest beneath their parent inside each section; collapsed parents summarize running, failed, and unread descendants. Context menus support session info, rename, pin, fork, read/unread, archive/restore, copy session key, and delete. The primary new-session action (or Cmd-N) creates immediately via `sessions.create`; its adjacent options popover can select an agent and request a managed worktree with an optional base ref.
- **Window toolbar**: context-usage ring (tokens and session cost, with a compact action), model controls, and a session actions menu. Models are grouped by provider with the default provider first, while pinned and recent models remain at the top. The controls can inherit or override the model's thinking level, choose tool-call verbosity, and toggle Fast responses. The menu can rename or fork the current session and update its pin, read, or archive state. **Sessions…** (Shift-Cmd-S) opens the Active/Archived manager for gateway search, group management, session inspection, rename, pin, archive, and restore. Select mode applies pin, unpin, archive, or delete to several active sessions while keeping individual failures visible. Separate menu checkmarks show or hide assistant reasoning and tool activity; both are on by default and remembered across launches.
- **Transcript and composer**: assistant messages render as plain text with an avatar, user messages as accent bubbles. Pending agent questions render as native cards with single- or multi-select options, free-text **Other** answers, expiry countdowns, and shared terminal state. Empty chats offer desktop starter prompts. Typing `/` opens slash-command autocomplete backed by `commands.list`, with arrow/Tab/Return/Escape keyboard navigation. Right-click a message to copy its visible Markdown without hidden reasoning. Truncated assistant messages also offer **Open Full Message**, which loads a selectable Markdown reader. Use **Listen** for gateway TTS with a local speech fallback.
- **Voice controls**: the composer can start or stop the existing macOS Talk Mode without replacing its menu-bar overlay. While Talk Mode is active, the composer shows its listening/thinking/speaking state, live audio activity, and an expandable rolling transcript. Right-click the Talk button to choose **System Default** or a connected microphone; this is the same microphone selection used by Voice Wake and push-to-talk. If a selected microphone disconnects, the active Talk session falls back to the system default and tries the selection again the next time Talk Mode starts. A separate microphone action records a voice note when Talk Mode does not own audio capture.

The anchored compact chat panel from the menu bar keeps the compact single-column layout with the same model, thinking, verbosity, and Fast controls inline, plus starter prompts, Talk Mode, voice notes, and Listen. Assistant reasoning and tool activity remain hidden in this compact surface.

## Quick Chat bar

Press Option-Space (⌥Space) or choose **Quick Chat** from the menu bar menu to open a floating composer for the main session. Change the global shortcut with the recorder in **Settings → General → Quick Chat shortcut**.

Quick Chat shows the targeted agent (avatar or emoji, with the agent's name as the placeholder) and sends to that agent's main session. After Return accepts a send, the bar stays open and expands downward with the streamed Markdown reply and recent transcript. The bar input remains the composer. Press Command-Return to send and open the same target in the full chat window, Shift-Return for a newline, or Escape to dismiss the whole bar and reply area. Clicking outside also dismisses it. When relevant macOS permissions are missing, an attached strip offers **Grant** and **Not now** actions.

Use the microphone button to dictate into the composer. Partial speech results replace the dictated span live while preserving text that was already in the composer. Press the button again, Return, or Escape to stop; sending, hiding, or unfocusing Quick Chat also releases the microphone. The first use asks for macOS Microphone and Speech Recognition access.

The compact model control shows the target session's current model and reasoning level. A model choice updates that session and therefore persists there, while a reasoning choice applies only to each message sent from the current Quick Chat presentation. Local choices reset when the bar hides. Switching agents or choosing a recent session keeps explicit choices but reloads the newly targeted session's underlying model state.

Click the history button to choose from the five most recently updated sessions or return to **New message to &lt;agent&gt;**. A recent selection sends to that exact session and changes the placeholder to **Reply in &lt;session&gt;**. Hiding Quick Chat resets this temporary target to the selected agent's main session; switching agents from the avatar menu also clears it.

Command-Return opens the conversation of the agent that received the send, including when session scope is global.

The camera button opens a menu for **Capture Window…** or **Capture Area…**. Window capture labels every visible window; area capture dims each display while you drag a region and shows its live size. The selected screenshot is sent to the chosen agent with any typed text as its caption. The first use asks for macOS Screen Recording access. Escape, clicking empty space, or clicking without a meaningful area drag cancels.

Use the document-text button to attach text from the focused app's focused window. Quick Chat shows the result as a removable context chip rather than placing the captured text in the composer; sending appends the chip's text to the outgoing message and then clears it. This requires macOS Accessibility permission. Attached text also clears whenever Quick Chat closes, so context from one presentation cannot leak into a later send.

After a reply finishes, choose **Paste to &lt;app&gt;** to copy its visible assistant text, excluding hidden reasoning, to the general pasteboard and paste it into the app that was frontmost. This requires macOS Accessibility permission. The action replaces the current pasteboard contents and then hides Quick Chat.

Disable the feature entirely with **Settings → General → Quick Chat**; the same section hosts the shortcut recorder.

- **Local mode**: connects directly to the local Gateway WebSocket.
- **Remote mode**: forwards the Gateway control port over SSH and uses that tunnel as the data plane.

## Launch and debugging

- Manual: Lobster menu -> "Open Chat".
- Auto-open for testing:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --chat
  ```

  (`--webchat` is accepted as a legacy alias.)

- Logs: `./scripts/clawlog.sh` (subsystem `ai.openclaw`, category `WebChatSwiftUI`).

## How it is wired

- Data plane: Gateway WS methods `chat.history`, `chat.message.get`, `chat.send`, `chat.abort`, `chat.inject`, plus `question.list` and `question.resolve`, and events `chat`, `agent`, `presence`, `tick`, `health`; question cards follow `question.requested` and `question.resolved` events and refresh from `question.list` after reconnects.
- `chat.history` returns a display-normalized transcript: inline directive tags are stripped from visible text, plain-text tool-call XML payloads (`<tool_call>`, `<function_call>`, `<tool_calls>`, `<function_calls>`, including truncated blocks) and leaked model control tokens are stripped, pure silent-token assistant rows such as exact `NO_REPLY`/`no_reply` are omitted, and oversized rows can be replaced with a truncated placeholder.
- Session: defaults to the primary session as above; the UI can switch between sessions.
- Session groups: `sessions.groups.list`, `sessions.groups.put`, `sessions.groups.rename`, and `sessions.groups.delete` own the group catalog. Membership is the session `category` updated through `sessions.patch`.
- Unread state: after a session activates and its live history loads successfully, the app clears that session's unread marker. Failed history loads do not clear it; a transient patch failure retries on the next activation.
- Onboarding uses a dedicated session to keep first-run setup separate.
- Offline cache: the app keeps a small read-only cache of recent chat sessions and transcripts per gateway (`~/Library/Application Support/OpenClaw/chat-cache.sqlite`): cold opens paint the last known transcript immediately and refresh once the Gateway responds, and recent chats stay browsable while disconnected (sending stays disabled until the connection is back).

## Security surface

- Remote mode forwards only the Gateway WebSocket control port over SSH.

## Known limitations

- The UI is optimized for chat sessions, not a full browser sandbox.

## Related

- [WebChat](/web/webchat)
- [macOS app](/platforms/macos)
