#if os(macOS)
import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Navigation keys the composer intercepts while UI like the slash-command
/// panel is open. The handler returns true when it consumed the key.
enum ChatComposerKeyCommand: Equatable {
    case moveUp
    case moveDown
    case tab
    case escape
    case returnKey
}

struct ChatComposerKeyCommandContext: Equatable {
    let caretOnFirstLine: Bool

    static func resolve(text: String, selectedRange: NSRange) -> Self {
        let utf16Length = (text as NSString).length
        guard selectedRange.location != NSNotFound,
              selectedRange.length == 0,
              selectedRange.location <= utf16Length
        else { return Self(caretOnFirstLine: false) }
        let prefix = (text as NSString).substring(to: selectedRange.location)
        return Self(caretOnFirstLine: !prefix.contains("\n") && !prefix.contains("\r"))
    }
}

enum ChatComposerKeyRouting {
    /// Maps a key event to an interceptable command. Modified keys (except
    /// plain Shift on arrows) stay with the text view so shortcuts keep
    /// working; marked text (IME composition) is never intercepted.
    static func command(
        keyCode: UInt16,
        modifierFlags: NSEvent.ModifierFlags,
        hasMarkedText: Bool) -> ChatComposerKeyCommand?
    {
        guard !hasMarkedText else { return nil }
        let disallowed: NSEvent.ModifierFlags = [.command, .option, .control, .shift]
        guard modifierFlags.isDisjoint(with: disallowed) else { return nil }
        switch keyCode {
        case 126: return .moveUp
        case 125: return .moveDown
        case 48: return .tab
        case 53: return .escape
        case 36: return .returnKey
        default: return nil
        }
    }
}

struct ChatComposerTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var shouldFocus: Bool
    var isEnabled: Bool
    var onSend: () -> Void
    var onPasteImageAttachment: (_ data: Data, _ fileName: String, _ mimeType: String) -> Void
    var onKeyCommand: (
        _ command: ChatComposerKeyCommand,
        _ context: ChatComposerKeyCommandContext) -> Bool = { _, _ in false }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = ChatComposerTextViewFactory.makeConfiguredTextView()
        guard let composerTextView = textView as? ChatComposerNSTextView else {
            preconditionFailure("ChatComposerTextViewFactory must return ChatComposerNSTextView")
        }
        composerTextView.delegate = context.coordinator

        composerTextView.string = self.text
        composerTextView.onSend = { [weak composerTextView] in
            composerTextView?.window?.makeFirstResponder(nil)
            self.onSend()
        }
        composerTextView.onPasteImageAttachment = self.onPasteImageAttachment
        composerTextView.onKeyCommand = self.onKeyCommand

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
        guard let textView = scrollView.documentView as? ChatComposerNSTextView else { return }
        textView.onPasteImageAttachment = self.onPasteImageAttachment
        textView.onKeyCommand = self.onKeyCommand
        textView.isEditable = self.isEnabled
        textView.isSelectable = self.isEnabled

        if self.shouldFocus, self.isEnabled, let window = scrollView.window {
            window.makeFirstResponder(textView)
            self.shouldFocus = false
        } else if !self.isEnabled, scrollView.window?.firstResponder == textView {
            scrollView.window?.makeFirstResponder(nil)
            self.shouldFocus = false
        }

        let isEditing = scrollView.window?.firstResponder == textView

        // While the user is typing, binding updates just echo textDidChange;
        // rewriting the view then would jump the cursor. A binding value the
        // coordinator never reported is programmatic (send-clear, slash
        // completion) and must reach the view even mid-edit.
        let isEcho = context.coordinator.lastReportedText == self.text
        if isEditing, isEcho { return }

        if textView.string != self.text {
            context.coordinator.isProgrammaticUpdate = true
            defer { context.coordinator.isProgrammaticUpdate = false }
            textView.string = self.text
            if isEditing {
                textView.setSelectedRange(NSRange(location: (self.text as NSString).length, length: 0))
            }
        }
        context.coordinator.lastReportedText = self.text
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ChatComposerTextView
        var isProgrammaticUpdate = false
        var lastReportedText: String?

        init(_ parent: ChatComposerTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard !self.isProgrammaticUpdate else { return }
            guard let view = notification.object as? NSTextView else { return }
            guard view.window?.firstResponder === view else { return }
            self.lastReportedText = view.string
            self.parent.text = view.string
        }
    }
}

enum ChatComposerTextViewFactory {
    /// Internal for @testable import coverage of composer text view defaults.
    @MainActor
    static func makeConfiguredTextView() -> NSTextView {
        let textView = ChatComposerNSTextView()
        textView.drawsBackground = false
        textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.font = .systemFont(ofSize: 14, weight: .regular)
        textView.textContainer?.lineBreakMode = .byWordWrapping
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainerInset = NSSize(width: 2, height: 4)
        textView.focusRingType = .none
        textView.allowsUndo = true
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true
        return textView
    }
}

private final class ChatComposerNSTextView: NSTextView {
    var onSend: (() -> Void)?
    var onPasteImageAttachment: ((_ data: Data, _ fileName: String, _ mimeType: String) -> Void)?
    var onKeyCommand: ((_ command: ChatComposerKeyCommand, _ context: ChatComposerKeyCommandContext) -> Bool)?

    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
        var types = super.readablePasteboardTypes
        for type in ChatComposerPasteSupport.readablePasteboardTypes where !types.contains(type) {
            types.append(type)
        }
        return types
    }

    override func keyDown(with event: NSEvent) {
        if let command = ChatComposerKeyRouting.command(
            keyCode: event.keyCode,
            modifierFlags: event.modifierFlags,
            hasMarkedText: hasMarkedText()),
            self.onKeyCommand?(
                command,
                ChatComposerKeyCommandContext.resolve(text: self.string, selectedRange: self.selectedRange())) == true
        {
            return
        }
        let isReturn = event.keyCode == 36
        if isReturn {
            if hasMarkedText() {
                super.keyDown(with: event)
                return
            }
            if event.modifierFlags.contains(.shift) {
                super.insertNewline(nil)
                return
            }
            self.onSend?()
            return
        }
        super.keyDown(with: event)
    }

    override func readSelection(from pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        if !self.handleImagePaste(from: pboard, matching: type) {
            return super.readSelection(from: pboard, type: type)
        }
        return true
    }

    override func paste(_ sender: Any?) {
        if !self.handleImagePaste(from: NSPasteboard.general, matching: nil) {
            super.paste(sender)
        }
    }

    override func pasteAsPlainText(_ sender: Any?) {
        self.paste(sender)
    }

    private func handleImagePaste(
        from pasteboard: NSPasteboard,
        matching preferredType: NSPasteboard.PasteboardType?) -> Bool
    {
        let attachments = ChatComposerPasteSupport.imageAttachments(from: pasteboard, matching: preferredType)
        if !attachments.isEmpty {
            self.deliver(attachments)
            return true
        }

        let fileReferences = ChatComposerPasteSupport.imageFileReferences(from: pasteboard, matching: preferredType)
        if !fileReferences.isEmpty {
            self.loadAndDeliver(fileReferences)
            return true
        }

        return false
    }

    private func deliver(_ attachments: [ChatComposerPasteSupport.ImageAttachment]) {
        for attachment in attachments {
            self.onPasteImageAttachment?(
                attachment.data,
                attachment.fileName,
                attachment.mimeType)
        }
    }

    private func loadAndDeliver(_ fileReferences: [ChatComposerPasteSupport.FileImageReference]) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self, fileReferences] in
            let attachments = ChatComposerPasteSupport.loadImageAttachments(from: fileReferences)
            guard !attachments.isEmpty else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                self.deliver(attachments)
            }
        }
    }
}

enum ChatComposerPasteSupport {
    typealias ImageAttachment = (data: Data, fileName: String, mimeType: String)
    typealias FileImageReference = (url: URL, fileName: String, mimeType: String)

    static var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
        [.fileURL] + preferredImagePasteboardTypes.map(\.type)
    }

    static func imageAttachments(
        from pasteboard: NSPasteboard,
        matching preferredType: NSPasteboard.PasteboardType? = nil) -> [ImageAttachment]
    {
        let dataAttachments = self.imageAttachmentsFromRawData(in: pasteboard, matching: preferredType)
        if !dataAttachments.isEmpty {
            return dataAttachments
        }

        if let preferredType, !self.matchesImageType(preferredType) {
            return []
        }

        guard let images = pasteboard.readObjects(forClasses: [NSImage.self]) as? [NSImage], !images.isEmpty else {
            return []
        }
        return images.enumerated().compactMap { index, image in
            self.imageAttachment(from: image, index: index)
        }
    }

    static func imageFileReferences(
        from pasteboard: NSPasteboard,
        matching preferredType: NSPasteboard.PasteboardType? = nil) -> [FileImageReference]
    {
        guard self.matchesFileURL(preferredType) else { return [] }
        return self.imageFileReferencesFromFileURLs(in: pasteboard)
    }

    static func loadImageAttachments(from fileReferences: [FileImageReference]) -> [ImageAttachment] {
        fileReferences.compactMap { reference in
            guard let data = try? Data(contentsOf: reference.url), !data.isEmpty else {
                return nil
            }
            return (
                data: data,
                fileName: reference.fileName,
                mimeType: reference.mimeType)
        }
    }

    private static func imageFileReferencesFromFileURLs(in pasteboard: NSPasteboard) -> [FileImageReference] {
        guard let urls = pasteboard.readObjects(forClasses: [NSURL.self]) as? [URL], !urls.isEmpty else {
            return []
        }

        return urls.enumerated().compactMap { index, url -> FileImageReference? in
            guard url.isFileURL,
                  let type = UTType(filenameExtension: url.pathExtension),
                  type.conforms(to: .image)
            else {
                return nil
            }

            let mimeType = type.preferredMIMEType ?? "image/\(type.preferredFilenameExtension ?? "png")"
            let fileName = url.lastPathComponent.isEmpty
                ? self.defaultFileName(index: index, ext: type.preferredFilenameExtension ?? "png")
                : url.lastPathComponent
            return (url: url, fileName: fileName, mimeType: mimeType)
        }
    }

    private static func imageAttachmentsFromRawData(
        in pasteboard: NSPasteboard,
        matching preferredType: NSPasteboard.PasteboardType?) -> [ImageAttachment]
    {
        let items = pasteboard.pasteboardItems ?? []
        guard !items.isEmpty else { return [] }

        return items.enumerated().compactMap { index, item in
            self.imageAttachment(from: item, index: index, matching: preferredType)
        }
    }

    private static func imageAttachment(from image: NSImage, index: Int) -> ImageAttachment? {
        guard let tiffData = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData)
        else {
            return nil
        }

        if let pngData = bitmap.representation(using: .png, properties: [:]), !pngData.isEmpty {
            return (
                data: pngData,
                fileName: self.defaultFileName(index: index, ext: "png"),
                mimeType: "image/png")
        }

        guard !tiffData.isEmpty else {
            return nil
        }
        return (
            data: tiffData,
            fileName: self.defaultFileName(index: index, ext: "tiff"),
            mimeType: "image/tiff")
    }

    private static func imageAttachment(
        from item: NSPasteboardItem,
        index: Int,
        matching preferredType: NSPasteboard.PasteboardType?) -> ImageAttachment?
    {
        for type in self.preferredImagePasteboardTypes where self.matches(preferredType, candidate: type.type) {
            guard let data = item.data(forType: type.type), !data.isEmpty else { continue }
            return (
                data: data,
                fileName: self.defaultFileName(index: index, ext: type.fileExtension),
                mimeType: type.mimeType)
        }
        return nil
    }

    private static let preferredImagePasteboardTypes: [
        (type: NSPasteboard.PasteboardType, fileExtension: String, mimeType: String)
    ] = [
        (.png, "png", "image/png"),
        (.tiff, "tiff", "image/tiff"),
        (NSPasteboard.PasteboardType("public.jpeg"), "jpg", "image/jpeg"),
        (NSPasteboard.PasteboardType("com.compuserve.gif"), "gif", "image/gif"),
        (NSPasteboard.PasteboardType("public.heic"), "heic", "image/heic"),
        (NSPasteboard.PasteboardType("public.heif"), "heif", "image/heif"),
    ]

    private static func matches(
        _ preferredType: NSPasteboard.PasteboardType?,
        candidate: NSPasteboard.PasteboardType) -> Bool
    {
        guard let preferredType else { return true }
        return preferredType == candidate
    }

    private static func matchesFileURL(_ preferredType: NSPasteboard.PasteboardType?) -> Bool {
        guard let preferredType else { return true }
        return preferredType == .fileURL
    }

    private static func matchesImageType(_ preferredType: NSPasteboard.PasteboardType) -> Bool {
        self.preferredImagePasteboardTypes.contains { $0.type == preferredType }
    }

    private static func defaultFileName(index: Int, ext: String) -> String {
        "pasted-image-\(index + 1).\(ext)"
    }
}
#endif
