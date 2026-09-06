import AppKit
import Foundation
import SwiftUI

enum ExecApprovalsPromptPresenter {
    private struct PendingPrompt {
        let id: UUID
        let continuation: CheckedContinuation<Bool, Never>
    }

    private struct ActivePrompt {
        let id: UUID
        var panel: NSPanel?
        var continuation: CheckedContinuation<ExecApprovalDecision?, Never>?
        var cancelled = false
    }

    @MainActor
    private static var activePrompt: ActivePrompt?
    @MainActor
    private static var pendingPrompts: [PendingPrompt] = []

    @MainActor
    static func prompt(
        _ request: ExecApprovalPromptRequest,
        timeoutMs: Int? = nil) async -> ExecApprovalDecision?
    {
        if let timeoutMs, timeoutMs <= 0 { return nil }
        let promptID = UUID()
        let timeoutWorkItem = timeoutMs.map { _ in
            DispatchWorkItem {
                MainActor.assumeIsolated {
                    self.cancelPrompt(id: promptID)
                }
            }
        }
        if let timeoutMs, let timeoutWorkItem {
            DispatchQueue.main.asyncAfter(
                deadline: .now() + .milliseconds(timeoutMs),
                execute: timeoutWorkItem)
        }
        defer { timeoutWorkItem?.cancel() }
        return await withTaskCancellationHandler {
            guard !Task.isCancelled, await self.acquirePrompt(id: promptID) else { return nil }
            guard !Task.isCancelled, self.activePrompt?.cancelled != true else {
                self.releasePrompt(id: promptID)
                return nil
            }
            let decision = await self.runPrompt(request, id: promptID)
            let cancelled = self.activePrompt?.id == promptID && self.activePrompt?.cancelled == true
            self.releasePrompt(id: promptID)
            return Task.isCancelled || cancelled ? nil : decision
        } onCancel: {
            // Caller deadlines cancel only their own panel or queued request.
            // An expired approval must not outlive or block later requests.
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self.cancelPrompt(id: promptID)
                }
            }
        }
    }

    @MainActor
    private static func runPrompt(
        _ request: ExecApprovalPromptRequest,
        id: UUID) async -> ExecApprovalDecision?
    {
        await withCheckedContinuation { continuation in
            guard self.activePrompt?.id == id else {
                continuation.resume(returning: nil)
                return
            }
            let panel = self.buildPanel(request) { decision in
                self.finishPrompt(id: id, decision: decision)
            }
            self.activePrompt?.panel = panel
            self.activePrompt?.continuation = continuation
            NSApp.activate(ignoringOtherApps: true)
            panel.center()
            panel.makeKeyAndOrderFront(nil)
            panel.makeFirstResponder(nil)
            // A nested runModal loop blocks SwiftUI's MainActor callbacks and deadlines.
            // Suspend this caller instead; the queue still owns one active approval.
        }
    }

    @MainActor
    private static func finishPrompt(id: UUID, decision: ExecApprovalDecision?) {
        guard self.activePrompt?.id == id, let continuation = self.activePrompt?.continuation else { return }
        self.activePrompt?.continuation = nil
        self.activePrompt?.panel?.close()
        self.activePrompt?.panel = nil
        continuation.resume(returning: decision)
    }

    @MainActor
    private static func acquirePrompt(id: UUID) async -> Bool {
        // Keep one approval visible; caller cancellation and deadlines remove expired waiters.
        if self.activePrompt == nil {
            self.activePrompt = ActivePrompt(id: id)
            return true
        }
        return await withCheckedContinuation { continuation in
            self.pendingPrompts.append(PendingPrompt(id: id, continuation: continuation))
        }
    }

    @MainActor
    private static func releasePrompt(id: UUID) {
        guard self.activePrompt?.id == id else { return }
        self.activePrompt = nil
        guard !self.pendingPrompts.isEmpty else { return }
        let next = self.pendingPrompts.removeFirst()
        self.activePrompt = ActivePrompt(id: next.id)
        next.continuation.resume(returning: true)
    }

    @MainActor
    private static func cancelPrompt(id: UUID) {
        if self.activePrompt?.id == id {
            self.activePrompt?.cancelled = true
            self.finishPrompt(id: id, decision: nil)
            return
        }
        guard let index = self.pendingPrompts.firstIndex(where: { $0.id == id }) else { return }
        let pending = self.pendingPrompts.remove(at: index)
        pending.continuation.resume(returning: false)
    }

    static func allowedPromptDecisions(_ request: ExecApprovalPromptRequest) -> [ExecApprovalDecision] {
        if let allowedDecisions = request.allowedDecisions, !allowedDecisions.isEmpty {
            return allowedDecisions
        }
        return ExecApprovalPromptRequest.allowedDecisions(forAsk: request.ask)
    }

    @MainActor
    static func buildPanel(
        _ request: ExecApprovalPromptRequest,
        onDecision: @escaping (ExecApprovalDecision?) -> Void) -> NSPanel
    {
        let screenSize = NSScreen.main?.visibleFrame.size ?? NSSize(width: 800, height: 700)
        let width = min(680, screenSize.width - 40)
        let command = ExecApprovalCommandDisplaySanitizer.sanitize(request.command)
        // Match the command viewer's font and horizontal insets when choosing its initial height.
        let commandBounds = (command as NSString).boundingRect(
            with: NSSize(width: width - 80, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)])
        let decisions = self.allowedPromptDecisions(request)
        let chromeHeight: CGFloat = 320 + (decisions.contains(.allowAlways) ? 30 : 0)
        let commandHeight = min(240, max(56, ceil(commandBounds.height) + 28))
        let size = NSSize(width: width, height: min(chromeHeight + commandHeight, screenSize.height - 80))
        let panel = ExecApprovalPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .fullSizeContentView, .resizable],
            backing: .buffered,
            defer: false)
        panel.onDismiss = { onDecision(decisions.contains(.deny) ? .deny : nil) }
        panel.level = .modalPanel
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.title = String(localized: "OpenClaw Command Approval")
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isReleasedWhenClosed = false
        panel.isRestorable = false
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.contentMinSize = NSSize(width: min(560, size.width), height: min(chromeHeight + 56, size.height))
        for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            panel.standardWindowButton(type)?.isHidden = true
        }
        let host = NSHostingView(rootView: ExecApprovalPanelView(
            request: request,
            decisions: decisions,
            onDecision: { onDecision($0) }))
        // The panel owns the bounds; long commands and paths scroll within them.
        // Intrinsic text width must never enlarge an approval beyond the display.
        host.sizingOptions = []
        panel.contentView = host
        return panel
    }

    static func sanitizedContextValue(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return ExecApprovalCommandDisplaySanitizer.sanitize(trimmed)
    }
}

private final class ExecApprovalPanel: NSPanel {
    var onDismiss: (() -> Void)?

    override func cancelOperation(_ sender: Any?) {
        self.onDismiss?()
    }
}

#if DEBUG
extension ExecApprovalsPromptPresenter {
    @MainActor
    static func reservePromptForTesting() -> UUID? {
        guard self.activePrompt == nil else { return nil }
        let id = UUID()
        self.activePrompt = ActivePrompt(id: id)
        return id
    }

    @MainActor
    static func releasePromptForTesting(id: UUID) {
        self.releasePrompt(id: id)
    }

    @MainActor
    static var pendingPromptCountForTesting: Int {
        self.pendingPrompts.count
    }
}
#endif
