import Foundation
import OpenClawKit
import UniformTypeIdentifiers

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

extension OpenClawChatViewModel {
    public func addAttachments(urls: [URL]) {
        self.beginAttachmentStaging()
        Task {
            defer { self.endAttachmentStaging() }
            await self.loadAttachments(urls: urls)
        }
    }

    func addAttachments(urls: [URL], for session: SessionSnapshot) {
        guard self.isCurrentSession(session) else { return }
        self.beginAttachmentStaging()
        Task {
            defer { self.endAttachmentStaging() }
            await self.loadAttachments(urls: urls, expectedSession: session)
        }
    }

    public func addImageAttachment(data: Data, fileName: String, mimeType: String) {
        self.beginAttachmentStaging()
        Task {
            defer { self.endAttachmentStaging() }
            await self.addImageAttachment(url: nil, data: data, fileName: fileName, mimeType: mimeType)
        }
    }

    func addImageAttachment(
        data: Data,
        fileName: String,
        mimeType: String,
        for session: SessionSnapshot) async
    {
        guard self.isCurrentSession(session) else { return }
        self.beginAttachmentStaging()
        defer { self.endAttachmentStaging() }
        await self.addImageAttachment(
            url: nil,
            data: data,
            fileName: fileName,
            mimeType: mimeType,
            expectedSession: session)
    }

    public func removeAttachment(_ id: OpenClawPendingAttachment.ID) {
        attachments.removeAll { $0.id == id }
        applyDeferredExternalStateIfReady()
    }

    /// True while replacing this model could move an attachment across chats.
    public var isAttachmentOwnerPinned: Bool {
        self.blocksAttachmentOwnerChange
    }

    var blocksAttachmentOwnerChange: Bool {
        attachmentOwnerIsActive() ||
            isSendingAttachmentDraft ||
            attachmentStagingCount > 0 ||
            !attachments.isEmpty
    }

    func canCreateSessionForImmediateSwitch() -> Bool {
        guard !self.blocksAttachmentOwnerChange else {
            self.errorText = String(
                localized: "Remove attachments or wait for delivery to resolve before starting a new chat.")
            return false
        }
        return true
    }

    /// Applies external owner changes once recording or staging releases them.
    public func attachmentOwnerActivityChanged() {
        applyDeferredExternalStateIfReady()
    }

    /// File reads and image processing suspend before the attachment exists.
    /// Keep their original chat owner pinned until staging succeeds or fails.
    func beginAttachmentStaging() {
        attachmentStagingCount += 1
    }

    func endAttachmentStaging() {
        precondition(attachmentStagingCount > 0)
        attachmentStagingCount -= 1
        applyDeferredExternalStateIfReady()
    }

    /// Stages a recorded m4a voice note and removes its temporary file.
    public func addVoiceNoteAttachment(fileURL: URL, durationSeconds: Double) async {
        self.beginAttachmentStaging()
        defer {
            try? FileManager.default.removeItem(at: fileURL)
            self.endAttachmentStaging()
        }

        let data: Data
        do {
            data = try await Task.detached(priority: .userInitiated) {
                try Data(contentsOf: fileURL)
            }.value
        } catch {
            errorText = String(
                format: String(localized: "Could not attach voice note: %@"),
                error.localizedDescription)
            return
        }

        guard data.count <= Self.maxAttachmentBytes else {
            errorText = String(localized: "Voice note exceeds the 5 MB attachment limit")
            return
        }

        let normalizedDuration = durationSeconds.isFinite
            ? min(max(0, durationSeconds), OpenClawVoiceNoteRecorder.maximumDurationSeconds)
            : 0
        attachments.append(
            OpenClawPendingAttachment(
                url: nil,
                data: data,
                fileName: fileURL.lastPathComponent,
                mimeType: "audio/mp4",
                preview: nil,
                durationSeconds: normalizedDuration))
    }

    func loadAttachments(urls: [URL], expectedSession: SessionSnapshot? = nil) async {
        for url in urls {
            guard self.ownsAttachmentSession(expectedSession) else { return }
            let hasSecurityScope = url.startAccessingSecurityScopedResource()
            defer {
                if hasSecurityScope {
                    url.stopAccessingSecurityScopedResource()
                }
            }
            do {
                let data = try await Task.detached { try Data(contentsOf: url) }.value
                await self.addImageAttachment(
                    url: url,
                    data: data,
                    fileName: url.lastPathComponent,
                    mimeType: Self.mimeType(for: url) ?? "application/octet-stream",
                    expectedSession: expectedSession)
            } catch {
                guard self.ownsAttachmentSession(expectedSession) else { return }
                self.errorText = error.localizedDescription
            }
        }
    }

    static func mimeType(for url: URL) -> String? {
        let ext = url.pathExtension
        guard !ext.isEmpty else { return nil }
        return (UTType(filenameExtension: ext) ?? .data).preferredMIMEType
    }

    func addImageAttachment(
        url: URL?,
        data: Data,
        fileName: String,
        mimeType: String,
        expectedSession: SessionSnapshot? = nil) async
    {
        guard self.ownsAttachmentSession(expectedSession) else { return }
        let uti: UTType = {
            if let url {
                return UTType(filenameExtension: url.pathExtension) ?? .data
            }
            return UTType(mimeType: mimeType) ?? .data
        }()
        guard uti.conforms(to: .image) else {
            errorText = String(localized: "Only image attachments are supported right now")
            return
        }

        let processed: Data
        do {
            processed = try await Task.detached(priority: .userInitiated) {
                try ChatImageProcessor.processForUpload(data: data)
            }.value
        } catch {
            guard self.ownsAttachmentSession(expectedSession) else { return }
            errorText = String(
                format: String(localized: "Could not process %1$@: %2$@"),
                fileName,
                error.localizedDescription)
            return
        }

        // Image processing runs off actor. Revalidate the draft owner before
        // publishing either the attachment or any session-scoped error state.
        guard self.ownsAttachmentSession(expectedSession) else { return }
        if processed.count > Self.maxAttachmentBytes {
            errorText = String(
                format: String(localized: "Attachment %@ exceeds 5 MB limit after resizing"),
                fileName)
            return
        }

        let outputFileName: String = {
            let baseName = (fileName as NSString).deletingPathExtension
            return baseName.isEmpty ? "image.jpg" : "\(baseName).jpg"
        }()

        let preview = Self.previewImage(data: processed)
        attachments.append(
            OpenClawPendingAttachment(
                url: url,
                data: processed,
                fileName: outputFileName,
                mimeType: "image/jpeg",
                preview: preview))
    }

    private func ownsAttachmentSession(_ expectedSession: SessionSnapshot?) -> Bool {
        expectedSession.map(self.isCurrentSession) ?? true
    }

    static func previewImage(data: Data) -> OpenClawPlatformImage? {
        #if canImport(AppKit)
        NSImage(data: data)
        #elseif canImport(UIKit)
        UIImage(data: data)
        #else
        nil
        #endif
    }
}
