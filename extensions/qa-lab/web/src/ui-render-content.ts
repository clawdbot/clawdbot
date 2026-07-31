import {
  conversationSelectionKey,
  findConversationBySelectionKey,
  messageConversationSelectionKey,
  threadConversationSelectionKey,
} from "./ui-conversation-key.js";
import { findScenarioOutcome } from "./ui-render-scenario.js";
import { badgeHtml, esc, formatIso, formatTime } from "./ui-render-utils.js";
import type { Attachment, Conversation, Message, SeedScenario, UiState } from "./ui-types.js";

function attachmentSourceUrl(attachment: Attachment): string | null {
  if (attachment.url?.trim()) {
    return attachment.url;
  }
  if (attachment.contentBase64?.trim()) {
    return `data:${attachment.mimeType};base64,${attachment.contentBase64}`;
  }
  return null;
}

function renderMessageAttachments(message: Message): string {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return "";
  }
  const items = attachments
    .map((attachment) => {
      const sourceUrl = attachmentSourceUrl(attachment);
      const label = attachment.fileName || attachment.altText || attachment.mimeType;
      if (attachment.kind === "image" && sourceUrl) {
        return `<figure class="msg-attachment msg-attachment-image">
          <img src="${esc(sourceUrl)}" alt="${esc(attachment.altText || label)}" loading="lazy" />
          <figcaption>${esc(label)}</figcaption>
        </figure>`;
      }
      if (attachment.kind === "video" && sourceUrl) {
        return `<figure class="msg-attachment msg-attachment-video">
          <video controls preload="metadata" src="${esc(sourceUrl)}"></video>
          <figcaption>${esc(label)}</figcaption>
        </figure>`;
      }
      if (attachment.kind === "audio" && sourceUrl) {
        return `<figure class="msg-attachment msg-attachment-audio">
          <audio controls preload="metadata" src="${esc(sourceUrl)}"></audio>
          <figcaption>${esc(label)}</figcaption>
        </figure>`;
      }
      const transcript = attachment.transcript?.trim()
        ? `<div class="msg-attachment-transcript">${esc(attachment.transcript)}</div>`
        : "";
      const href = sourceUrl ? ` href="${esc(sourceUrl)}" target="_blank" rel="noreferrer"` : "";
      return `<div class="msg-attachment msg-attachment-file">
        <a class="msg-attachment-link"${href}>${esc(label)}</a>
        ${transcript}
      </div>`;
    })
    .join("");
  return `<div class="msg-attachments">${items}</div>`;
}

function deriveSelectedConversation(state: UiState): string | null {
  const first = state.snapshot?.conversations[0];
  return state.selectedConversationKey ?? (first ? conversationSelectionKey(first) : null);
}

function deriveSelectedThread(state: UiState): string | null {
  return state.selectedThreadId ?? null;
}

function filteredMessages(state: UiState) {
  const messages = state.snapshot?.messages ?? [];
  return messages.filter((message) => {
    if (
      state.selectedConversationKey &&
      messageConversationSelectionKey(message) !== state.selectedConversationKey
    ) {
      return false;
    }
    if (state.selectedThreadId && message.threadId !== state.selectedThreadId) {
      return false;
    }
    return true;
  });
}

function formatConversationLabel(
  conversation: Conversation,
  conversations: Conversation[],
): string {
  const label = conversation.title || conversation.id;
  const hasAccountCollision = conversations.some(
    (candidate) =>
      candidate.accountId !== conversation.accountId &&
      candidate.kind === conversation.kind &&
      candidate.id === conversation.id,
  );
  return hasAccountCollision ? `${label} (${conversation.accountId})` : label;
}

export function renderChatView(state: UiState): string {
  const conversations = state.snapshot?.conversations ?? [];
  const channels = conversations.filter((c) => c.kind === "channel");
  const dms = conversations.filter((c) => c.kind === "direct");
  const threads = (state.snapshot?.threads ?? []).filter(
    (thread) =>
      !state.selectedConversationKey ||
      threadConversationSelectionKey(thread) === state.selectedConversationKey,
  );
  const selectedConv = deriveSelectedConversation(state);
  const selectedThread = deriveSelectedThread(state);
  const activeConversation = findConversationBySelectionKey(conversations, selectedConv);
  const messages = filteredMessages({
    ...state,
    selectedConversationKey: selectedConv,
    selectedThreadId: selectedThread,
  });

  return `
    <div class="chat-view">
      <!-- Channel / DM sidebar -->
      <aside class="chat-sidebar">
        <div class="chat-sidebar-scroll">
          <div class="chat-sidebar-section">
            <div class="chat-sidebar-heading">Channels</div>
            <div class="chat-sidebar-list">
              ${
                channels.length === 0
                  ? '<div class="chat-sidebar-item" style="color:var(--text-tertiary);font-size:12px;cursor:default">No channels</div>'
                  : channels
                      .map(
                        (c) => `
                          <button class="chat-sidebar-item${conversationSelectionKey(c) === selectedConv ? " active" : ""}" data-conversation-key="${esc(conversationSelectionKey(c))}">
                            <span class="chat-sidebar-icon">#</span>
                            <span class="chat-sidebar-label">${esc(formatConversationLabel(c, conversations))}</span>
                          </button>`,
                      )
                      .join("")
              }
            </div>
          </div>
          <div class="chat-sidebar-section">
            <div class="chat-sidebar-heading">Direct Messages</div>
            <div class="chat-sidebar-list">
              ${
                dms.length === 0
                  ? '<div class="chat-sidebar-item" style="color:var(--text-tertiary);font-size:12px;cursor:default">No DMs</div>'
                  : dms
                      .map(
                        (c) => `
                          <button class="chat-sidebar-item${conversationSelectionKey(c) === selectedConv ? " active" : ""}" data-conversation-key="${esc(conversationSelectionKey(c))}">
                            <span class="chat-sidebar-icon">\u25CF</span>
                            <span class="chat-sidebar-label">${esc(formatConversationLabel(c, conversations))}</span>
                          </button>`,
                      )
                      .join("")
              }
            </div>
          </div>
          ${
            threads.length > 0
              ? `<div class="chat-sidebar-section">
                  <div class="chat-sidebar-heading">Threads</div>
                  <div class="chat-sidebar-list">
                    <button class="chat-sidebar-item${!selectedThread ? " active" : ""}" data-thread-select="root">
                      <span class="chat-sidebar-icon">\u2302</span>
                      <span class="chat-sidebar-label">Main timeline</span>
                    </button>
                    ${threads
                      .map(
                        (t) => `
                          <button class="chat-sidebar-item${t.id === selectedThread ? " active" : ""}" data-thread-select="${esc(t.id)}" data-thread-conversation-key="${esc(threadConversationSelectionKey(t))}">
                            <span class="chat-sidebar-icon">\u21B3</span>
                            <span class="chat-sidebar-label">${esc(t.title)}</span>
                          </button>`,
                      )
                      .join("")}
                  </div>
                </div>`
              : ""
          }
        </div>
      </aside>

      <!-- Main chat area -->
      <div class="chat-main">
        <!-- Channel header -->
        <div class="chat-channel-header">
          <span class="chat-channel-name">${esc(activeConversation?.title || activeConversation?.id || "No conversation")}</span>
          ${activeConversation ? `<span class="chat-channel-kind">${activeConversation.kind}</span>` : ""}
          ${state.bootstrap?.runner.status === "running" ? '<span class="live-indicator"><span class="live-dot"></span>LIVE</span>' : ""}
        </div>

        <!-- Messages -->
        <div class="chat-messages" id="chat-messages">
          ${
            messages.length === 0
              ? '<div class="chat-empty">No messages yet. Run scenarios or send a message below.</div>'
              : messages.map((m) => renderMessage(m)).join("")
          }
        </div>

        <!-- Composer -->
        <div class="chat-composer">
          <div class="composer-context">
            <select id="conversation-kind">
              <option value="direct"${state.composer.conversationKind === "direct" ? " selected" : ""}>DM</option>
              <option value="channel"${state.composer.conversationKind === "channel" ? " selected" : ""}>Channel</option>
            </select>
            <span>as</span>
            <input id="sender-name" value="${esc(state.composer.senderName)}" placeholder="Name" />
            <span>in</span>
            <input id="conversation-id" value="${esc(state.composer.conversationId)}" placeholder="Conversation" />
            <input id="sender-id" type="hidden" value="${esc(state.composer.senderId)}" />
          </div>
          <div class="composer-input">
            <textarea id="composer-text" rows="1" placeholder="Type a message\u2026 (Enter to send, Shift+Enter for newline)">${esc(state.composer.text)}</textarea>
            <button class="btn-primary composer-send" data-action="send"${state.busy ? " disabled" : ""}>Send</button>
          </div>
        </div>
      </div>
    </div>`;
}

function messageAvatar(m: Message): { emoji: string; bg: string; role: string } {
  if (m.direction === "outbound") {
    return { emoji: "\uD83E\uDD80", bg: "#7c6cff", role: "Claw" }; // 🦀
  }
  return { emoji: "\uD83E\uDD9E", bg: "#d97706", role: "Clawfather" }; // 🦞
}

function renderMessage(m: Message): string {
  const name = m.senderName || m.senderId;
  const avatar = messageAvatar(m);
  const dirClass = m.direction === "inbound" ? "msg-direction-inbound" : "msg-direction-outbound";

  const metaTags: string[] = [];
  if (m.threadId) {
    metaTags.push(`<span class="msg-tag">thread ${esc(m.threadId)}</span>`);
  }
  if (m.editedAt) {
    metaTags.push('<span class="msg-tag">edited</span>');
  }
  if (m.deleted) {
    metaTags.push('<span class="msg-tag">deleted</span>');
  }

  const reactions =
    m.reactions.length > 0
      ? `<span class="msg-reactions">${m.reactions.map((r) => `<span class="msg-reaction">${esc(r.emoji)}</span>`).join("")}</span>`
      : "";

  return `
    <div class="msg msg-${m.direction}">
      <div class="msg-avatar" style="background:${avatar.bg}">${avatar.emoji}</div>
      <div class="msg-body">
        <div class="msg-header">
          <span class="msg-sender">${esc(name)}</span>
          <span class="msg-role">${esc(avatar.role)}</span>
          <span class="msg-direction ${dirClass}">${m.direction === "inbound" ? "\u2B06" : "\u2B07"}</span>
          <span class="msg-time">${formatTime(m.timestamp)}</span>
        </div>
        <div class="msg-text">${esc(m.text)}</div>
        ${renderMessageAttachments(m)}
        ${metaTags.length > 0 || reactions ? `<div class="msg-meta">${metaTags.join("")}${reactions}</div>` : ""}
      </div>
    </div>`;
}

function recentInspectorMessages(state: UiState, limit = 18) {
  return (state.snapshot?.messages ?? []).slice(-limit).toReversed();
}

function renderInspectorLiveMessage(message: Message): string {
  const avatar = messageAvatar(message);
  const conversationLabel = message.conversation.title || message.conversation.id;
  const threadLabel = message.threadTitle || message.threadId;

  return `
    <div class="inspector-live-message">
      <div class="inspector-live-message-head">
        <div class="inspector-live-message-identity">
          <span class="inspector-live-avatar" style="background:${avatar.bg}">${avatar.emoji}</span>
          <span class="inspector-live-sender">${esc(message.senderName || message.senderId)}</span>
          <span class="inspector-live-direction inspector-live-direction-${message.direction}">${message.direction === "inbound" ? "inbound" : "outbound"}</span>
        </div>
        <span class="inspector-live-time">${formatTime(message.timestamp)}</span>
      </div>
      <div class="inspector-live-channel">
        ${esc(conversationLabel)}${threadLabel ? ` · ${esc(threadLabel)}` : ""}
      </div>
      <div class="inspector-live-text">${esc(message.text)}</div>
    </div>`;
}

function renderInspectorLiveTranscript(state: UiState): string {
  const messages = recentInspectorMessages(state);
  const isLive = state.bootstrap?.runner.status === "running";

  return `
    <aside class="inspector-live">
      <div class="inspector-live-header">
        <div>
          <div class="inspector-section-title">Live Transcript</div>
          <div class="inspector-live-subtitle">
            ${isLive ? "Latest QA bus messages as the run progresses." : "Latest observed QA bus messages."}
          </div>
        </div>
        ${isLive ? '<span class="live-indicator"><span class="live-dot"></span>LIVE</span>' : ""}
      </div>
      <div class="inspector-live-feed">
        ${
          messages.length > 0
            ? messages.map((message) => renderInspectorLiveMessage(message)).join("")
            : '<div class="empty-state">No transcript yet. Start a run or send a message.</div>'
        }
      </div>
    </aside>`;
}

/* ===== Render: Results tab ===== */

export function renderResultsView(state: UiState): string {
  const scenarios = state.bootstrap?.scenarios ?? [];
  const selected = scenarios.find((s) => s.id === state.selectedScenarioId) ?? scenarios[0] ?? null;

  return `
    <div class="results-view">
      <div class="results-list">
        ${scenarios.length === 0 ? '<div class="empty-state">No scenarios loaded.</div>' : ""}
        ${scenarios
          .map((s) => {
            const outcome = findScenarioOutcome(state, s);
            const status = outcome?.status ?? "pending";
            const isSelected = s.id === (selected?.id ?? null);
            return `
              <button class="result-card${isSelected ? " selected" : ""}" data-scenario-id="${esc(s.id)}">
                <span class="result-card-dot scenario-item-dot-${status}"></span>
                <div class="result-card-info">
                  <span class="result-card-title">${esc(s.title)}</span>
                  <span class="result-card-sub">${esc(s.surface)} · ${outcome?.steps?.length ?? s.successCriteria.length} steps</span>
                </div>
                ${badgeHtml(status)}
              </button>`;
          })
          .join("")}
      </div>
      <div class="results-inspector">
        ${selected ? renderInspector(state, selected) : '<div class="inspector-empty">Select a scenario</div>'}
      </div>
    </div>`;
}

function renderInspector(state: UiState, scenario: SeedScenario): string {
  const outcome = findScenarioOutcome(state, scenario);
  const evidencePath = state.bootstrap?.runner.artifacts?.evidencePath ?? null;

  return `
    <div class="inspector-layout">
      <div class="inspector-main">
        <div class="inspector-header">
          <div>
            <div class="inspector-title">${esc(scenario.title)}</div>
            ${badgeHtml(outcome?.status ?? "pending")}
          </div>
          ${
            evidencePath
              ? `<button class="btn-sm" data-action="open-run-evidence" title="${esc(evidencePath)}">Open evidence</button>`
              : ""
          }
        </div>
        <div class="inspector-objective">${esc(scenario.objective)}</div>
        <div class="inspector-meta">
          <div class="inspector-meta-item"><span class="inspector-meta-label">Surface</span><span class="inspector-meta-value">${esc(scenario.surface)}</span></div>
          <div class="inspector-meta-item"><span class="inspector-meta-label">Started</span><span class="inspector-meta-value">${esc(formatIso(outcome?.startedAt))}</span></div>
          <div class="inspector-meta-item"><span class="inspector-meta-label">Finished</span><span class="inspector-meta-value">${esc(formatIso(outcome?.finishedAt))}</span></div>
          <div class="inspector-meta-item"><span class="inspector-meta-label">Run</span><span class="inspector-meta-value">${esc(state.scenarioRun?.kind ?? "seed only")}</span></div>
        </div>

        <div class="inspector-section">
          <div class="inspector-section-title">Success Criteria</div>
          <ul class="criteria-list">
            ${scenario.successCriteria.map((c) => `<li class="criteria-item"><span class="criteria-bullet"></span>${esc(c)}</li>`).join("")}
          </ul>
        </div>

        <div class="inspector-section">
          <div class="inspector-section-title">Observed Outcome</div>
          ${
            outcome
              ? `
                ${outcome.details ? `<div style="margin-bottom:12px;color:var(--text-secondary);font-size:13px">${esc(outcome.details)}</div>` : ""}
                <div class="step-list">
                  ${
                    outcome.steps?.length
                      ? outcome.steps
                          .map(
                            (step) => `
                              <div class="step-card">
                                <div class="step-card-header">
                                  <span class="step-card-name">${esc(step.name)}</span>
                                  ${badgeHtml(step.status)}
                                </div>
                                ${step.details ? `<div class="step-card-details">${esc(step.details)}</div>` : ""}
                              </div>`,
                          )
                          .join("")
                      : '<div class="empty-state">No step data yet.</div>'
                  }
                </div>`
              : '<div class="empty-state">Not executed yet — seed plan only.</div>'
          }
        </div>

        ${
          scenario.docsRefs?.length
            ? `<div class="inspector-section">
                <div class="inspector-section-title">Docs</div>
                <div class="ref-list">${scenario.docsRefs.map((r) => `<span class="ref-tag">${esc(r)}</span>`).join("")}</div>
              </div>`
            : ""
        }
        ${
          scenario.codeRefs?.length
            ? `<div class="inspector-section">
                <div class="inspector-section-title">Code</div>
                <div class="ref-list">${scenario.codeRefs.map((r) => `<span class="ref-tag">${esc(r)}</span>`).join("")}</div>
              </div>`
            : ""
        }
      </div>
      ${renderInspectorLiveTranscript(state)}
    </div>`;
}

/* ===== Render: Report tab ===== */

export function renderReportView(state: UiState): string {
  return `
    <div class="report-view">
      <div class="report-toolbar">
        <span class="report-toolbar-title">Protocol Report</span>
        <button class="btn-sm" data-action="download-report"${state.latestReport ? "" : " disabled"}>Export Markdown</button>
      </div>
      <div class="report-content">
        <pre class="report-pre">${esc(state.latestReport?.markdown ?? "Run the suite or self-check to generate a report.")}</pre>
      </div>
    </div>`;
}

export function renderEventsView(state: UiState): string {
  const events = (state.snapshot?.events ?? []).slice(-60).toReversed();

  return `
    <div class="events-view">
      <div class="events-header">
        <span class="events-header-title">Event Stream</span>
        <span class="text-dimmed text-sm">${events.length} events (newest first)</span>
      </div>
      <div class="events-scroll">
        ${
          events.length === 0
            ? '<div class="empty-state" style="padding:20px">No events yet.</div>'
            : events
                .map((e) => {
                  const detail =
                    "thread" in e
                      ? `${e.thread.conversationId}/${e.thread.id}`
                      : e.message
                        ? `${e.message.senderId}: ${e.message.text}`
                        : "";
                  return `
                    <div class="event-row">
                      <span class="event-kind">${esc(e.kind)}</span>
                      <span class="event-cursor">#${e.cursor}</span>
                      <span class="event-detail">${esc(detail)}</span>
                    </div>`;
                })
                .join("")
        }
      </div>
    </div>`;
}
