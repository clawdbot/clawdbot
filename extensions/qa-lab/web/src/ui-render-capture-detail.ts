import { captureEventKey } from "./ui-render-capture-events.js";
import { renderCaptureHeaders, renderCaptureKeyValueGrid } from "./ui-render-capture-format.js";
import type { CaptureViewModel } from "./ui-render-capture-model.js";
import { redactCaptureValue } from "./ui-render-capture-redaction.js";
import { esc, formatDuration } from "./ui-render-utils.js";

export function renderCaptureDetailView(model: CaptureViewModel): string {
  const {
    state,
    selectedFlowEvents,
    selectedFlowIndex,
    selectedEvent,
    previousFlowEvent,
    previousFlowEventVisible,
    nextFlowEvent,
    nextFlowEventVisible,
    selectedPairing,
    pairingLatencyMs,
    pairedEventVisible,
    pairedEvent,
    effectiveFlowLayout,
    effectiveDetailView,
    effectivePayloadLayout,
    effectivePayloadExtent,
    selectedPayload,
    rawPayloadBody,
    selectedHeaderCount,
    selectedSensitiveHeaderCount,
    selectedHeaders,
    selectedMetaRows,
  } = model;
  const flowSections = {
    navigation:
      selectedFlowEvents.length > 0
        ? `<section class="capture-detail-section">
            <div class="capture-summary-header">
              <div class="capture-summary-label">Flow Navigation</div>
              <div class="capture-detail-mini-meta">
                <span class="capture-chip">${selectedFlowIndex + 1} / ${selectedFlowEvents.length}</span>
                <span class="capture-chip capture-chip-muted">${esc(selectedEvent?.flowId || "")}</span>
              </div>
            </div>
            <div class="capture-nav-row">
              ${
                previousFlowEvent
                  ? `<button class="capture-nav-button" data-capture-event="${esc(captureEventKey(previousFlowEvent))}" type="button">
                      <span class="capture-nav-label">Previous on flow</span>
                      <span class="capture-nav-meta">${esc(previousFlowEvent.kind)} · ${esc(new Date(previousFlowEvent.ts).toLocaleTimeString())}${
                        previousFlowEventVisible ? "" : " · outside current view"
                      }</span>
                    </button>`
                  : '<div class="capture-nav-placeholder">No earlier event on this flow.</div>'
              }
              ${
                nextFlowEvent
                  ? `<button class="capture-nav-button" data-capture-event="${esc(captureEventKey(nextFlowEvent))}" type="button">
                      <span class="capture-nav-label">Next on flow</span>
                      <span class="capture-nav-meta">${esc(nextFlowEvent.kind)} · ${esc(new Date(nextFlowEvent.ts).toLocaleTimeString())}${
                        nextFlowEventVisible ? "" : " · outside current view"
                      }</span>
                    </button>`
                  : '<div class="capture-nav-placeholder">No later event on this flow.</div>'
              }
            </div>
          </section>`
        : '<div class="empty-state">This event does not have a usable flow.</div>',
    pair: pairedEvent
      ? `<section class="capture-detail-section">
            <div class="capture-summary-header">
              <div class="capture-summary-label">Paired ${esc(selectedPairing.role || "counterpart")}</div>
              <div class="capture-detail-mini-meta">
                ${pairingLatencyMs != null ? `<span class="capture-chip">${formatDuration(pairingLatencyMs)}</span>` : ""}
                ${
                  pairedEventVisible
                    ? '<span class="capture-chip capture-chip-strong">visible now</span>'
                    : '<span class="capture-chip capture-chip-muted">outside current window/filter</span>'
                }
              </div>
            </div>
            <button class="capture-pair-card" data-capture-event="${esc(captureEventKey(pairedEvent))}" type="button">
              <div class="capture-pair-card-top">
                <strong>${esc(pairedEvent.kind)}</strong>
                <span class="text-dimmed text-sm">${esc(new Date(pairedEvent.ts).toLocaleTimeString())}</span>
                ${pairedEvent.status ? `<span class="text-dimmed text-sm">status ${pairedEvent.status}</span>` : ""}
              </div>
              <div class="capture-pair-card-target">${esc(
                [pairedEvent.method, pairedEvent.host, pairedEvent.path]
                  .filter(Boolean)
                  .join(" ") || pairedEvent.flowId,
              )}</div>
              <div class="text-dimmed text-sm">${esc(
                [pairedEvent.provider, pairedEvent.model, pairedEvent.api]
                  .filter(Boolean)
                  .join(" · ") || "same flow",
              )}</div>
            </button>
          </section>`
      : selectedEvent?.kind === "request" || selectedEvent?.kind === "response"
        ? `<section class="capture-detail-section">
              <div class="capture-summary-label">Paired ${esc(
                selectedEvent.kind === "request" ? "response" : "request",
              )}</div>
              <div class="empty-state">No unambiguous counterpart was found on this flow.</div>
            </section>`
        : "",
  };
  const renderDetailView = () => {
    if (!selectedEvent) {
      return "";
    }
    if (effectiveDetailView === "flow") {
      return `
        <div class="capture-detail-stack">
          <div class="capture-subview-switch" role="radiogroup" aria-label="Flow layout">
            <label class="capture-detail-view-option">
              <input type="radio" name="capture-flow-layout" value="nav-first"${
                effectiveFlowLayout === "nav-first" ? " checked" : ""
              } />
              <span>Nav first</span>
            </label>
            <label class="capture-detail-view-option">
              <input type="radio" name="capture-flow-layout" value="pair-first"${
                effectiveFlowLayout === "pair-first" ? " checked" : ""
              } />
              <span>Pair first</span>
            </label>
          </div>
          ${effectiveFlowLayout === "pair-first" ? flowSections.pair + flowSections.navigation : flowSections.navigation + flowSections.pair}
        </div>`;
    }
    if (effectiveDetailView === "payload") {
      return `
        <section class="capture-detail-section">
          <div class="capture-subview-switch" role="radiogroup" aria-label="Payload layout">
            <label class="capture-detail-view-option">
              <input type="radio" name="capture-payload-layout" value="formatted"${
                effectivePayloadLayout === "formatted" ? " checked" : ""
              } />
              <span>Formatted</span>
            </label>
            <label class="capture-detail-view-option">
              <input type="radio" name="capture-payload-layout" value="raw"${
                effectivePayloadLayout === "raw" ? " checked" : ""
              } />
              <span>Raw preview</span>
            </label>
          </div>
          <div class="capture-subview-switch" role="radiogroup" aria-label="Payload extent">
            <label class="capture-detail-view-option">
              <input type="radio" name="capture-payload-extent" value="preview"${
                effectivePayloadExtent === "preview" ? " checked" : ""
              } />
              <span>Preview</span>
            </label>
            <label class="capture-detail-view-option">
              <input type="radio" name="capture-payload-extent" value="full"${
                effectivePayloadExtent === "full" ? " checked" : ""
              } />
              <span>Full inline</span>
            </label>
          </div>
          <div class="capture-summary-header">
            <div class="capture-summary-label">Payload</div>
            <div class="capture-detail-mini-meta">
              <span class="capture-chip">${esc(selectedPayload.mode)}</span>
              <span class="capture-chip">${esc(selectedEvent.contentType || "unknown content-type")}</span>
              ${selectedPayload.byteLength > 0 ? `<span class="capture-chip">${selectedPayload.byteLength.toLocaleString()} bytes previewed</span>` : ""}
              ${
                selectedPayload.mode === "sse" && selectedPayload.itemCount != null
                  ? `<span class="capture-chip capture-chip-muted">${selectedPayload.visibleItemCount ?? selectedPayload.itemCount}/${selectedPayload.itemCount} frames</span>`
                  : ""
              }
              ${selectedEvent.dataBlobId ? '<span class="capture-chip capture-chip-strong">blob-backed</span>' : ""}
            </div>
          </div>
          ${
            selectedPayload.mode === "sse"
              ? `<div class="capture-payload-toolbar">
                  <div class="capture-detail-radio-row" role="radiogroup" aria-label="Payload event sort">
                    <label class="capture-detail-view-option">
                      <input type="radio" name="capture-payload-event-sort" value="stream"${
                        state.capturePayloadEventSort === "stream" ? " checked" : ""
                      } />
                      <span>Stream order</span>
                    </label>
                    <label class="capture-detail-view-option">
                      <input type="radio" name="capture-payload-event-sort" value="name"${
                        state.capturePayloadEventSort === "name" ? " checked" : ""
                      } />
                      <span>Name</span>
                    </label>
                    <label class="capture-detail-view-option">
                      <input type="radio" name="capture-payload-event-sort" value="size"${
                        state.capturePayloadEventSort === "size" ? " checked" : ""
                      } />
                      <span>Largest first</span>
                    </label>
                  </div>
                  <label class="capture-search-field capture-payload-filter-field">Filter
                    <input
                      id="capture-payload-event-filter"
                      type="search"
                      value="${esc(state.capturePayloadEventFilter)}"
                      placeholder="event name, field, payload text..."
                      spellcheck="false"
                    />
                  </label>
                </div>`
              : ""
          }
          <div class="capture-detail-payload capture-detail-payload--${effectivePayloadExtent}">
            ${effectivePayloadLayout === "raw" ? rawPayloadBody : selectedPayload.body}
            ${
              effectivePayloadLayout !== "raw" && selectedPayload.looksStructured
                ? '<div class="text-dimmed text-sm capture-detail-note">Structured payloads are pretty-printed and secret-like fields are redacted for the UI.</div>'
                : ""
            }
          </div>
        </section>
        ${
          selectedEvent.dataBlobId
            ? `<section class="capture-detail-section">
                <div class="capture-summary-header">
                  <div class="capture-summary-label">Stored Blob</div>
                  <div class="capture-detail-mini-meta">
                    <span class="capture-chip">full payload</span>
                  </div>
                </div>
                <div class="capture-detail-actions">
                  <span class="capture-mono">${esc(selectedEvent.dataBlobId)}</span>
                  <a class="btn-sm" href="/api/capture/blob?id=${encodeURIComponent(selectedEvent.dataBlobId)}" target="_blank" rel="noreferrer">Open blob</a>
                </div>
                <div class="text-dimmed text-sm capture-detail-note">Blob access is intentionally raw and may contain unredacted content.</div>
              </section>`
            : ""
        }`;
    }
    if (effectiveDetailView === "headers") {
      return `
        <section class="capture-detail-section">
          <div class="capture-summary-header">
            <div class="capture-summary-label">Headers</div>
            <div class="capture-detail-mini-meta">
              <span class="capture-chip">${selectedHeaderCount} captured</span>
              ${selectedSensitiveHeaderCount > 0 ? `<span class="capture-chip capture-chip-warn">${selectedSensitiveHeaderCount} redacted</span>` : ""}
              <span class="capture-chip capture-chip-muted">${esc(state.captureHeaderMode)}</span>
            </div>
          </div>
          ${renderCaptureHeaders(selectedEvent.headersJson, state.captureHeaderMode)}
          ${
            state.captureHeaderMode !== "hidden" && selectedSensitiveHeaderCount > 0
              ? '<div class="text-dimmed text-sm capture-detail-note">Sensitive header values are redacted in the UI.</div>'
              : ""
          }
        </section>
        ${
          selectedHeaders && state.captureHeaderMode !== "hidden"
            ? `<details class="capture-detail-raw">
                <summary class="text-dimmed text-sm">Redacted headers JSON</summary>
                <pre class="report-pre capture-pre capture-pre-json">${esc(
                  JSON.stringify(redactCaptureValue(selectedHeaders), null, 2),
                )}</pre>
              </details>`
            : ""
        }`;
    }
    return `
      <div class="capture-detail-stack">
        <section class="capture-detail-section">
          <div class="capture-summary-label">Overview</div>
          ${renderCaptureKeyValueGrid([
            { label: "time", value: new Date(selectedEvent.ts).toLocaleString() },
            {
              label: "target",
              value:
                [selectedEvent.method, selectedEvent.host, selectedEvent.path]
                  .filter(Boolean)
                  .join(" ") || "n/a",
            },
            {
              label: "provider route",
              value:
                [selectedEvent.provider, selectedEvent.model, selectedEvent.api]
                  .filter(Boolean)
                  .join(" · ") || "unlabeled",
            },
            { label: "capture origin", value: selectedEvent.captureOrigin || "runtime/default" },
          ])}
        </section>
        <section class="capture-detail-section">
          <div class="capture-summary-label">Fields</div>
          ${renderCaptureKeyValueGrid(selectedMetaRows)}
        </section>
        ${
          selectedEvent.errorText
            ? `<section class="capture-detail-section"><div class="capture-summary-label">Error</div><div class="capture-error">${esc(selectedEvent.errorText)}</div></section>`
            : ""
        }
      </div>`;
  };
  return renderDetailView();
}
