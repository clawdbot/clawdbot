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

    private struct ExtractedShareContent {
        var payload: SharedContentPayload
        var attachments: [ShareAttachment]
    }

    private let logger = Logger(subsystem: "ai.openclaw.ios", category: "ShareExtension")
    private var statusLabel: UILabel?
    private let draftTextView = UITextView()
    private let sendButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)
    private var didPrepareDraft = false
    private var isSending = false
    private var pendingAttachments: [ShareAttachment] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        self.preferredContentSize = CGSize(width: UIScreen.main.bounds.width, height: 420)
        self.setupUI()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !self.didPrepareDraft else { return }
        self.didPrepareDraft = true
        Task { await self.prepareDraft() }
    }

    private func setupUI() {
        self.view.backgroundColor = .systemBackground

        self.draftTextView.translatesAutoresizingMaskIntoConstraints = false
        self.draftTextView.font = .preferredFont(forTextStyle: .body)
        self.draftTextView.backgroundColor = UIColor.secondarySystemBackground
        self.draftTextView.layer.cornerRadius = 10
        self.draftTextView.textContainerInset = UIEdgeInsets(top: 12, left: 10, bottom: 12, right: 10)

        self.sendButton.translatesAutoresizingMaskIntoConstraints = false
        self.sendButton.setTitle("Send to OpenClaw", for: .normal)
        self.sendButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        self.sendButton.addTarget(self, action: #selector(self.handleSendTap), for: .touchUpInside)
        self.sendButton.isEnabled = false

        self.cancelButton.translatesAutoresizingMaskIntoConstraints = false
        self.cancelButton.setTitle("Cancel", for: .normal)
        self.cancelButton.addTarget(self, action: #selector(self.handleCancelTap), for: .touchUpInside)

        let buttons = UIStackView(arrangedSubviews: [self.cancelButton, self.sendButton])
        buttons.translatesAutoresizingMaskIntoConstraints = false
        buttons.axis = .horizontal
        buttons.alignment = .fill
        buttons.distribution = .fillEqually
        buttons.spacing = 12

        self.view.addSubview(self.draftTextView)
        self.view.addSubview(buttons)

        NSLayoutConstraint.activate([
            self.draftTextView.topAnchor.constraint(equalTo: self.view.safeAreaLayoutGuide.topAnchor, constant: 14),
            self.draftTextView.leadingAnchor.constraint(equalTo: self.view.leadingAnchor, constant: 14),
            self.draftTextView.trailingAnchor.constraint(equalTo: self.view.trailingAnchor, constant: -14),
            self.draftTextView.bottomAnchor.constraint(equalTo: buttons.topAnchor, constant: -12),

            buttons.leadingAnchor.constraint(equalTo: self.view.leadingAnchor, constant: 14),
            buttons.trailingAnchor.constraint(equalTo: self.view.trailingAnchor, constant: -14),
            buttons.bottomAnchor.constraint(equalTo: self.view.keyboardLayoutGuide.topAnchor, constant: -8),
            buttons.heightAnchor.constraint(equalToConstant: 44),
        ])
    }

    private func prepareDraft() async {
        let traceId = UUID().uuidString
        ShareGatewayRelaySettings.saveLastEvent("Share opened.")
        self.showStatus("Preparing share…")
        self.logger.info("share begin trace=\(traceId, privacy: .public)")
        let extracted = await self.extractSharedContent()
        let payload = extracted.payload
        self.pendingAttachments = extracted.attachments
        self.logger.info("share payload trace=\(traceId, privacy: .public)")
        self.logger.info(
            "share payload title=\(payload.title?.count ?? 0) text=\(payload.text?.count ?? 0)")
        self.logger.info(
            "share attachments hasURL=\(payload.url != nil) images=\(self.pendingAttachments.count)")
        let message = self.composeDraft(from: payload)
        await MainActor.run {
            self.draftTextView.text = message
            self.sendButton.isEnabled = true
            self.draftTextView.becomeFirstResponder()
        }
        if message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            ShareGatewayRelaySettings.saveLastEvent("Share ready: waiting for message input.")
            self.showStatus("Add a message, then tap Send.")
        } else {
            ShareGatewayRelaySettings.saveLastEvent("Share ready: draft prepared.")
            self.showStatus("Edit text, then tap Send.")
        }
    }

    @objc
    private func handleSendTap() {
        guard !self.isSending else { return }
        Task { await self.sendCurrentDraft() }
    }

    @objc
    private func handleCancelTap() {
        self.extensionContext?.completeRequest(returningItems: nil)
    }

    private func sendCurrentDraft() async {
        let message = await MainActor.run { self.draftTextView.text ?? "" }
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            ShareGatewayRelaySettings.saveLastEvent("Share blocked: message is empty.")
            self.showStatus("Message is empty.")
            return
        }

        await MainActor.run {
            self.isSending = true
            self.sendButton.isEnabled = false
            self.cancelButton.isEnabled = false
        }
        self.showStatus("Sending to OpenClaw gateway…")
        ShareGatewayRelaySettings.saveLastEvent("Sending to gateway…")
        do {
            try await self.sendMessageToGateway(trimmed, attachments: self.pendingAttachments)
            ShareGatewayRelaySettings.saveLastEvent(
                "Sent to gateway (\(trimmed.count) chars, \(self.pendingAttachments.count) attachment(s)).")
            self.showStatus("Sent to OpenClaw.")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                self.extensionContext?.completeRequest(returningItems: nil)
            }
        } catch {
            self.logger.error("share send failed reason=\(error.localizedDescription, privacy: .public)")
            ShareGatewayRelaySettings.saveLastEvent("Send failed: \(error.localizedDescription)")
            self.showStatus("Send failed: \(error.localizedDescription)")
            await MainActor.run {
                self.isSending = false
                self.sendButton.isEnabled = true
                self.cancelButton.isEnabled = true
            }
        }
    }

    private func sendMessageToGateway(_ message: String, attachments: [ShareAttachment]) async throws {
        guard let config = ShareGatewayRelaySettings.loadConfig() else {
            throw NSError(
                domain: "OpenClawShare",
                code: 10,
                userInfo: [NSLocalizedDescriptionKey: "OpenClaw is not connected to a gateway yet."])
        }
        guard let url = URL(string: config.gatewayURLString) else {
            throw NSError(
                domain: "OpenClawShare",
                code: 11,
                userInfo: [NSLocalizedDescriptionKey: "Invalid saved gateway URL."])
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
                includeDeviceIdentity: false)
        }

        do {
            try await gateway.connect(
                url: url,
                token: config.token,
                bootstrapToken: nil,
                password: config.password,
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
                token: config.token,
                bootstrapToken: nil,
                password: config.password,
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

    private func showStatus(_ text: String) {
        DispatchQueue.main.async {
            let label: UILabel
            if let existing = self.statusLabel {
                label = existing
            } else {
                let newLabel = UILabel()
                newLabel.translatesAutoresizingMaskIntoConstraints = false
                newLabel.numberOfLines = 0
                newLabel.textAlignment = .center
                newLabel.font = .preferredFont(forTextStyle: .body)
                newLabel.textColor = .label
                newLabel.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.92)
                newLabel.layer.cornerRadius = 12
                newLabel.clipsToBounds = true
                newLabel.layoutMargins = UIEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
                self.view.addSubview(newLabel)
                NSLayoutConstraint.activate([
                    newLabel.leadingAnchor.constraint(equalTo: self.view.leadingAnchor, constant: 18),
                    newLabel.trailingAnchor.constraint(equalTo: self.view.trailingAnchor, constant: -18),
                    newLabel.bottomAnchor.constraint(equalTo: self.sendButton.topAnchor, constant: -10),
                ])
                self.statusLabel = newLabel
                label = newLabel
            }
            label.text = "  \(text)  "
        }
    }

    private func composeDraft(from payload: SharedContentPayload) -> String {
        var lines: [String] = []
        let title = self.sanitizeDraftFragment(payload.title)
        let text = self.sanitizeDraftFragment(payload.text)
        let url = payload.url?.absoluteString.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        if let title, !title.isEmpty { lines.append(title) }
        if let text, !text.isEmpty { lines.append(text) }
        if !url.isEmpty { lines.append(url) }

        return lines.joined(separator: "\n\n")
    }

    private func sanitizeDraftFragment(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let banned = [
            "shared from ios.",
            "text:",
            "shared attachment(s):",
            "please help me with this.",
            "please help me with this.w",
        ]
        let cleanedLines = raw
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { line in
                guard !line.isEmpty else { return false }
                let lowered = line.lowercased()
                return !banned.contains { lowered == $0 || lowered.hasPrefix($0) }
            }
        let cleaned = cleanedLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned
    }

    private func extractSharedContent() async -> ExtractedShareContent {
        guard let items = self.extensionContext?.inputItems as? [NSExtensionItem] else {
            return ExtractedShareContent(
                payload: SharedContentPayload(title: nil, url: nil, text: nil),
                attachments: [])
        }

        var title: String?
        var sharedURL: URL?
        var sharedText: String?
        var imageCount = 0
        var videoCount = 0
        var fileCount = 0
        var unknownCount = 0
        var attachments: [ShareAttachment] = []
        let maxImageAttachments = 3

        for item in items {
            if title == nil {
                title = item.attributedTitle?.string ?? item.attributedContentText?.string
            }

            for provider in item.attachments ?? [] {
                if sharedURL == nil {
                    sharedURL = await self.loadURL(from: provider)
                }

                if sharedText == nil {
                    sharedText = await self.loadText(from: provider)
                }

                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    imageCount += 1
                    if attachments.count < maxImageAttachments,
                       let attachment = await self.loadImageAttachment(from: provider, index: attachments.count)
                    {
                        attachments.append(attachment)
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                    videoCount += 1
                } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    fileCount += 1
                } else {
                    unknownCount += 1
                }
            }
        }

        _ = imageCount
        _ = videoCount
        _ = fileCount
        _ = unknownCount

        return ExtractedShareContent(
            payload: SharedContentPayload(title: title, url: sharedURL, text: sharedText),
            attachments: attachments)
    }

    private func loadImageAttachment(from provider: NSItemProvider, index: Int) async -> ShareAttachment? {
        let imageUTI = self.preferredImageTypeIdentifier(from: provider) ?? UTType.image.identifier
        guard let rawData = await self.loadDataValue(from: provider, typeIdentifier: imageUTI) else {
            return nil
        }

        let maxBytes = 5_000_000
        guard let image = UIImage(data: rawData),
              let data = self.normalizedJPEGData(from: image, maxBytes: maxBytes)
        else {
            return nil
        }

        return ShareAttachment(
            type: "image",
            mimeType: "image/jpeg",
            fileName: "shared-image-\(index + 1).jpg",
            content: data.base64EncodedString())
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

    private func normalizedJPEGData(from image: UIImage, maxBytes: Int) -> Data? {
        var quality: CGFloat = 0.9
        while quality >= 0.4 {
            if let data = image.jpegData(compressionQuality: quality), data.count <= maxBytes {
                return data
            }
            quality -= 0.1
        }
        guard let fallback = image.jpegData(compressionQuality: 0.35) else { return nil }
        if fallback.count <= maxBytes { return fallback }
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
               let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
               url.scheme != nil
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
