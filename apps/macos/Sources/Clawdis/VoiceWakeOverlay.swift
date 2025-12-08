import AppKit
import QuartzCore
import SwiftUI

/// Lightweight, borderless panel that shows the current voice wake transcript near the menu bar.
@MainActor
final class VoiceWakeOverlayController: ObservableObject {
    static let shared = VoiceWakeOverlayController()

    @Published private(set) var model = Model()

    struct Model {
        var text: String = ""
        var isFinal: Bool = false
        var isVisible: Bool = false
        var forwardEnabled: Bool = false
        var isSending: Bool = false
        var attributed: NSAttributedString = NSAttributedString(string: "")
        var isOverflowing: Bool = false
        var isEditing: Bool = false
    }

    private var window: NSPanel?
    private var hostingView: NSHostingView<VoiceWakeOverlayView>?
    private var autoSendTask: Task<Void, Never>?
    private var forwardConfig: VoiceWakeForwardConfig?

    private let width: CGFloat = 360
    private let padding: CGFloat = 10
    private let buttonWidth: CGFloat = 36
    private let spacing: CGFloat = 8
    private let verticalPadding: CGFloat = 8
    private let maxHeight: CGFloat = 400
    private let minHeight: CGFloat = 48

    func showPartial(transcript: String, attributed: NSAttributedString? = nil) {
        self.autoSendTask?.cancel()
        self.forwardConfig = nil
        self.model.text = transcript
        self.model.isFinal = false
        self.model.forwardEnabled = false
        self.model.isSending = false
        self.model.isEditing = false
        self.model.attributed = attributed ?? self.makeAttributed(from: transcript)
        self.present()
        self.updateWindowFrame(animate: true)
    }

    func presentFinal(
        transcript: String,
        forwardConfig: VoiceWakeForwardConfig,
        delay: TimeInterval,
        sendChime: VoiceWakeChime = .none,
        attributed: NSAttributedString? = nil)
    {
        self.autoSendTask?.cancel()
        self.forwardConfig = forwardConfig
        self.model.text = transcript
        self.model.isFinal = true
        self.model.forwardEnabled = forwardConfig.enabled
        self.model.isSending = false
        self.model.isEditing = false
        self.model.attributed = attributed ?? self.makeAttributed(from: transcript)
        self.present()
        self.scheduleAutoSend(after: delay, sendChime: sendChime)
    }

    func userBeganEditing() {
        self.autoSendTask?.cancel()
        self.model.isSending = false
        self.model.isEditing = true
    }

    func cancelEditingAndDismiss() {
        self.autoSendTask?.cancel()
        self.model.isSending = false
        self.model.isEditing = false
        self.dismiss(reason: .explicit)
    }

    func endEditing() {
        self.model.isEditing = false
    }

    func updateText(_ text: String) {
        self.model.text = text
        self.model.isSending = false
        self.model.attributed = self.makeAttributed(from: text)
        self.updateWindowFrame(animate: true)
    }

    func sendNow(sendChime: VoiceWakeChime = .none) {
        self.autoSendTask?.cancel()
        self.autoSendTask = nil
        if self.model.isSending { return }
        self.model.isEditing = false
        guard let forwardConfig, forwardConfig.enabled else {
            self.dismiss(reason: .explicit)
            return
        }
        let text = self.model.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            self.dismiss(reason: .empty)
            return
        }

        if sendChime != .none {
            VoiceWakeChimePlayer.play(sendChime)
        }

        self.model.isSending = true
        let payload = VoiceWakeForwarder.prefixedTranscript(text)
        Task.detached {
            await VoiceWakeForwarder.forward(transcript: payload, config: forwardConfig)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) {
            self.dismiss(reason: .explicit, outcome: .sent)
        }
    }

    func dismiss(reason: DismissReason = .explicit, outcome: SendOutcome = .empty) {
        self.autoSendTask?.cancel()
        self.model.isSending = false
        self.model.isEditing = false
        guard let window else { return }
        let target = self.dismissTargetFrame(for: window.frame, reason: reason, outcome: outcome)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.18
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            if let target {
                window.animator().setFrame(target, display: true)
            }
            window.animator().alphaValue = 0
        } completionHandler: {
            Task { @MainActor in
                window.orderOut(nil)
                self.model.isVisible = false
            }
        }
    }

    enum DismissReason { case explicit, empty }
    enum SendOutcome { case sent, empty }

    // MARK: - Private

    private func present() {
        self.ensureWindow()
        self.hostingView?.rootView = VoiceWakeOverlayView(controller: self)
        let target = self.targetFrame()

        guard let window else { return }
        if !self.model.isVisible {
            self.model.isVisible = true
            let start = target.offsetBy(dx: 0, dy: -6)
            window.setFrame(start, display: true)
            window.alphaValue = 0
            window.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                window.animator().setFrame(target, display: true)
                window.animator().alphaValue = 1
            }
        } else {
            self.updateWindowFrame(animate: true)
            window.orderFrontRegardless()
        }
    }

    private func ensureWindow() {
        if self.window != nil { return }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: self.width, height: 60),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true

        let host = NSHostingView(rootView: VoiceWakeOverlayView(controller: self))
        host.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = host
        self.hostingView = host
        self.window = panel
    }

    private func targetFrame() -> NSRect {
        guard let screen = NSScreen.main else { return .zero }
        let height = self.measuredHeight()
        let size = NSSize(width: self.width, height: height)
        let visible = screen.visibleFrame
        let origin = CGPoint(
            x: visible.maxX - size.width - self.padding,
            y: visible.maxY - size.height - self.padding)
        return NSRect(origin: origin, size: size)
    }

    func updateWindowFrame(animate: Bool = false) {
        guard let window else { return }
        let frame = self.targetFrame()
        if animate {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.12
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                window.animator().setFrame(frame, display: true)
            }
        } else {
            window.setFrame(frame, display: true)
        }
    }

    private func measuredHeight() -> CGFloat {
        let attributed = self.model.attributed.length > 0 ? self.model.attributed : self.makeAttributed(from: self.model.text)
        let maxWidth = self.width - (self.padding * 2) - self.spacing - self.buttonWidth

        let textInset = NSSize(width: 2, height: 6)
        let lineFragmentPadding: CGFloat = 0
        let containerWidth = max(1, maxWidth - (textInset.width * 2) - (lineFragmentPadding * 2))

        let storage = NSTextStorage(attributedString: attributed)
        let container = NSTextContainer(containerSize: CGSize(width: containerWidth, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = lineFragmentPadding
        container.lineBreakMode = .byWordWrapping

        let layout = NSLayoutManager()
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)

        _ = layout.glyphRange(for: container)
        let used = layout.usedRect(for: container)

        let contentHeight = ceil(used.height + (textInset.height * 2))
        let total = contentHeight + self.verticalPadding * 2
        self.model.isOverflowing = total > self.maxHeight
        return max(self.minHeight, min(total, self.maxHeight))
    }

    private func dismissTargetFrame(for frame: NSRect, reason: DismissReason, outcome: SendOutcome) -> NSRect? {
        switch (reason, outcome) {
        case (.empty, _):
            let scale: CGFloat = 0.95
            let newSize = NSSize(width: frame.size.width * scale, height: frame.size.height * scale)
            let dx = (frame.size.width - newSize.width) / 2
            let dy = (frame.size.height - newSize.height) / 2
            return NSRect(x: frame.origin.x + dx, y: frame.origin.y + dy, width: newSize.width, height: newSize.height)
        case (.explicit, .sent):
            return frame.offsetBy(dx: 8, dy: 6)
        default:
            return frame
        }
    }

    private func scheduleAutoSend(after delay: TimeInterval, sendChime: VoiceWakeChime) {
        guard let forwardConfig, forwardConfig.enabled else { return }
        self.autoSendTask?.cancel()
        self.autoSendTask = Task<Void, Never> { [weak self, sendChime] in
            let nanos = UInt64(max(0, delay) * 1_000_000_000)
            try? await Task.sleep(nanoseconds: nanos)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self else { return }
                self.sendNow(sendChime: sendChime)
                self.autoSendTask = nil
            }
        }
    }

    private func makeAttributed(from text: String) -> NSAttributedString {
        NSAttributedString(
            string: text,
            attributes: [
                .foregroundColor: NSColor.labelColor,
                .font: NSFont.systemFont(ofSize: 13, weight: .regular),
            ])
    }
}
private struct VoiceWakeOverlayView: View {
    @ObservedObject var controller: VoiceWakeOverlayController
    @FocusState private var textFocused: Bool
    @State private var isHovering: Bool = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            HStack(alignment: .top, spacing: 8) {
                if self.controller.model.isEditing {
                    TranscriptTextView(
                        text: Binding(
                            get: { self.controller.model.text },
                            set: { self.controller.updateText($0) }),
                        attributed: self.controller.model.attributed,
                        isFinal: self.controller.model.isFinal,
                        isOverflowing: self.controller.model.isOverflowing,
                        onBeginEditing: {
                            self.controller.userBeganEditing()
                        },
                        onEscape: {
                            self.controller.cancelEditingAndDismiss()
                        },
                        onEndEditing: {
                            self.controller.endEditing()
                        },
                        onSend: {
                            self.controller.sendNow()
                        })
                        .focused(self.$textFocused)
                        .frame(maxWidth: .infinity, minHeight: 32, maxHeight: .infinity, alignment: .topLeading)
                        .id("editing")
                } else {
                    VibrantLabelView(
                        attributed: self.controller.model.attributed,
                        onTap: {
                            self.controller.userBeganEditing()
                            self.textFocused = true
                        })
                        .frame(maxWidth: .infinity, minHeight: 32, maxHeight: .infinity, alignment: .topLeading)
                        .id("display")
                }

                Button {
                    self.controller.sendNow()
                } label: {
                    let sending = self.controller.model.isSending
                    ZStack {
                        Image(systemName: "paperplane.fill")
                            .opacity(sending ? 0 : 1)
                            .scaleEffect(sending ? 0.5 : 1)
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .opacity(sending ? 1 : 0)
                            .scaleEffect(sending ? 1.05 : 0.8)
                    }
                    .imageScale(.small)
                    .padding(.vertical, 6)
                    .padding(.horizontal, 10)
                    .background(Color.accentColor.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .animation(.spring(response: 0.35, dampingFraction: 0.78), value: sending)
                }
                .buttonStyle(.plain)
                .disabled(!self.controller.model.forwardEnabled || self.controller.model.isSending)
                .keyboardShortcut(.return, modifiers: [.command])
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(
                .regularMaterial,
                in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .onHover { self.isHovering = $0 }

            // Close button rendered above and outside the clipped bubble
            CloseButtonOverlay(isVisible: self.controller.model.isEditing || self.isHovering) {
                self.controller.cancelEditingAndDismiss()
            }
        }
        .onAppear { self.textFocused = false }
        .onChange(of: self.controller.model.text) { _, _ in
            self.textFocused = self.controller.model.isEditing
        }
        .onChange(of: self.controller.model.isVisible) { _, visible in
            if visible { self.textFocused = self.controller.model.isEditing }
        }
        .onChange(of: self.controller.model.isEditing) { _, editing in
            self.textFocused = editing
        }
        .onChange(of: self.controller.model.attributed) { _, _ in
            self.controller.updateWindowFrame(animate: true)
        }
    }
}

private struct TranscriptTextView: NSViewRepresentable {
    @Binding var text: String
    var attributed: NSAttributedString
    var isFinal: Bool
    var isOverflowing: Bool
    var onBeginEditing: () -> Void
    var onEscape: () -> Void
    var onEndEditing: () -> Void
    var onSend: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = TranscriptNSTextView()
        textView.delegate = context.coordinator
        textView.drawsBackground = false
        textView.isRichText = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.font = .systemFont(ofSize: 13, weight: .regular)
        textView.textContainer?.lineBreakMode = .byWordWrapping
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainerInset = NSSize(width: 2, height: 6)

        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]

        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true

        textView.textStorage?.setAttributedString(self.attributed)
        textView.typingAttributes = [
            .foregroundColor: NSColor.labelColor,
            .font: NSFont.systemFont(ofSize: 13, weight: .regular),
        ]
        textView.focusRingType = .none
        textView.onSend = { [weak textView] in
            textView?.window?.makeFirstResponder(nil)
            self.onSend()
        }
        textView.onBeginEditing = self.onBeginEditing
        textView.onEscape = self.onEscape
        textView.onEndEditing = self.onEndEditing

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.hasHorizontalScroller = false
        scroll.documentView = textView
        return scroll
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? TranscriptNSTextView else { return }
        let isEditing = scrollView.window?.firstResponder == textView
        if isEditing {
            return
        }

        if !textView.attributedString().isEqual(to: self.attributed) {
            context.coordinator.isProgrammaticUpdate = true
            defer { context.coordinator.isProgrammaticUpdate = false }
            textView.textStorage?.setAttributedString(self.attributed)
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: TranscriptTextView
        var isProgrammaticUpdate = false

        init(_ parent: TranscriptTextView) { self.parent = parent }

        func textDidBeginEditing(_ notification: Notification) {
            self.parent.onBeginEditing()
        }

        func textDidEndEditing(_ notification: Notification) {
            self.parent.onEndEditing()
        }

        func textDidChange(_ notification: Notification) {
            guard !self.isProgrammaticUpdate else { return }
            guard let view = notification.object as? NSTextView else { return }
            guard view.window?.firstResponder === view else { return }
            self.parent.text = view.string
        }
    }
}

// MARK: - Vibrant display label

private struct VibrantLabelView: NSViewRepresentable {
    var attributed: NSAttributedString
    var onTap: () -> Void

    func makeNSView(context: Context) -> NSView {
        let label = NSTextField(labelWithAttributedString: self.attributed)
        label.isEditable = false
        label.isBordered = false
        label.drawsBackground = false
        label.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = 0
        label.usesSingleLineMode = false
        label.cell?.wraps = true
        label.cell?.isScrollable = false
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        label.setContentHuggingPriority(.required, for: .vertical)
        label.setContentCompressionResistancePriority(.required, for: .vertical)
        label.textColor = .labelColor

        let container = ClickCatcher(onTap: onTap)
        container.addSubview(label)

        label.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            label.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            label.topAnchor.constraint(equalTo: container.topAnchor),
            label.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        return container
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        guard let container = nsView as? ClickCatcher,
              let label = container.subviews.first as? NSTextField else { return }
        label.attributedStringValue = self.attributed
    }

}

private final class ClickCatcher: NSView {
    let onTap: () -> Void
    init(onTap: @escaping () -> Void) {
        self.onTap = onTap
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func mouseDown(with event: NSEvent) {
        super.mouseDown(with: event)
        self.onTap()
    }
}

private struct CloseHoverButton: View {
    var onClose: () -> Void

    var body: some View {
        Button(action: self.onClose) {
            Image(systemName: "xmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(Color.white.opacity(0.85))
                .frame(width: 22, height: 22)
                .background(Color.black.opacity(0.35))
                .clipShape(Circle())
                .shadow(color: Color.black.opacity(0.35), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .focusable(false)
        .contentShape(Circle())
        .padding(6)
    }
}

private struct CloseButtonOverlay: View {
    var isVisible: Bool
    var onClose: () -> Void

    var body: some View {
        Group {
            if isVisible {
                CloseHoverButton(onClose: onClose)
                    .offset(x: -12, y: -12)
                    .transition(.opacity)
            }
        }
        .allowsHitTesting(isVisible)
    }
}

private final class TranscriptNSTextView: NSTextView {
    var onSend: (() -> Void)?
    var onBeginEditing: (() -> Void)?
    var onEndEditing: (() -> Void)?
    var onEscape: (() -> Void)?

    override func becomeFirstResponder() -> Bool {
        self.onBeginEditing?()
        return super.becomeFirstResponder()
    }

    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        self.onEndEditing?()
        return result
    }

    override func keyDown(with event: NSEvent) {
        let isReturn = event.keyCode == 36
        let isEscape = event.keyCode == 53
        if isEscape {
            self.onEscape?()
            return
        }
        if isReturn && event.modifierFlags.contains(.command) {
            self.onSend?()
            return
        }
        if isReturn {
            if event.modifierFlags.contains(.shift) {
                super.insertNewline(nil)
                return
            }
            self.onSend?()
            return
        }
        super.keyDown(with: event)
    }
}
