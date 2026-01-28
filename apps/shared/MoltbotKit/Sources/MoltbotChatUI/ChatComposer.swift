import Foundation
import Observation
import SwiftUI

#if !os(macOS)
import PhotosUI
import UniformTypeIdentifiers
#endif

@MainActor
struct MoltbotChatComposer: View {
    @Bindable var viewModel: MoltbotChatViewModel
    let style: MoltbotChatView.Style
    let showsSessionSwitcher: Bool

    #if !os(macOS)
    @State private var pickerItems: [PhotosPickerItem] = []
    @FocusState private var isFocused: Bool
    #else
    @State private var shouldFocusTextView = false
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if self.showsToolbar {
                HStack(spacing: 6) {
                    if self.showsSessionSwitcher {
                        self.sessionPicker
                    }
                    self.thinkingPicker
                    Spacer()
                    self.refreshButton
                    self.attachmentPicker
                }
            }

            if self.showsAttachments, !self.viewModel.attachments.isEmpty {
                self.attachmentsStrip
            }

            self.editor
        }
        .padding(self.composerPadding)
        .background {
            let cornerRadius: CGFloat = 18

            #if os(macOS)
            if self.style == .standard {
                let shape = UnevenRoundedRectangle(
                    cornerRadii: RectangleCornerRadii(
                        topLeading: 0,
                        bottomLeading: cornerRadius,
                        bottomTrailing: cornerRadius,
                        topTrailing: 0),
                    style: .continuous)
                shape
                    .fill(MoltbotChatTheme.composerBackground)
                    .overlay(shape.strokeBorder(MoltbotChatTheme.composerBorder, lineWidth: 1))
                    .shadow(color: .black.opacity(0.12), radius: 12, y: 6)
            } else {
                let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                shape
                    .fill(MoltbotChatTheme.composerBackground)
                    .overlay(shape.strokeBorder(MoltbotChatTheme.composerBorder, lineWidth: 1))
                    .shadow(color: .black.opacity(0.12), radius: 12, y: 6)
            }
            #else
            let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            shape
                .fill(MoltbotChatTheme.composerBackground)
                .overlay(shape.strokeBorder(MoltbotChatTheme.composerBorder, lineWidth: 1))
                .shadow(color: .black.opacity(0.12), radius: 12, y: 6)
            #endif
        }
        #if os(macOS)
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            self.handleDrop(providers)
        }
        .onAppear {
            self.shouldFocusTextView = true
        }
        #endif
    }

    private var thinkingPicker: some View {
        Picker("Thinking", selection: self.$viewModel.thinkingLevel) {
            Text("Off").tag("off")
            Text("Low").tag("low")
            Text("Medium").tag("medium")
            Text("High").tag("high")
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .controlSize(.small)
        .frame(maxWidth: 140, alignment: .leading)
    }

    private var sessionPicker: some View {
        Picker(
            "Session",
            selection: Binding(
                get: { self.viewModel.sessionKey },
                set: { next in self.viewModel.switchSession(to: next) }))
        {
            ForEach(self.viewModel.sessionChoices, id: \.key) { session in
                Text(session.displayName ?? session.key)
                    .font(.system(.caption, design: .monospaced))
                    .tag(session.key)
            }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .controlSize(.small)
        .frame(maxWidth: 160, alignment: .leading)
        .help("Session")
    }

    @ViewBuilder
    private var attachmentPicker: some View {
        #if os(macOS)
        Button {
            self.pickFilesMac()
        } label: {
            Image(systemName: "paperclip")
        }
        .help("Add Image")
        .buttonStyle(.bordered)
        .controlSize(.small)
        #else
        PhotosPicker(selection: self.$pickerItems, maxSelectionCount: 8, matching: .images) {
            Image(systemName: "paperclip")
        }
        .help("Add Image")
        .buttonStyle(.bordered)
        .controlSize(.small)
        .onChange(of: self.pickerItems) { _, newItems in
            Task { await self.loadPhotosPickerItems(newItems) }
        }
        #endif
    }

    private var attachmentsStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(
                    self.viewModel.attachments,
                    id: \MoltbotPendingAttachment.id)
                { (att: MoltbotPendingAttachment) in
                    HStack(spacing: 6) {
                        if let img = att.preview {
                            MoltbotPlatformImageFactory.image(img)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 22, height: 22)
                                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        } else {
                            Image(systemName: "photo")
                        }

                        Text(att.fileName)
                            .lineLimit(1)

                        Button {
                            self.viewModel.removeAttachment(att.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(Color.accentColor.opacity(0.08))
                    .clipShape(Capsule())
                }
            }
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 8) {
            self.editorOverlay

            Rectangle()
                .fill(MoltbotChatTheme.divider)
                .frame(height: 1)
                .padding(.horizontal, 2)

            HStack(alignment: .center, spacing: 8) {
                if self.showsConnectionPill {
                    self.connectionPill
                }
                Spacer(minLength: 0)
                self.sendButton
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(MoltbotChatTheme.composerField)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(MoltbotChatTheme.composerBorder)))
        .padding(self.editorPadding)
    }

    private var connectionPill: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(self.viewModel.healthOK ? .green : .orange)
                .frame(width: 7, height: 7)
            Text(self.activeSessionLabel)
                .font(.caption2.weight(.semibold))
            Text(self.viewModel.healthOK ? "Connected" : "Connecting…")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(MoltbotChatTheme.subtleCard)
        .clipShape(Capsule())
    }

    private var activeSessionLabel: String {
        let match = self.viewModel.sessions.first { $0.key == self.viewModel.sessionKey }
        let trimmed = match?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? self.viewModel.sessionKey : trimmed
    }

    private var editorOverlay: some View {
        ZStack(alignment: .topLeading) {
            if self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text("Message Clawd…")
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 4)
            }

            #if os(macOS)
            ChatComposerTextView(text: self.$viewModel.input, shouldFocus: self.$shouldFocusTextView) {
                self.viewModel.send()
            }
            .frame(minHeight: self.textMinHeight, idealHeight: self.textMinHeight, maxHeight: self.textMaxHeight)
            .padding(.horizontal, 4)
            .padding(.vertical, 3)
            #else
            TextEditor(text: self.$viewModel.input)
                .font(.system(size: 15))
                .scrollContentBackground(.hidden)
                .frame(
                    minHeight: self.textMinHeight,
                    idealHeight: self.textMinHeight,
                    maxHeight: self.textMaxHeight)
                .padding(.horizontal, 4)
                .padding(.vertical, 4)
                .focused(self.$isFocused)
            #endif
        }
    }

    private var sendButton: some View {
        Group {
            if self.viewModel.pendingRunCount > 0 {
                Button {
                    self.viewModel.abort()
                } label: {
                    if self.viewModel.isAborting {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 13, weight: .semibold))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)
                .padding(6)
                .background(Circle().fill(Color.red))
                .disabled(self.viewModel.isAborting)
            } else {
                Button {
                    self.viewModel.send()
                } label: {
                    if self.viewModel.isSending {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 13, weight: .semibold))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)
                .padding(6)
                .background(Circle().fill(Color.accentColor))
                .disabled(!self.viewModel.canSend)
            }
        }
    }

    private var refreshButton: some View {
        Button {
            self.viewModel.refresh()
        } label: {
            Image(systemName: "arrow.clockwise")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .help("Refresh")
    }

    private var showsToolbar: Bool {
        self.style == .standard
    }

    private var showsAttachments: Bool {
        self.style == .standard
    }

    private var showsConnectionPill: Bool {
        self.style == .standard
    }

    private var composerPadding: CGFloat {
        self.style == .onboarding ? 5 : 6
    }

    private var editorPadding: CGFloat {
        self.style == .onboarding ? 5 : 6
    }

    private var textMinHeight: CGFloat {
        self.style == .onboarding ? 24 : 28
    }

    private var textMaxHeight: CGFloat {
        self.style == .onboarding ? 52 : 64
    }

    #if os(macOS)
    private func pickFilesMac() {
        let panel = NSOpenPanel()
        panel.title = "Select image attachments"
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image]
        panel.begin { resp in
            guard resp == .OK else { return }
            self.viewModel.addAttachments(urls: panel.urls)
        }
    }

    private func handleDrop(_ providers: [NSItemProvider]) -> Bool {
        let fileProviders = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        guard !fileProviders.isEmpty else { return false }
        for item in fileProviders {
            item.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                guard let data = item as? Data,
                      let url = URL(dataRepresentation: data, relativeTo: nil)
                else { return }
                Task { @MainActor in
                    self.viewModel.addAttachments(urls: [url])
                }
            }
        }
        return true
    }
    #else
    private func loadPhotosPickerItems(_ items: [PhotosPickerItem]) async {
        for item in items {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else { continue }
                let type = item.supportedContentTypes.first ?? .image
                let ext = type.preferredFilenameExtension ?? "jpg"
                let mime = type.preferredMIMEType ?? "image/jpeg"
                let name = "photo-\(UUID().uuidString.prefix(8)).\(ext)"
                self.viewModel.addImageAttachment(data: data, fileName: name, mimeType: mime)
            } catch {
                self.viewModel.errorText = error.localizedDescription
            }
        }
        self.pickerItems = []
    }
    #endif
}

#if os(macOS)
import AppKit
import UniformTypeIdentifiers

private struct ChatComposerTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var shouldFocus: Bool
    var onSend: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = ChatComposerNSTextView()
        textView.delegate = context.coordinator
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

        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true

        textView.string = self.text
        textView.onSend = { [weak textView] in
            textView?.window?.makeFirstResponder(nil)
            self.onSend()
        }

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

        if self.shouldFocus, let window = scrollView.window {
            window.makeFirstResponder(textView)
            self.shouldFocus = false
        }

        let isEditing = scrollView.window?.firstResponder == textView

        // Always allow clearing the text (e.g. after send), even while editing.
        // Only skip other updates while editing to avoid cursor jumps.
        let shouldClear = self.text.isEmpty && !textView.string.isEmpty
        if isEditing, !shouldClear { return }

        if textView.string != self.text {
            context.coordinator.isProgrammaticUpdate = true
            defer { context.coordinator.isProgrammaticUpdate = false }
            textView.string = self.text
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ChatComposerTextView
        var isProgrammaticUpdate = false

        init(_ parent: ChatComposerTextView) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard !self.isProgrammaticUpdate else { return }
            guard let view = notification.object as? NSTextView else { return }
            guard view.window?.firstResponder === view else { return }
            self.parent.text = view.string
        }
    }
}

private final class ChatComposerNSTextView: NSTextView {
    var onSend: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        let isReturn = event.keyCode == 36
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
#endif
