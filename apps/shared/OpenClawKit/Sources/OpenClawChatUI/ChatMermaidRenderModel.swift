import Foundation

struct ChatMermaidTheme: Hashable, Sendable {
    let background: String
    let foreground: String
    let muted: String
    let border: String
    let accent: String
    let fontFamily: String
    let darkMode: Bool

    var arguments: [String: Any] {
        [
            "background": self.background,
            "foreground": self.foreground,
            "muted": self.muted,
            "border": self.border,
            "accent": self.accent,
            "fontFamily": self.fontFamily,
            "darkMode": self.darkMode,
        ]
    }
}

struct ChatMermaidRequest: Hashable, Sendable {
    let source: String
    let width: Int
    let displayScale: Double
    let theme: ChatMermaidTheme

    var isValid: Bool {
        // These are the shared renderer's admission limits, checked before
        // retaining source or starting a WebKit process.
        !self.source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            self.source.utf16.count <= 20000 &&
            self.width > 0 && self.width <= 8192 &&
            self.displayScale.isFinite && self.displayScale > 0 &&
            Double(self.width) * self.displayScale <= 8192
    }

    func arguments(id: UUID) -> [String: Any] {
        [
            "id": id.uuidString,
            "source": self.source,
            "widthCssPx": self.width,
            "theme": self.theme.arguments,
        ]
    }
}

enum ChatMermaidFailure: Error, Equatable {
    case invalidRequest
    case busy
    case unavailable
    case timedOut
    case invalidResult
    case tooLarge
    case rendering(String, retryable: Bool)
}

struct ChatMermaidResponse {
    let svg: String
    let size: CGSize

    init?(body: String, expectedID: UUID, request: ChatMermaidRequest) throws {
        // Bound the bridge envelope before decoding; the SVG itself remains
        // owned by the shared renderer. JSON can escape one unit as six characters.
        guard body.utf16.count <= 6_000_000 + 4096 else { throw ChatMermaidFailure.invalidResult }
        let message = try JSONDecoder().decode(Message.self, from: Data(body.utf8))
        guard message.id == expectedID.uuidString else { return nil }
        guard message.success else {
            guard let error = message.error, let retryable = message.retryable else {
                throw ChatMermaidFailure.invalidResult
            }
            throw ChatMermaidFailure.rendering(String(error.prefix(1000)), retryable: retryable)
        }
        guard let svg = message.svg, !svg.isEmpty, svg.utf16.count <= 1_000_000,
              let width = message.widthCssPx, let height = message.heightCssPx,
              width == Double(request.width), width.isFinite, height.isFinite,
              width > 0, height > 0, width <= 8192, height <= 8192,
              width.rounded(.up) == width, height.rounded(.up) == height
        else { throw ChatMermaidFailure.invalidResult }
        let size = CGSize(width: width, height: height)
        guard Self.isSafeBitmap(size: size, scale: request.displayScale) else {
            throw ChatMermaidFailure.tooLarge
        }
        self.svg = svg
        self.size = size
    }

    static func isSafeBitmap(size: CGSize, scale: Double) -> Bool {
        guard size.width.isFinite, size.height.isFinite, scale.isFinite,
              size.width > 0, size.height > 0, scale > 0
        else { return false }
        let width = (size.width * scale).rounded(.up)
        let height = (size.height * scale).rounded(.up)
        return width.isFinite && height.isFinite && width <= 8192 && height <= 8192 &&
            width * height <= 4 * 1024 * 1024
    }

    private struct Message: Decodable {
        let id: String
        let success: Bool
        let svg: String?
        let widthCssPx: Double?
        let heightCssPx: Double?
        let error: String?
        let retryable: Bool?
    }
}
