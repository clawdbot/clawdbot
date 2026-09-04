#if canImport(WebKit) && (os(iOS) || os(macOS))
import SwiftUI
import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
struct ChatMermaidBlockView: View {
    let source: String

    @Environment(\.self) private var environment
    @Environment(\.displayScale) private var displayScale
    @Environment(\.colorScheme) private var colorScheme
    @State private var width = 0
    @State private var result: Result<ChatMermaidRenderedImage, ChatMermaidFailure>?
    @State private var token: UUID?
    @State private var generation = UUID()
    @State private var showSource = false
    @State private var isHovered = false
    /// Keep the selected preview stable while rotation re-renders the inline diagram.
    @State private var expanded: PreviewSelection?

    private struct PreviewSelection: Identifiable {
        let id = UUID()
        let svg: String
        let background: String
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Spacer()
                ChatCopyButton(text: self.source, label: "Copy diagram source", revealed: self.isHovered)
                Menu {
                    #if os(macOS)
                    Button {
                        ChatPasteboard.copy(self.source)
                    } label: {
                        Text("Copy diagram source").font(OpenClawChatTypography.body)
                    }
                    #endif
                    Button {
                        self.showSource.toggle()
                    } label: {
                        if self.showSource {
                            Text("View diagram").font(OpenClawChatTypography.body)
                        } else {
                            Text("View source").font(OpenClawChatTypography.body)
                        }
                    }
                    Button {
                        self.expand()
                    } label: {
                        Text("Expand diagram").font(OpenClawChatTypography.body)
                    }
                    .disabled(self.rendered == nil)
                    if self.canRetry {
                        Button {
                            self.render()
                        } label: {
                            Text("Retry diagram").font(OpenClawChatTypography.body)
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: ChatCopyButton.controlSize, height: ChatCopyButton.controlSize)
                }
                .accessibilityLabel("Diagram options")
                #if os(macOS)
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("Diagram options")
                #endif
            }
            .foregroundStyle(.secondary)
            if self.showSource {
                self.sourceView
            } else if let rendered = self.rendered {
                Button {
                    self.expand()
                } label: {
                    OpenClawPlatformImageFactory.image(rendered.image)
                        .resizable()
                        .aspectRatio(rendered.size.width / rendered.size.height, contentMode: .fit)
                        .frame(maxWidth: .infinity)
                        .padding(8)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Mermaid diagram")
                .accessibilityHint("Expand diagram")
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    self.status
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                    self.sourceView
                }
                .padding(10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(OpenClawChatTheme.assistantBubble)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.secondary.opacity(0.2)))
        .onGeometryChange(for: Int.self) { geometry in
            Int(geometry.size.width.rounded(.up))
        } action: { self.width = $0 }
        .onChange(of: self.request, initial: true) { _, _ in self.render() }
        .onDisappear { self.cancel() }
        .onHover { self.isHovered = $0 }
        #if os(macOS)
        .sheet(item: self.$expanded) { self.preview($0) }
        #else
        .fullScreenCover(item: self.$expanded) { self.preview($0) }
        #endif
    }

    private func preview(_ selected: PreviewSelection) -> some View {
        ChatMermaidPreviewView(svg: selected.svg, background: selected.background)
    }

    private func expand() {
        guard let rendered = self.rendered else { return }
        self.expanded = PreviewSelection(
            svg: rendered.svg,
            background: self.cssColor(OpenClawChatTheme.assistantBubble))
    }

    private var sourceView: some View {
        ChatCodeBlockView(block: ChatCodeBlock(language: nil, code: self.source, isComplete: true))
    }

    private var rendered: ChatMermaidRenderedImage? {
        guard case let .success(image)? = self.result else { return nil }
        return image
    }

    private var canRetry: Bool {
        guard case let .failure(error)? = self.result else { return false }
        switch error {
        case .busy, .unavailable, .timedOut, .invalidResult: return true
        case let .rendering(_, retryable): return retryable
        case .invalidRequest, .tooLarge: return false
        }
    }

    @ViewBuilder
    private var status: some View {
        if self.result == nil {
            Text("Rendering diagram…")
        } else if self.canRetry {
            Text(
                "Diagram temporarily unavailable. Use the menu to retry, or read and copy its source.")
        } else {
            Text(
                "Diagram unavailable. Check the syntax or simplify the diagram. You can still read or copy its source.")
        }
    }

    private var request: ChatMermaidRequest? {
        guard self.width > 0 else { return nil }
        return ChatMermaidRequest(
            source: self.source,
            width: self.width,
            displayScale: self.displayScale,
            theme: ChatMermaidTheme(
                background: self.cssColor(OpenClawChatTheme.assistantBubble),
                foreground: self.cssColor(OpenClawChatTheme.assistantText),
                muted: self.cssColor(.secondary),
                border: self.cssColor(OpenClawChatTheme.divider),
                accent: self.cssColor(OpenClawChatTheme.accent),
                fontFamily: "sans-serif",
                darkMode: self.colorScheme == .dark))
    }

    private func cssColor(_ color: Color) -> String {
        let resolved = color.resolve(in: self.environment)
        return String(
            format: "#%02x%02x%02x",
            Int(resolved.red * 255),
            Int(resolved.green * 255),
            Int(resolved.blue * 255))
    }

    private func render() {
        self.cancel()
        self.result = nil
        guard let request = self.request else { return }
        let generation = self.generation
        self.token = ChatMermaidRenderer.shared.render(request) { result in
            guard self.generation == generation else { return }
            self.result = result
        }
    }

    private func cancel() {
        self.generation = UUID()
        if let token = self.token {
            self.token = nil
            ChatMermaidRenderer.shared.cancel(token)
        }
    }
}

@MainActor
private struct ChatMermaidPreviewView: View {
    let svg: String
    let background: String
    @Environment(\.dismiss) private var dismiss
    @State private var failed = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button {
                    self.dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close diagram preview")
                #if os(macOS)
                .keyboardShortcut(.cancelAction)
                #endif
            }
            if self.failed {
                Text("Diagram preview unavailable")
                    .font(OpenClawChatTypography.body)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ChatMermaidSvgView(svg: self.svg, background: self.background, onFailure: { self.failed = true })
            }
        }
        .background(OpenClawChatTheme.assistantBubble)
        #if os(macOS)
        .frame(minWidth: 500, idealWidth: 900, minHeight: 350, idealHeight: 600)
        // Mac sheets default to a form width; fit both axes so Expand honors the ideal size.
        .presentationSizing(.fitted)
        #endif
    }
}

@MainActor
private struct ChatMermaidSvgView {
    let svg: String
    let background: String
    let onFailure: @MainActor () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onFailure: self.onFailure)
    }

    func makeWebView(coordinator: Coordinator) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = coordinator
        view.allowsLinkPreview = false
        view.underPageBackgroundColor = .clear
        #if os(macOS)
        view.allowsMagnification = true
        #else
        view.isOpaque = false
        view.backgroundColor = .clear
        #endif
        let encoded = Data(self.svg.utf8).base64EncodedString()
        // Sanitized SVG stays an image document. The preview needs no scripts or network.
        view.loadHTMLString("""
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none';
        img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=8, user-scalable=yes">
        <style>
        html,body{margin:0;height:100%;background:\(self.background)}
        body{display:flex;align-items:center}
        img{display:block;width:100%;height:auto}
        </style>
        </head><body><img alt="" src="data:image/svg+xml;base64,\(encoded)"></body></html>
        """, baseURL: nil)
        return view
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        private let onFailure: @MainActor () -> Void
        init(onFailure: @escaping @MainActor () -> Void) {
            self.onFailure = onFailure
        }

        func webViewWebContentProcessDidTerminate(_: WKWebView) {
            self.onFailure()
        }

        func webView(_: WKWebView, didFail _: WKNavigation!, withError _: any Error) {
            self.onFailure()
        }

        func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError _: any Error) {
            self.onFailure()
        }
    }
}

#if os(macOS)
extension ChatMermaidSvgView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView {
        self.makeWebView(coordinator: context.coordinator)
    }

    func updateNSView(_: WKWebView, context: Context) {}
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.navigationDelegate = nil
        view.stopLoading()
    }
}
#else
extension ChatMermaidSvgView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        self.makeWebView(coordinator: context.coordinator)
    }

    func updateUIView(_: WKWebView, context: Context) {}
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.navigationDelegate = nil
        view.stopLoading()
    }
}
#endif
#endif
