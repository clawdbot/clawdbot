import Foundation
import OpenClawKit
import UniformTypeIdentifiers

struct ExtractedShareProviderContent {
    var payload: SharedContentPayload
    var imageProviders: [NSItemProvider]
    var attachmentSummary: ShareAttachmentSummary
}

@MainActor
enum ShareContentExtractor {
    static func extract(from items: [NSExtensionItem]) async -> ExtractedShareProviderContent {
        var title: String?
        var attributedContentText: String?
        var providers: [NSItemProvider] = []
        for item in items {
            if title == nil { title = item.attributedTitle?.string }
            if attributedContentText == nil { attributedContentText = item.attributedContentText?.string }
            providers.append(contentsOf: item.attachments ?? [])
        }

        var providersWithLoadedContent = Set<ObjectIdentifier>()
        var sharedURL: URL?
        for provider in providers {
            guard let providerURL = await self.loadURL(from: provider) else { continue }
            sharedURL = providerURL
            providersWithLoadedContent.insert(ObjectIdentifier(provider))
            break
        }

        var sharedText: String?
        for provider in providers {
            guard let providerText = await self.loadText(from: provider) else { continue }
            providersWithLoadedContent.insert(ObjectIdentifier(provider))
            guard let distinctText = SharePayloadNormalizer.distinctProviderText(
                providerText,
                sharedURL: sharedURL)
            else { continue }
            sharedText = distinctText
            break
        }

        var imageProviders: [NSItemProvider] = []
        var attachmentSummary = ShareAttachmentSummary()
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                attachmentSummary.selectedImageCount += 1
                imageProviders.append(provider)
            } else if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                attachmentSummary.videoCount += 1
            } else if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                attachmentSummary.fileCount += 1
            } else {
                // UTI conformance only promises a representation exists; count it as handled
                // only after the provider successfully delivers content we can send.
                attachmentSummary.recordUnclassifiedProvider(
                    didLoadContent: providersWithLoadedContent.contains(ObjectIdentifier(provider)))
            }
        }

        let supplementalTitle = SharePayloadNormalizer.distinctAttributedText(
            attributedContentText,
            sharedText: sharedText,
            sharedURL: sharedURL)
        return ExtractedShareProviderContent(
            payload: SharedContentPayload(title: title ?? supplementalTitle, url: sharedURL, text: sharedText),
            imageProviders: imageProviders,
            attachmentSummary: attachmentSummary)
    }

    private static func loadURL(from provider: NSItemProvider) async -> URL? {
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
           let url = await self.loadURLValue(from: provider, typeIdentifier: UTType.url.identifier)
        {
            return url
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.text.identifier),
           let text = await self.loadTextValue(from: provider, typeIdentifier: UTType.text.identifier),
           let url = SharePayloadNormalizer.webURL(from: text)
        {
            return url
        }

        return nil
    }

    private static func loadText(from provider: NSItemProvider) async -> String? {
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
           let text = await self.loadTextValue(from: provider, typeIdentifier: UTType.plainText.identifier)
        {
            return text
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.text.identifier),
           let text = await self.loadTextValue(from: provider, typeIdentifier: UTType.text.identifier)
        {
            return text
        }

        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
           let url = await self.loadURLValue(from: provider, typeIdentifier: UTType.url.identifier)
        {
            return url.absoluteString
        }

        return nil
    }

    private static func loadURLValue(from provider: NSItemProvider, typeIdentifier: String) async -> URL? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                if let url = item as? URL {
                    continuation.resume(returning: url)
                } else if let value = item as? String, let url = URL(string: value) {
                    continuation.resume(returning: url)
                } else if let value = item as? NSString, let url = URL(string: value as String) {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    private static func loadTextValue(from provider: NSItemProvider, typeIdentifier: String) async -> String? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                if let text = item as? String {
                    continuation.resume(returning: text)
                } else if let text = item as? NSString {
                    continuation.resume(returning: text as String)
                } else if let text = item as? NSAttributedString {
                    continuation.resume(returning: text.string)
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }
}
