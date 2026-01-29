import SwiftUI
import Textual

public enum ChatMarkdownVariant: String, CaseIterable, Sendable {
    case standard
    case compact
}

// MARK: - Textual Bundle Availability

/// Checks if the Textual syntax highlighting bundle is available.
/// This must be called BEFORE any Textual types are accessed to avoid a crash
/// from SPM's generated Bundle.module accessor when the bundle is missing.
private let textualBundleAvailable: Bool = {
    let bundleNames = ["textual_Textual", "Textual_Textual"]
    guard let resourceURL = Bundle.main.resourceURL else { return false }
    for name in bundleNames {
        let bundleURL = resourceURL.appendingPathComponent("\(name).bundle")
        if FileManager.default.fileExists(atPath: bundleURL.path) {
            return true
        }
    }
    return false
}()

@MainActor
struct ChatMarkdownRenderer: View {
    enum Context {
        case user
        case assistant
    }

    let text: String
    let context: Context
    let variant: ChatMarkdownVariant
    let font: Font
    let textColor: Color

    var body: some View {
        let processed = ChatMarkdownPreprocessor.preprocess(markdown: self.text)
        VStack(alignment: .leading, spacing: 10) {
            if textualBundleAvailable {
                StructuredText(markdown: processed.cleaned)
                    .modifier(ChatMarkdownStyle(
                        variant: self.variant,
                        context: self.context,
                        font: self.font,
                        textColor: self.textColor))
            } else {
                // Fallback when Textual's resource bundle is missing (avoids crash).
                FallbackMarkdownText(
                    text: processed.cleaned,
                    font: self.font,
                    textColor: self.textColor)
            }

            if !processed.images.isEmpty {
                InlineImageList(images: processed.images)
            }
        }
    }
}

private struct ChatMarkdownStyle: ViewModifier {
    let variant: ChatMarkdownVariant
    let context: ChatMarkdownRenderer.Context
    let font: Font
    let textColor: Color

    func body(content: Content) -> some View {
        Group {
            if self.variant == .compact {
                content.textual.structuredTextStyle(.default)
            } else {
                content.textual.structuredTextStyle(.gitHub)
            }
        }
        .font(self.font)
        .foregroundStyle(self.textColor)
        .textual.inlineStyle(self.inlineStyle)
        .textual.textSelection(.enabled)
    }

    private var inlineStyle: InlineStyle {
        let linkColor: Color = self.context == .user ? self.textColor : .accentColor
        let codeScale: CGFloat = self.variant == .compact ? 0.85 : 0.9
        return InlineStyle()
            .code(.monospaced, .fontScale(codeScale))
            .link(.foregroundColor(linkColor))
    }
}

@MainActor
private struct InlineImageList: View {
    let images: [ChatMarkdownPreprocessor.InlineImage]

    var body: some View {
        ForEach(images, id: \.id) { item in
            if let img = item.image {
                MoltbotPlatformImageFactory.image(img)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
            } else {
                Text(item.label.isEmpty ? "Image" : item.label)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Fallback Markdown Rendering

/// Fallback markdown renderer using SwiftUI's native AttributedString.
/// Used when Textual's resource bundle is missing to avoid crashes.
@MainActor
private struct FallbackMarkdownText: View {
    let text: String
    let font: Font
    let textColor: Color

    var body: some View {
        if let attributed = try? AttributedString(markdown: self.text, options: Self.markdownOptions) {
            Text(attributed)
                .font(self.font)
                .foregroundStyle(self.textColor)
                .textSelection(.enabled)
        } else {
            Text(self.text)
                .font(self.font)
                .foregroundStyle(self.textColor)
                .textSelection(.enabled)
        }
    }

    private static let markdownOptions = AttributedString.MarkdownParsingOptions(
        allowsExtendedAttributes: true,
        interpretedSyntax: .inlineOnlyPreservingWhitespace,
        failurePolicy: .returnPartiallyParsedIfPossible)
}
