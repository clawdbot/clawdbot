import Foundation

struct ShareAttachmentSummary: Equatable {
    var selectedImageCount = 0
    var acceptedImageCount = 0
    var videoCount = 0
    var fileCount = 0
    var unknownCount = 0

    mutating func recordUnclassifiedProvider(didLoadContent: Bool) {
        if !didLoadContent {
            self.unknownCount += 1
        }
    }

    var omissionMessage: String? {
        var details: [String] = []

        if self.selectedImageCount > self.acceptedImageCount {
            details.append(String(
                format: NSLocalizedString(
                    "Only %d of %d images can be sent.",
                    comment: "Share extension image attachment limit warning"),
                self.acceptedImageCount,
                self.selectedImageCount))
        }

        var unsupported: [String] = []
        if self.videoCount > 0 {
            let format = if self.videoCount == 1 {
                NSLocalizedString("%d video", comment: "Share extension unsupported video count")
            } else {
                NSLocalizedString("%d videos", comment: "Share extension unsupported video count")
            }
            unsupported.append(String(
                format: format,
                self.videoCount))
        }
        if self.fileCount > 0 {
            let format = if self.fileCount == 1 {
                NSLocalizedString("%d file", comment: "Share extension unsupported file count")
            } else {
                NSLocalizedString("%d files", comment: "Share extension unsupported file count")
            }
            unsupported.append(String(
                format: format,
                self.fileCount))
        }
        if self.unknownCount > 0 {
            let format = if self.unknownCount == 1 {
                NSLocalizedString("%d unsupported item", comment: "Share extension unsupported attachment count")
            } else {
                NSLocalizedString("%d unsupported items", comment: "Share extension unsupported attachment count")
            }
            unsupported.append(String(
                format: format,
                self.unknownCount))
        }

        if !unsupported.isEmpty {
            details.append(String(
                format: NSLocalizedString(
                    "OpenClaw Share cannot send %@ yet.",
                    comment: "Share extension unsupported attachment warning"),
                unsupported.joined(separator: ", ")))
        }

        guard !details.isEmpty else { return nil }
        details.append(NSLocalizedString(
            "Remove omitted items and share again.",
            comment: "Share extension omitted attachment recovery"))
        return details.joined(separator: " ")
    }
}

enum ShareAttachmentBlockReason: Equatable {
    case imageProcessingFailed
    case omitted(String)

    static func resolve(
        hasImageProcessingError: Bool,
        summary: ShareAttachmentSummary) -> Self?
    {
        if hasImageProcessingError {
            return .imageProcessingFailed
        }
        if let omissionMessage = summary.omissionMessage {
            return .omitted(omissionMessage)
        }
        return nil
    }
}
