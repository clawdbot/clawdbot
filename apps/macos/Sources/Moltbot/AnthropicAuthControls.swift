import AppKit
import Combine
import SwiftUI

@MainActor
struct AnthropicAuthControls: View {
    let connectionMode: AppState.ConnectionMode

    @State private var oauthStatus: MoltbotOAuthStore.AnthropicOAuthStatus = MoltbotOAuthStore.anthropicOAuthStatus()
    @State private var pkce: AnthropicOAuth.PKCE?
    @State private var code: String = ""
    @State private var busy = false
    @State private var statusText: String?
    @State private var autoDetectClipboard = true
    @State private var autoConnectClipboard = true
    @State private var lastPasteboardChangeCount = NSPasteboard.general.changeCount

    private static let clipboardPoll: AnyPublisher<Date, Never> = {
        if ProcessInfo.processInfo.isRunningTests {
            return Empty(completeImmediately: false).eraseToAnyPublisher()
        }
        return Timer.publish(every: 0.4, on: .main, in: .common)
            .autoconnect()
            .eraseToAnyPublisher()
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if self.connectionMode != .local {
                Text("Gateway isn’t running locally; OAuth must be created on the gateway host.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 10) {
                Circle()
                    .fill(self.oauthStatus.isConnected ? Color.green : Color.orange)
                    .frame(width: 8, height: 8)
                Text(self.oauthStatus.shortDescription)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Reveal") {
                    NSWorkspace.shared.activateFileViewerSelecting([MoltbotOAuthStore.oauthURL()])
                }
                .buttonStyle(.bordered)
                .disabled(!FileManager().fileExists(atPath: MoltbotOAuthStore.oauthURL().path))

                Button("Refresh") {
                    self.refresh()
                }
                .buttonStyle(.bordered)
            }

            Text(MoltbotOAuthStore.oauthURL().path)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)

            HStack(spacing: 12) {
                Button {
                    self.startOAuth()
                } label: {
                    if self.busy {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(self.oauthStatus.isConnected ? "Re-auth (OAuth)" : "Open sign-in (OAuth)")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.connectionMode != .local || self.busy)

                if self.pkce != nil {
                    Button("Cancel") {
                        self.pkce = nil
                        self.code = ""
                        self.statusText = nil
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.busy)
                }
            }

            if self.pkce != nil {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Paste `code#state`")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)

                    TextField("code#state", text: self.$code)
                        .textFieldStyle(.roundedBorder)
                        .disabled(self.busy)

                    Toggle("Auto-detect from clipboard", isOn: self.$autoDetectClipboard)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .disabled(self.busy)

                    Toggle("Auto-connect when detected", isOn: self.$autoConnectClipboard)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .disabled(self.busy)

                    Button("Connect") {
                        Task { await self.finishOAuth() }
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.busy || self.connectionMode != .local || self.code
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                        .isEmpty)
                }
            }

            if let statusText, !statusText.isEmpty {
                Text(statusText)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear {
            self.refresh()
        }
        .onReceive(Self.clipboardPoll) { _ in
            self.pollClipboardIfNeeded()
        }
    }

    private func refresh() {
        let imported = MoltbotOAuthStore.importLegacyAnthropicOAuthIfNeeded()
        self.oauthStatus = MoltbotOAuthStore.anthropicOAuthStatus()
        if imported != nil {
            self.statusText = "Imported existing OAuth credentials."
        }
    }

    private func startOAuth() {
        guard self.connectionMode == .local else { return }
        guard !self.busy else { return }
        self.busy = true
        defer { self.busy = false }

        do {
            let pkce = try AnthropicOAuth.generatePKCE()
            self.pkce = pkce
            let url = AnthropicOAuth.buildAuthorizeURL(pkce: pkce)
            NSWorkspace.shared.open(url)
            self.statusText = "Browser opened. After approving, paste the `code#state` value here."
        } catch {
            self.statusText = "Failed to start OAuth: \(error.localizedDescription)"
        }
    }

    @MainActor
    private func finishOAuth() async {
        guard self.connectionMode == .local else { return }
        guard !self.busy else { return }
        guard let pkce = self.pkce else { return }
        self.busy = true
        defer { self.busy = false }

        guard let parsed = AnthropicOAuthCodeState.parse(from: self.code) else {
            self.statusText = "OAuth failed: missing or invalid code/state."
            return
        }

        do {
            let creds = try await AnthropicOAuth.exchangeCode(
                code: parsed.code,
                state: parsed.state,
                verifier: pkce.verifier)
            try MoltbotOAuthStore.saveAnthropicOAuth(creds)
            self.refresh()
            self.pkce = nil
            self.code = ""
            self.statusText = "Connected. Moltbot can now use Claude via OAuth."
        } catch {
            self.statusText = "OAuth failed: \(error.localizedDescription)"
        }
    }

    private func pollClipboardIfNeeded() {
        guard self.connectionMode == .local else { return }
        guard self.pkce != nil else { return }
        guard !self.busy else { return }
        guard self.autoDetectClipboard else { return }

        let pb = NSPasteboard.general
        let changeCount = pb.changeCount
        guard changeCount != self.lastPasteboardChangeCount else { return }
        self.lastPasteboardChangeCount = changeCount

        guard let raw = pb.string(forType: .string), !raw.isEmpty else { return }
        guard let parsed = AnthropicOAuthCodeState.parse(from: raw) else { return }
        guard let pkce = self.pkce, parsed.state == pkce.verifier else { return }

        let next = "\(parsed.code)#\(parsed.state)"
        if self.code != next {
            self.code = next
            self.statusText = "Detected `code#state` from clipboard."
        }

        guard self.autoConnectClipboard else { return }
        Task { await self.finishOAuth() }
    }
}

#if DEBUG
extension AnthropicAuthControls {
    init(
        connectionMode: AppState.ConnectionMode,
        oauthStatus: MoltbotOAuthStore.AnthropicOAuthStatus,
        pkce: AnthropicOAuth.PKCE? = nil,
        code: String = "",
        busy: Bool = false,
        statusText: String? = nil,
        autoDetectClipboard: Bool = true,
        autoConnectClipboard: Bool = true)
    {
        self.connectionMode = connectionMode
        self._oauthStatus = State(initialValue: oauthStatus)
        self._pkce = State(initialValue: pkce)
        self._code = State(initialValue: code)
        self._busy = State(initialValue: busy)
        self._statusText = State(initialValue: statusText)
        self._autoDetectClipboard = State(initialValue: autoDetectClipboard)
        self._autoConnectClipboard = State(initialValue: autoConnectClipboard)
        self._lastPasteboardChangeCount = State(initialValue: NSPasteboard.general.changeCount)
    }
}
#endif
