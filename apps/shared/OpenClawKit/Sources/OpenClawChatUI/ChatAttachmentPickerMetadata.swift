import Foundation
import UniformTypeIdentifiers

struct OpenClawChatPickerAttachmentMetadata: Equatable, Sendable {
    static let allowedFileContentTypes: [UTType] = [
        .image,
        .movie,
        .mpeg4Movie,
        .quickTimeMovie,
    ]

    let fileExtension: String
    let mimeType: String

    static func resolve(contentType: UTType, transferredFileURL: URL? = nil) -> Self {
        let isVideo = contentType.conforms(to: .movie)
        let transferredExtension = transferredFileURL?.pathExtension
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let transferredType = transferredExtension.flatMap { extensionName in
            extensionName.isEmpty ? nil : UTType(filenameExtension: extensionName)
        }
        if isVideo {
            return Self(
                fileExtension: transferredType?.preferredFilenameExtension
                    ?? transferredExtension.flatMap { $0.isEmpty ? nil : $0 }
                    ?? contentType.preferredFilenameExtension
                    ?? "mov",
                mimeType: transferredType?.preferredMIMEType
                    ?? contentType.preferredMIMEType
                    ?? "video/quicktime")
        }
        return Self(
            fileExtension: contentType.preferredFilenameExtension ?? "jpg",
            mimeType: contentType.preferredMIMEType ?? "image/jpeg")
    }
}
