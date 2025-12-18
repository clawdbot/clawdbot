import AppKit
import SwiftUI

@MainActor
struct AnthropicAuthControls: View {
    let connectionMode: AppState.ConnectionMode

    @State private var oauthStatus: PiOAuthStore.AnthropicOAuthStatus = PiOAuthStore.anthropicOAuthStatus()
    @State private var pkce: AnthropicOAuth.PKCE?
    @State private var code: String = ""
    @State private var busy = false
    @State private var statusText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if self.connectionMode == .remote {
                Text("Gateway runs remotely; OAuth must be created on the gateway host where Pi runs.")
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
                    NSWorkspace.shared.activateFileViewerSelecting([PiOAuthStore.oauthURL()])
                }
                .buttonStyle(.bordered)
                .disabled(!FileManager.default.fileExists(atPath: PiOAuthStore.oauthURL().path))

                Button("Refresh") {
                    self.refresh()
                }
                .buttonStyle(.bordered)
            }

            Text(PiOAuthStore.oauthURL().path)
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
                .disabled(self.connectionMode == .remote || self.busy)

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

                    Button("Connect") {
                        Task { await self.finishOAuth() }
                    }
                    .buttonStyle(.bordered)
                    .disabled(self.busy || self.connectionMode == .remote || self.code
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
    }

    private func refresh() {
        self.oauthStatus = PiOAuthStore.anthropicOAuthStatus()
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

        let trimmed = self.code.trimmingCharacters(in: .whitespacesAndNewlines)
        let splits = trimmed.split(separator: "#", maxSplits: 1).map(String.init)
        let code = splits.first ?? ""
        let state = splits.count > 1 ? splits[1] : ""

        do {
            let creds = try await AnthropicOAuth.exchangeCode(code: code, state: state, verifier: pkce.verifier)
            try PiOAuthStore.saveAnthropicOAuth(creds)
            self.refresh()
            self.pkce = nil
            self.code = ""
            self.statusText = "Connected. Pi can now use Claude via OAuth."
        } catch {
            self.statusText = "OAuth failed: \(error.localizedDescription)"
        }
    }
}
