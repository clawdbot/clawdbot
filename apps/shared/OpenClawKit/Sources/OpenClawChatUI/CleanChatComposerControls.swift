import SwiftUI

#if !os(macOS)
import PhotosUI
#if canImport(UIKit)
import UIKit
#endif
#endif

struct CleanChatComposerSurface: ViewModifier {
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        #if os(macOS)
        content
            .background(
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .fill(OpenClawChatTheme.composerField))
            .overlay(
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
        #else
        if #available(iOS 26.0, *) {
            content
                .glassEffect(.regular, in: .rect(cornerRadius: self.cornerRadius))
        } else {
            content
                .background(
                    .regularMaterial,
                    in: RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                        .strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
        }
        #endif
    }
}

enum CleanChatComposerMetrics {
    static let controlHeight: CGFloat = 44
}

struct CompactChatAttachmentLabel: View {
    var body: some View {
        Image(systemName: "plus")
            .font(OpenClawChatTypography.display(size: 15, weight: .semibold, relativeTo: .subheadline))
            .foregroundStyle(.secondary)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }
}

struct OpenClawChatAttachmentsStrip: View {
    let attachments: [OpenClawPendingAttachment]
    let onRemove: @MainActor (OpenClawPendingAttachment.ID) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(self.attachments, id: \OpenClawPendingAttachment.id) { attachment in
                    HStack(spacing: 6) {
                        if let image = attachment.preview {
                            OpenClawPlatformImageFactory.image(image)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 22, height: 22)
                                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        } else if attachment.mimeType.hasPrefix("audio/") {
                            Image(systemName: "waveform")
                            Text("Voice note")
                                .font(OpenClawChatTypography.caption)
                            if let duration = attachment.durationSeconds {
                                Text(openClawVoiceNoteDurationLabel(duration))
                                    .font(OpenClawChatTypography.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            Image(systemName: "photo")
                            Text(attachment.fileName)
                                .font(OpenClawChatTypography.caption)
                                .lineLimit(1)
                        }

                        if attachment.preview != nil {
                            Text(attachment.fileName)
                                .font(OpenClawChatTypography.caption)
                                .lineLimit(1)
                        }

                        Button {
                            self.onRemove(attachment.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(OpenClawChatTheme.accent.opacity(0.08))
                    .clipShape(Capsule())
                }
            }
        }
    }
}

#if !os(macOS)
struct OpenClawChatAttachmentMenu: View {
    @Binding var showsPhotoPicker: Bool
    @Binding var showsFileImporter: Bool
    @Binding var showsCameraPicker: Bool
    let isAttachmentInputEnabled: Bool

    var body: some View {
        Menu {
            Button {
                self.showsPhotoPicker = true
            } label: {
                Label {
                    Text("Photo Library")
                        .font(OpenClawChatTypography.body)
                } icon: {
                    Image(systemName: "photo.on.rectangle")
                }
            }

            #if canImport(UIKit)
            Button {
                self.showsCameraPicker = true
            } label: {
                Label {
                    Text("Camera")
                        .font(OpenClawChatTypography.body)
                } icon: {
                    Image(systemName: "camera")
                }
            }
            .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
            #endif

            Button {
                self.showsFileImporter = true
            } label: {
                Label {
                    Text("Choose Image File")
                        .font(OpenClawChatTypography.body)
                } icon: {
                    Image(systemName: "folder")
                }
            }

        } label: {
            CompactChatAttachmentLabel()
        }
        .help("Add attachment")
        .accessibilityLabel("Add attachment")
        .accessibilityIdentifier("chat-attachment-picker")
        .buttonStyle(.plain)
        .disabled(!self.isAttachmentInputEnabled)
    }
}

#if canImport(UIKit)
struct OpenClawChatCameraPicker: UIViewControllerRepresentable {
    let onImage: @MainActor (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_: UIImagePickerController, context _: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let parent: OpenClawChatCameraPicker

        init(parent: OpenClawChatCameraPicker) {
            self.parent = parent
        }

        func imagePickerController(
            _: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any])
        {
            if let image = info[.originalImage] as? UIImage {
                self.parent.onImage(image)
            }
            self.parent.dismiss()
        }

        func imagePickerControllerDidCancel(_: UIImagePickerController) {
            self.parent.dismiss()
        }
    }
}
#endif
#endif

struct OpenClawChatMicButton: View {
    enum DictationPrimaryAction: Equatable {
        case start
        case finish
        case cancel
    }

    let dictationControl: OpenClawChatDictationControl?
    let voiceNoteControl: OpenClawChatVoiceNoteControl?
    let isDictationPending: Bool
    let isRealtimeTalkActive: Bool
    let isComposerEnabled: Bool
    let isAttachmentInputEnabled: Bool
    let onCancelDictation: @MainActor () -> Void
    let onStartDictation: @MainActor () -> Void

    var body: some View {
        if let voiceNoteControl {
            if self.isDictationActionEnabled, let dictationControl {
                Menu {
                    self.voiceNoteAction(voiceNoteControl)
                } label: {
                    self.label
                } primaryAction: {
                    self.performDictationAction()
                }
                .menuIndicator(.hidden)
                .buttonStyle(.plain)
                .modifier(UnifiedChatMicMetadata(
                    control: dictationControl,
                    isPending: self.isDictationPending))
            } else {
                Menu {
                    self.voiceNoteAction(voiceNoteControl)
                } label: {
                    self.label
                }
                .menuIndicator(.hidden)
                .buttonStyle(.plain)
                .disabled(!self.isVoiceNoteRecordingEnabled(voiceNoteControl))
                .accessibilityLabel("Record Voice Note")
                .accessibilityIdentifier("chat-dictation-control")
                .help("Record Voice Note")
            }
        } else if let dictationControl {
            Button(action: self.performDictationAction) {
                self.label
            }
            .buttonStyle(.plain)
            .disabled(!self.isDictationActionEnabled)
            .modifier(UnifiedChatMicMetadata(
                control: dictationControl,
                isPending: self.isDictationPending))
        }
    }

    private var label: some View {
        let showsStop = self.isDictationPending || self.dictationControl?.isActive == true
        return Image(systemName: showsStop ? "stop.fill" : "mic")
            .font(OpenClawChatTypography.display(size: 17, weight: .medium, relativeTo: .body))
            .foregroundStyle(showsStop ? OpenClawChatTheme.accent : .secondary)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }

    private func performDictationAction() {
        guard let dictationControl else { return }
        switch Self.dictationPrimaryAction(
            isPending: self.isDictationPending,
            isActive: dictationControl.isActive)
        {
        case .finish:
            dictationControl.finish()
        case .cancel:
            self.onCancelDictation()
        case .start:
            self.onStartDictation()
        }
    }

    private var isDictationActionEnabled: Bool {
        Self.dictationActionEnabled(
            isComposerEnabled: self.isComposerEnabled,
            isAvailable: self.dictationControl?.isAvailable == true,
            isPending: self.isDictationPending,
            isActive: self.dictationControl?.isActive == true,
            isTalkActive: self.isRealtimeTalkActive || self.voiceNoteControl?.isTalkActive == true,
            isVoiceNoteCaptureActive: self.voiceNoteControl?.recorder.isRecording == true ||
                self.voiceNoteControl?.recorder.isRequestingPermission == true)
    }

    private func voiceNoteAction(_ voiceNoteControl: OpenClawChatVoiceNoteControl) -> some View {
        Button {
            Task { await voiceNoteControl.recorder.start() }
        } label: {
            Label("Record Voice Note", systemImage: "waveform")
        }
        .disabled(!self.isVoiceNoteRecordingEnabled(voiceNoteControl))
    }

    private func isVoiceNoteRecordingEnabled(_ voiceNoteControl: OpenClawChatVoiceNoteControl) -> Bool {
        Self.voiceNoteRecordingEnabled(
            isComposerEnabled: self.isComposerEnabled,
            isAttachmentInputEnabled: self.isAttachmentInputEnabled,
            isDictationActive: self.dictationControl?.isActive == true,
            isDictationPending: self.isDictationPending,
            isTalkActive: self.isRealtimeTalkActive || voiceNoteControl.isTalkActive,
            isRecording: voiceNoteControl.recorder.isRecording,
            isRequestingPermission: voiceNoteControl.recorder.isRequestingPermission)
    }

    nonisolated static func dictationActionEnabled(
        isComposerEnabled: Bool,
        isAvailable: Bool,
        isPending: Bool,
        isActive: Bool,
        isTalkActive: Bool,
        isVoiceNoteCaptureActive: Bool) -> Bool
    {
        isPending || isActive || (isComposerEnabled && isAvailable && !isTalkActive && !isVoiceNoteCaptureActive)
    }

    nonisolated static func dictationPrimaryAction(
        isPending: Bool,
        isActive: Bool) -> DictationPrimaryAction
    {
        if isActive { return .finish }
        if isPending { return .cancel }
        return .start
    }

    nonisolated static func voiceNoteRecordingEnabled(
        isComposerEnabled: Bool,
        isAttachmentInputEnabled: Bool,
        isDictationActive: Bool,
        isDictationPending: Bool,
        isTalkActive: Bool,
        isRecording: Bool,
        isRequestingPermission: Bool) -> Bool
    {
        isComposerEnabled
            && isAttachmentInputEnabled
            && !isDictationActive
            && !isDictationPending
            && !isTalkActive
            && !isRecording
            && !isRequestingPermission
    }
}

private struct UnifiedChatMicMetadata: ViewModifier {
    let control: OpenClawChatDictationControl
    let isPending: Bool

    func body(content: Content) -> some View {
        content
            .accessibilityLabel(self.accessibilityLabel)
            .accessibilityValue(self.accessibilityValue)
            .accessibilityIdentifier("chat-dictation-control")
            .help(self.helpText)
    }

    private var accessibilityLabel: Text {
        if self.control.isActive { return Text("Finish dictation") }
        if self.isPending { return Text("Cancel") }
        return Text("Dictate message")
    }

    private var accessibilityValue: Text {
        if self.control.isActive { return Text("Listening") }
        return Text("Not listening")
    }

    private var helpText: Text {
        if self.control.isActive { return Text("Finish dictation") }
        if self.isPending { return Text("Cancel") }
        return Text("Transcribe speech into the message")
    }
}
