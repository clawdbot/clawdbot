import AppKit
import SwiftUI

struct QuickChatTextView: NSViewRepresentable {
    @Binding var text: String
    let onSubmit: (Bool) -> Void
    let onEscape: () -> Void
    let onHeightChange: (CGFloat) -> Void
    let onTextViewReady: (NSTextView) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = QuickChatNSTextView()
        textView.delegate = context.coordinator
        textView.drawsBackground = false
        textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.font = .systemFont(ofSize: 13.5)
        textView.textColor = .labelColor
        textView.insertionPointColor = .controlAccentColor
        textView.textContainer?.lineBreakMode = .byWordWrapping
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainerInset = NSSize(width: 2, height: 6)
        textView.minSize = .zero
        textView.maxSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude)
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true
        textView.focusRingType = .none
        textView.string = self.text
        textView.onSubmit = self.onSubmit
        textView.onEscape = self.onEscape

        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.hasHorizontalScroller = false
        scrollView.documentView = textView
        context.coordinator.scrollView = scrollView

        DispatchQueue.main.async {
            self.onTextViewReady(textView)
            context.coordinator.updateHeight(for: textView)
        }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scrollView.documentView as? QuickChatNSTextView else { return }
        textView.onSubmit = self.onSubmit
        textView.onEscape = self.onEscape
        if textView.string != self.text, !textView.hasMarkedText() {
            context.coordinator.isProgrammaticUpdate = true
            textView.string = self.text
            textView.setSelectedRange(NSRange(location: textView.string.utf16.count, length: 0))
            context.coordinator.isProgrammaticUpdate = false
        }
        DispatchQueue.main.async {
            context.coordinator.updateHeight(for: textView)
        }
    }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: QuickChatTextView
        weak var scrollView: NSScrollView?
        var isProgrammaticUpdate = false
        private var lastHeight: CGFloat = 0

        init(_ parent: QuickChatTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? QuickChatNSTextView else { return }
            if !self.isProgrammaticUpdate {
                self.parent.text = textView.string
            }
            self.updateHeight(for: textView)
        }

        func updateHeight(for textView: NSTextView) {
            guard let layoutManager = textView.layoutManager,
                  let textContainer = textView.textContainer else { return }
            layoutManager.ensureLayout(for: textContainer)
            let font = textView.font ?? .systemFont(ofSize: 13.5)
            let lineHeight = ceil(layoutManager.defaultLineHeight(for: font))
            let naturalHeight = ceil(layoutManager.usedRect(for: textContainer).height + 12)
            let minHeight = lineHeight + 12
            let maxHeight = (lineHeight * 5) + 12
            let height = min(max(naturalHeight, minHeight), maxHeight)
            self.scrollView?.hasVerticalScroller = naturalHeight > maxHeight
            guard abs(height - self.lastHeight) > 0.5 else { return }
            self.lastHeight = height
            self.parent.onHeightChange(height)
        }
    }
}

private final class QuickChatNSTextView: NSTextView {
    var onSubmit: ((Bool) -> Void)?
    var onEscape: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 {
            guard !self.hasMarkedText() else {
                super.keyDown(with: event)
                return
            }
            self.onEscape?()
            return
        }

        guard event.keyCode == 36 || event.keyCode == 76 else {
            super.keyDown(with: event)
            return
        }
        guard !self.hasMarkedText() else {
            super.keyDown(with: event)
            return
        }

        let modifiers = event.modifierFlags.intersection([.command, .shift])
        if modifiers.contains(.shift), !modifiers.contains(.command) {
            self.insertNewline(nil)
        } else {
            self.onSubmit?(modifiers.contains(.command))
        }
    }
}
