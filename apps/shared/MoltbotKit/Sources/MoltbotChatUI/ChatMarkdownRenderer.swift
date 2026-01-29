import SwiftUI
import Textual

public enum ChatMarkdownVariant: String, CaseIterable, Sendable {
    case standard
    case compact
}

/// Check if the Textual package's resource bundle is available.
/// When running from a packaged app, the bundle may not be in the expected location,
/// causing a fatal error when StructuredText tries to access Bundle.module.
private let textualBundleAvailable: Bool = {
    // The Textual package looks for its bundle at specific paths.
    // Check if we can find it before attempting to use StructuredText.
    let bundleName = "textual_Textual.bundle"

    // Check in main bundle (packaged app)
    if Bundle.main.path(forResource: "textual_Textual", ofType: "bundle") != nil {
        return true
    }

    // Check in app's PlugIns or Frameworks directories
    if let pluginsURL = Bundle.main.builtInPlugInsURL,
       FileManager.default.fileExists(atPath: pluginsURL.appendingPathComponent(bundleName).path)
    {
        return true
    }

    if let frameworksURL = Bundle.main.privateFrameworksURL,
       FileManager.default.fileExists(atPath: frameworksURL.appendingPathComponent(bundleName).path)
    {
        return true
    }

    // In development (SwiftPM), Bundle.module should work
    // We can't directly test Bundle.module without triggering the crash,
    // so we check for a known development path pattern
    #if DEBUG
    return true
    #else
    // In release builds, if we haven't found the bundle, assume it's not available
    return false
    #endif
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
                // Fallback: render as plain text when Textual bundle is unavailable
                Text(processed.cleaned)
                    .font(self.font)
                    .foregroundStyle(self.textColor)
                    .textSelection(.enabled)
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
