import Foundation
import OpenClawKit
import os
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private struct ShareAttachment: Codable {
        var type: String
        var mimeType: String
        var fileName: String
        var content: String
    }

    /// Keeps the encoded payload with its preview so the compose card can show
    /// thumbnails without re-decoding base64 content.
    private struct LoadedAttachment {
        var payload: ShareAttachment
        var preview: UIImage
    }

    private struct ExtractedShareContent {
        var payload: SharedContentPayload
        var attachments: [LoadedAttachment]
        var attachmentSummary: ShareAttachmentSummary
        var attachmentError: ShareImageProcessor.ProcessError?
    }

    private let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "ShareExtension")
    private let composeView = ShareComposeView()
    private var didPrepareDraft = false
    private var isSending = false
    private var pendingAttachments: [ShareAttachment] = []
    /// Keep omission state controller-owned so send cannot bypass the disabled UI.
    private var attachmentBlockReason: ShareAttachmentBlockReason?

    override func loadView() {
        self.view = self.composeView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        self.preferredContentSize = CGSize(width: UIScreen.main.bounds.width, height: 420)
        self.composeView.onSend = { [weak self] in self?.handleSendTap() }
        self.composeView.onCancel = { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !self.didPrepareDraft else { return }
        self.didPrepareDraft = true
        Task { await self.prepareDraft() }
    }

    private func prepareDraft() async {
        let traceId = UUID().uuidString
        ShareGatewayRelaySettings.saveLastEvent("Share opened.")
        self.composeView.apply(.preparing)
        self.logger.info("share begin trace=\(traceId, privacy: .public)")
        let extracted = await self.extractSharedContent()
        let payload = extracted.payload
        self.pendingAttachments = extracted.attachments.map(\.payload)
        self.attachmentBlockReason = ShareAttachmentBlockReason.resolve(
            hasImageProcessingError: extracted.attachmentError != nil,
            summary: extracted.attachmentSummary)
        self.logger.info("share payload trace=\(traceId, privacy: .public)")
        self.logger.info(
            "share payload title=\(payload.title?.count ?? 0) text=\(payload.text?.count ?? 0)")
        self.logger.info(
            "share attachments hasURL=\(payload.url != nil) images=\(self.pendingAttachments.count)")
        let message = ShareDraftComposer.compose(from: payload)
        self.composeView.setDraft(message)
        self.composeView.setAttachmentPreviews(extracted.attachments.map(\.preview))
        self.composeView.focusDraft()
        if let blockReason = self.attachmentBlockReason {
            self.applyAttachmentBlockReason(blockReason)
        } else if message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            self.composeView.apply(.ready)
            ShareGatewayRelaySettings.saveLastEvent("Share ready: waiting for message input.")
        } else {
            self.composeView.apply(.ready)
            ShareGatewayRelaySettings.saveLastEvent("Share ready: draft prepared.")
        }
    }

    private func handleSendTap() {
        guard !self.isSending else { return }
        Task { await self.sendCurrentDraft() }
    }

    private func sendCurrentDraft() async {
        if let blockReason = self.attachmentBlockReason {
            self.applyAttachmentBlockReason(blockReason)
            return
        }
        let trimmed = self.composeView.draftText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            ShareGatewayRelaySettings.saveLastEvent("Share blocked: message is empty.")
            self.composeView.apply(.failed(NSLocalizedString(
                "Message is empty.",
                comment: "Share extension empty message status")))
            return
        }

        self.isSending = true
        self.composeView.apply(.sending)
        ShareGatewayRelaySettings.saveLastEvent("Sending to gateway…")
        do {
            try await self.sendMessageToGateway(trimmed, attachments: self.pendingAttachments)
            ShareGatewayRelaySettings.saveLastEvent(
                "Sent to gateway (\(trimmed.count) chars, \(self.pendingAttachments.count) attachment(s)).")
            self.composeView.apply(.sent)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            // Give the success state a visible beat before the sheet dismisses.
            try? await Task.sleep(for: .milliseconds(600))
            self.extensionContext?.completeRequest(returningItems: nil)
        } catch {
            self.logger.error("share send failed reason=\(error.localizedDescription, privacy: .public)")
            ShareGatewayRelaySettings.saveLastEvent("Send failed: \(error.localizedDescription)")
            self.isSending = false
            self.composeView.apply(.failed(String(
                format: NSLocalizedString("Send failed: %@", comment: "Share extension failure status"),
                error.localizedDescription)))
        }
    }

    private func sendMessageToGateway(_ message: String, attachments: [ShareAttachment]) async throws {
        guard let config = ShareGatewayRelaySettings.loadConfigDiscardingUnscopedDeviceAuth() else {
            throw NSError(
                domain: "OpenClawShare",
                code: 10,
                userInfo: [
                    NSLocalizedDescriptionKey: NSLocalizedString(
                        "OpenClaw is not connected to a gateway yet.",
                        comment: "Share extension missing gateway error"),
                ])
        }
        guard let url = URL(string: config.gatewayURLString) else {
            throw NSError(
                domain: "OpenClawShare",
                code: 11,
                userInfo: [
                    NSLocalizedDescriptionKey: NSLocalizedString(
                        "Invalid saved gateway URL.",
                        comment: "Share extension invalid gateway error"),
                ])
        }

        let gateway = GatewayNodeSession()
        defer {
            Task { await gateway.disconnect() }
        }
        let makeOptions: (String) -> GatewayConnectOptions = { clientId in
            GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: clientId,
                clientMode: "node",
                clientDisplayName: "OpenClaw Share",
                deviceIdentityProfile: .shareExtension,
                includeDeviceIdentity: true,
                allowStoredDeviceAuth: config.gatewayStableID != nil,
                deviceAuthGatewayID: config.gatewayStableID)
        }

        do {
            try await gateway.connect(
                url: url,
                credentials: GatewayNodeSessionCredentials(
                    token: config.token,
                    password: config.password),
                connectOptions: makeOptions("openclaw-ios"),
                sessionBox: nil,
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in
                    BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: OpenClawNodeError(
                            code: .invalidRequest,
                            message: "share extension does not support node invoke"))
                })
        } catch {
            let expectsLegacyClientId = self.shouldRetryWithLegacyClientId(error)
            guard expectsLegacyClientId else { throw error }
            try await gateway.connect(
                url: url,
                credentials: GatewayNodeSessionCredentials(
                    token: config.token,
                    password: config.password),
                connectOptions: makeOptions("moltbot-ios"),
                sessionBox: nil,
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in
                    BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: OpenClawNodeError(
                            code: .invalidRequest,
                            message: "share extension does not support node invoke"))
                })
        }

        struct AgentRequestPayload: Codable {
            var message: String
            var sessionKey: String?
            var thinking: String
            var deliver: Bool
            var attachments: [ShareAttachment]?
            var receipt: Bool
            var receiptText: String?
            var to: String?
            var channel: String?
            var timeoutSeconds: Int?
            var key: String?
        }

        let deliveryChannel = config.deliveryChannel?.trimmingCharacters(in: .whitespacesAndNewlines)
        let deliveryTo = config.deliveryTo?.trimmingCharacters(in: .whitespacesAndNewlines)
        let canDeliverToRoute = (deliveryChannel?.isEmpty == false) && (deliveryTo?.isEmpty == false)

        let params = AgentRequestPayload(
            message: message,
            sessionKey: config.sessionKey,
            thinking: "low",
            deliver: canDeliverToRoute,
            attachments: attachments.isEmpty ? nil : attachments,
            receipt: canDeliverToRoute,
            receiptText: canDeliverToRoute ? "Just received your iOS share + request, working on it." : nil,
            to: canDeliverToRoute ? deliveryTo : nil,
            channel: canDeliverToRoute ? deliveryChannel : nil,
            timeoutSeconds: nil,
            key: UUID().uuidString)
        let data = try JSONEncoder().encode(params)
        guard let json = String(data: data, encoding: .utf8) else {
            throw NSError(
                domain: "OpenClawShare",
                code: 12,
                userInfo: [NSLocalizedDescriptionKey: "Failed to encode chat payload."])
        }
        struct NodeEventParams: Codable {
            var event: String
            var payloadJSON: String
        }
        let eventData = try JSONEncoder().encode(NodeEventParams(event: "agent.request", payloadJSON: json))
        guard let nodeEventParams = String(data: eventData, encoding: .utf8) else {
            throw NSError(
                domain: "OpenClawShare",
                code: 13,
                userInfo: [NSLocalizedDescriptionKey: "Failed to encode node event payload."])
        }
        _ = try await gateway.request(method: "node.event", paramsJSON: nodeEventParams, timeoutSeconds: 25)
    }

    private func shouldRetryWithLegacyClientId(_ error: Error) -> Bool {
        if let gatewayError = error as? GatewayResponseError {
            let code = gatewayError.code.lowercased()
            let message = gatewayError.message.lowercased()
            let pathValue = (gatewayError.details["path"]?.value as? String)?.lowercased() ?? ""
            let mentionsClientIdPath =
                message.contains("/client/id") || message.contains("client id")
                || pathValue.contains("/client/id")
            let isInvalidConnectParams =
                (code.contains("invalid") && code.contains("connect"))
                || message.contains("invalid connect params")
            if isInvalidConnectParams, mentionsClientIdPath {
                return true
            }
        }

        let text = error.localizedDescription.lowercased()
        return text.contains("invalid connect params")
            && (text.contains("/client/id") || text.contains("client id"))
    }

    private func extractSharedContent() async -> ExtractedShareContent {
        guard let items = self.extensionContext?.inputItems as? [NSExtensionItem] else {
            return ExtractedShareContent(
                payload: SharedContentPayload(title: nil, url: nil, text: nil),
                attachments: [],
                attachmentSummary: ShareAttachmentSummary(),
                attachmentError: nil)
        }

        var title: String?
        var sharedURL: URL?
        var sharedText: String?
        var attributedContentText: String?
        var attachments: [LoadedAttachment] = []
        var attachmentSummary = ShareAttachmentSummary()
        var attachmentError: ShareImageProcessor.ProcessError?
        let maxImageAttachments = 3

        for item in items {
            if title == nil {
                title = item.attributedTitle?.string
            }
            if attributedContentText == nil {
                attributedContentText = item.attributedContentText?.string
            }

            for provider in item.attachments ?? [] {
                let providerURL = sharedURL == nil ? await self.loadURL(from: provider) : nil
                let providerText = sharedText == nil ? await self.loadText(from: provider) : nil
                if let providerURL {
                    sharedURL = providerURL
                }
                if let providerText {
                    sharedText = providerText
                }

                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    attachmentSummary.selectedImageCount += 1
                    if attachments.count < maxImageAttachments, attachmentError == nil {
                        do {
                            let attachment = try await self.loadImageAttachment(
                                from: provider,
                                index: attachments.count)
                            attachments.append(attachment)
                        } catch let error as ShareImageProcessor.ProcessError {
                            attachmentError = error
                        } catch {
                            attachmentError = .encodeFailed
                        }
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                    attachmentSummary.videoCount += 1
                } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    attachmentSummary.fileCount += 1
                } else {
                    // UTI conformance only promises a representation exists; count it as handled
                    // only after the provider successfully delivers content we can send.
                    attachmentSummary.recordUnclassifiedProvider(
                        didLoadContent: providerURL != nil || providerText != nil)
                }
            }
        }
        attachmentSummary.acceptedImageCount = attachments.count

        // Share hosts often mirror provider text in attributedContentText.
        // Preserve distinct content as the historical title, but do not duplicate provider data.
        let supplementalTitle = SharePayloadNormalizer.distinctAttributedText(
            attributedContentText,
            sharedText: sharedText,
            sharedURL: sharedURL)
        return ExtractedShareContent(
            payload: SharedContentPayload(title: title ?? supplementalTitle, url: sharedURL, text: sharedText),
            attachments: attachments,
            attachmentSummary: attachmentSummary,
            attachmentError: attachmentError)
    }

    private func loadImageAttachment(from provider: NSItemProvider, index: Int) async throws -> LoadedAttachment {
        let imageUTI = self.preferredImageTypeIdentifier(from: provider) ?? UTType.image.identifier
        guard let rawData = await self.loadDataValue(from: provider, typeIdentifier: imageUTI) else {
            throw ShareImageProcessor.ProcessError.invalidImage
        }

        let data = try await Task.detached(priority: .userInitiated) {
            try ShareImageProcessor.processForUpload(data: rawData)
        }.value
        guard let image = UIImage(data: data) else {
            throw ShareImageProcessor.ProcessError.invalidImage
        }

        return await LoadedAttachment(
            payload: ShareAttachment(
                type: "image",
                mimeType: "image/jpeg",
                fileName: "shared-image-\(index + 1).jpg",
                content: data.base64EncodedString()),
            preview: self.boundedPreview(from: image))
    }

    private func imageProcessingErrorMessage() -> String {
        NSLocalizedString(
            "The shared image could not be prepared.",
            comment: "Share extension image processing failure")
    }

    private func applyAttachmentBlockReason(_ blockReason: ShareAttachmentBlockReason) {
        switch blockReason {
        case .imageProcessingFailed:
            ShareGatewayRelaySettings.saveLastEvent("Share blocked: image processing failed.")
            self.composeView.apply(.blocked(self.imageProcessingErrorMessage()))
        case let .omitted(message):
            ShareGatewayRelaySettings.saveLastEvent("Share blocked: attachment(s) omitted.")
            self.composeView.apply(.blocked(message))
        }
    }

    /// Previews are retained for the sheet's lifetime; keep them bounded so
    /// three full-resolution photos cannot blow the extension memory cap.
    /// Never falls back to the full-size image.
    private func boundedPreview(from image: UIImage) async -> UIImage {
        let maxPixels: CGFloat = 336
        if let thumbnail = await image.byPreparingThumbnail(ofSize: CGSize(width: maxPixels, height: maxPixels)) {
            return thumbnail
        }
        let longestSide = max(image.size.width * image.scale, image.size.height * image.scale, 1)
        let scale = min(maxPixels / longestSide, 1)
        let target = CGSize(
            width: max(image.size.width * image.scale * scale, 1),
            height: max(image.size.height * image.scale * scale, 1))
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }

    private func preferredImageTypeIdentifier(from provider: NSItemProvider) -> String? {
        for identifier in provider.registeredTypeIdentifiers {
            guard let utType = UTType(identifier) else { continue }
            if utType.conforms(to: .image) {
                return identifier
            }
        }
        return nil
    }

    private func loadURL(from provider: NSItemProvider) async -> URL? {
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = await self.loadURLValue(
                from: provider,
                typeIdentifier: UTType.url.identifier)
            {
                return url
            }
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.text.identifier) {
            if let text = await self.loadTextValue(from: provider, typeIdentifier: UTType.text.identifier),
               let url = SharePayloadNormalizer.webURL(from: text)
            {
                return url
            }
        }

        return nil
    }

    private func loadText(from provider: NSItemProvider) async -> String? {
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let text = await self.loadTextValue(from: provider, typeIdentifier: UTType.plainText.identifier) {
                return text
            }
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.text.identifier) {
            if let text = await self.loadTextValue(from: provider, typeIdentifier: UTType.text.identifier) {
                return text
            }
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = await self.loadURLValue(from: provider, typeIdentifier: UTType.url.identifier) {
                return url.absoluteString
            }
        }

        return nil
    }

    private func loadURLValue(from provider: NSItemProvider, typeIdentifier: String) async -> URL? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                if let url = item as? URL {
                    continuation.resume(returning: url)
                    return
                }
                if let str = item as? String, let url = URL(string: str) {
                    continuation.resume(returning: url)
                    return
                }
                if let ns = item as? NSString, let url = URL(string: ns as String) {
                    continuation.resume(returning: url)
                    return
                }
                continuation.resume(returning: nil)
            }
        }
    }

    private func loadTextValue(from provider: NSItemProvider, typeIdentifier: String) async -> String? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                if let text = item as? String {
                    continuation.resume(returning: text)
                    return
                }
                if let text = item as? NSString {
                    continuation.resume(returning: text as String)
                    return
                }
                if let text = item as? NSAttributedString {
                    continuation.resume(returning: text.string)
                    return
                }
                continuation.resume(returning: nil)
            }
        }
    }

    private func loadDataValue(from provider: NSItemProvider, typeIdentifier: String) async -> Data? {
        await withCheckedContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, _ in
                continuation.resume(returning: data)
            }
        }
    }
}
