import SwiftUI

struct ChatFullMessageReaderRequest: Identifiable, Sendable {
    let sessionKey: String
    let messageID: String

    var id: String {
        "\(self.sessionKey)\u{0}\(self.messageID)"
    }
}

@MainActor
struct ChatFullMessageReader: View {
    private enum Phase {
        case loading
        case loaded(String)
        case failed(String)
    }

    let request: ChatFullMessageReaderRequest
    let markdownVariant: ChatMarkdownVariant
    let load: @MainActor @Sendable () async throws -> OpenClawChatMessage?

    @Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .loading

    var body: some View {
        NavigationStack {
            Group {
                switch self.phase {
                case .loading:
                    VStack(spacing: 10) {
                        ProgressView()
                        Text("Loading full message…")
                            .font(OpenClawChatTypography.body)
                            .foregroundStyle(.secondary)
                    }
                case let .loaded(markdown):
                    ScrollView {
                        ChatMarkdownRenderer(
                            text: markdown,
                            context: .assistant,
                            variant: self.markdownVariant,
                            font: OpenClawChatTypography.body,
                            textColor: OpenClawChatTheme.assistantText)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(20)
                    }
                case let .failed(message):
                    ContentUnavailableView(
                        String(localized: "Full message unavailable"),
                        systemImage: "doc.text.magnifyingglass",
                        description: Text(message))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Full Message")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Close") { self.dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 420)
        #endif
        .task(id: self.request.id) {
            await self.loadMessage()
        }
    }

    private func loadMessage() async {
        self.phase = .loading
        do {
            guard let message = try await self.load() else {
                self.phase = .failed(String(localized: "The full message is no longer available."))
                return
            }
            let markdown = ChatMessageVisibleText.visibleText(in: message)
            guard !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                self.phase = .failed(String(localized: "The full message has no readable text."))
                return
            }
            self.phase = .loaded(markdown)
        } catch is CancellationError {
            return
        } catch {
            self.phase = .failed(String(localized: "The full message could not be loaded."))
        }
    }
}
