import AppKit
import Foundation

enum ExecApprovalsPromptPresenter {
    private struct PendingPrompt {
        let id: UUID
        let continuation: CheckedContinuation<Bool, Never>
    }

    @MainActor
    private static var activePrompt: (id: UUID, alert: NSAlert?, cancelled: Bool)?
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
            let decision = self.runPrompt(request, id: promptID)
            let cancelled = self.activePrompt?.id == promptID && self.activePrompt?.cancelled == true
            self.releasePrompt(id: promptID)
            return Task.isCancelled || cancelled ? nil : decision
        } onCancel: {
            // Caller deadlines cancel the prompt task. Abort the matching modal
            // session so an expired approval cannot outlive or block later requests.
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
        id: UUID) -> ExecApprovalDecision?
    {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Allow this command?"
        alert.informativeText = "Review the command details before allowing."
        alert.accessoryView = self.buildAccessoryView(request)

        let decisions = self.allowedPromptDecisions(request)
        for decision in decisions {
            alert.addButton(withTitle: self.buttonTitle(for: decision))
        }
        if #available(macOS 11.0, *),
           let denyIndex = decisions.firstIndex(of: .deny),
           alert.buttons.indices.contains(denyIndex)
        {
            alert.buttons[denyIndex].hasDestructiveAction = true
        }

        guard self.activePrompt?.id == id else { return nil }
        self.activePrompt?.alert = alert
        defer { self.activePrompt?.alert = nil }
        return self.decision(forModalResponse: alert.runModal(), decisions: decisions)
    }

    @MainActor
    private static func acquirePrompt(id: UUID) async -> Bool {
        // AppKit cannot cancel nested modal loops independently. Queue behind one
        // active alert; caller cancellation and deadlines remove expired waiters.
        if self.activePrompt == nil {
            self.activePrompt = (id: id, alert: nil, cancelled: false)
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
        self.activePrompt = (id: next.id, alert: nil, cancelled: false)
        next.continuation.resume(returning: true)
    }

    @MainActor
    private static func cancelPrompt(id: UUID) {
        if self.activePrompt?.id == id {
            self.activePrompt?.cancelled = true
            guard let alert = self.activePrompt?.alert else { return }
            if NSApp.modalWindow === alert.window {
                NSApp.abortModal()
            }
            alert.window.close()
            return
        }
        guard let index = self.pendingPrompts.firstIndex(where: { $0.id == id }) else { return }
        let pending = self.pendingPrompts.remove(at: index)
        pending.continuation.resume(returning: false)
    }

    static func decision(
        forModalResponse response: NSApplication.ModalResponse,
        decisions: [ExecApprovalDecision]) -> ExecApprovalDecision?
    {
        let selectedIndex = response.rawValue
            - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        if decisions.indices.contains(selectedIndex) {
            return decisions[selectedIndex]
        }
        return decisions.contains(.deny) ? .deny : nil
    }

    static func allowedPromptDecisions(_ request: ExecApprovalPromptRequest) -> [ExecApprovalDecision] {
        if let allowedDecisions = request.allowedDecisions, !allowedDecisions.isEmpty {
            return allowedDecisions
        }
        return ExecApprovalPromptRequest.allowedDecisions(forAsk: request.ask)
    }

    private static func buttonTitle(for decision: ExecApprovalDecision) -> String {
        switch decision {
        case .allowOnce:
            "Allow Once"
        case .allowAlways:
            "Always Allow Here"
        case .deny:
            "Don't Allow"
        }
    }

    @MainActor
    static func buildAccessoryView(_ request: ExecApprovalPromptRequest) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 8
        stack.alignment = .leading
        stack.widthAnchor.constraint(greaterThanOrEqualToConstant: 380).isActive = true

        let commandTitle = NSTextField(labelWithString: "Command")
        commandTitle.font = NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)
        stack.addArrangedSubview(commandTitle)

        let commandText = NSTextView()
        commandText.isEditable = false
        commandText.isSelectable = true
        commandText.drawsBackground = true
        commandText.backgroundColor = NSColor.textBackgroundColor
        commandText.font = NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        commandText.string = ExecApprovalCommandDisplaySanitizer.sanitize(request.command)
        commandText.textContainerInset = NSSize(width: 6, height: 6)
        commandText.textContainer?.lineFragmentPadding = 0
        commandText.textContainer?.widthTracksTextView = true
        commandText.isHorizontallyResizable = false
        commandText.isVerticallyResizable = true

        let commandScroll = NSScrollView()
        commandScroll.borderType = .lineBorder
        commandScroll.hasVerticalScroller = true
        commandScroll.hasHorizontalScroller = false
        commandScroll.autohidesScrollers = true
        commandScroll.documentView = commandText
        commandScroll.translatesAutoresizingMaskIntoConstraints = false
        commandScroll.widthAnchor.constraint(greaterThanOrEqualToConstant: 380).isActive = true
        commandScroll.widthAnchor.constraint(lessThanOrEqualToConstant: 440).isActive = true
        commandScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 56).isActive = true
        commandScroll.heightAnchor.constraint(lessThanOrEqualToConstant: 120).isActive = true
        stack.addArrangedSubview(commandScroll)

        let contextTitle = NSTextField(labelWithString: "Context")
        contextTitle.font = NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)
        stack.addArrangedSubview(contextTitle)

        let contextStack = NSStackView()
        contextStack.orientation = .vertical
        contextStack.spacing = 4
        contextStack.alignment = .leading

        if let cwd = self.sanitizedContextValue(request.cwd) {
            self.addDetailRow(title: "Working directory", value: cwd, to: contextStack)
        }
        if let agent = self.sanitizedContextValue(request.agentId) {
            self.addDetailRow(title: "Agent", value: agent, to: contextStack)
        }
        if let path = self.sanitizedContextValue(request.resolvedPath) {
            self.addDetailRow(title: "Executable", value: path, to: contextStack)
        }
        if let host = self.sanitizedContextValue(request.host) {
            self.addDetailRow(title: "Host", value: host, to: contextStack)
        }
        if let security = self.sanitizedContextValue(request.security) {
            self.addDetailRow(title: "Security", value: security, to: contextStack)
        }
        if let ask = self.sanitizedContextValue(request.ask) {
            self.addDetailRow(title: "Ask mode", value: ask, to: contextStack)
        }

        if contextStack.arrangedSubviews.isEmpty {
            let empty = NSTextField(labelWithString: "No additional context provided.")
            empty.textColor = NSColor.secondaryLabelColor
            empty.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
            contextStack.addArrangedSubview(empty)
        }

        stack.addArrangedSubview(contextStack)

        let footer = NSTextField(labelWithString: "This runs on this machine.")
        footer.textColor = NSColor.secondaryLabelColor
        footer.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        stack.addArrangedSubview(footer)

        // NSAlert reserves accessory space from the view frame, not from Auto Layout constraints.
        // Give the top-level accessory an explicit frame so its subviews do not paint over the
        // alert title, message, and buttons while the frame remains zero-sized.
        stack.frame = NSRect(origin: .zero, size: stack.fittingSize)
        return stack
    }

    static func sanitizedContextValue(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return ExecApprovalCommandDisplaySanitizer.sanitize(trimmed)
    }

    @MainActor
    private static func addDetailRow(title: String, value: String, to stack: NSStackView) {
        let row = NSStackView()
        row.orientation = .horizontal
        row.spacing = 6
        row.alignment = .firstBaseline

        let titleLabel = NSTextField(labelWithString: "\(title):")
        titleLabel.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize, weight: .semibold)
        titleLabel.textColor = NSColor.secondaryLabelColor

        let valueLabel = NSTextField(labelWithString: value)
        valueLabel.font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        valueLabel.lineBreakMode = .byTruncatingMiddle
        valueLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        row.addArrangedSubview(titleLabel)
        row.addArrangedSubview(valueLabel)
        stack.addArrangedSubview(row)
    }
}

#if DEBUG
extension ExecApprovalsPromptPresenter {
    @MainActor
    static func reservePromptForTesting() -> UUID? {
        guard self.activePrompt == nil else { return nil }
        let id = UUID()
        self.activePrompt = (id: id, alert: nil, cancelled: false)
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
