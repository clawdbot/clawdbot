import AppKit
import OpenClawChatUI
import OpenClawKit
import SwiftUI

struct AboutSettings: View {
    weak var updater: UpdaterProviding?
    @Environment(\.colorScheme) private var colorScheme
    @State private var iconHover = false
    @AppStorage("autoUpdateEnabled") private var autoCheckEnabled = true
    @State private var didLoadUpdaterState = false

    var body: some View {
        VStack(spacing: 8) {
            // Hero treatment from openclaw.ai: coral silhouette glow at 10% of
            // size, teal glow at 15% plus scale 1.1 on hover. Clicks go to the
            // mascot's Easter eggs; the GitHub link lives in the row set below.
            OpenClawMascotView(interactive: true)
                .frame(width: 160, height: 160)
                .shadow(
                    color: OpenClawMascotView.heroGlowColor(
                        for: self.colorScheme,
                        hovering: self.iconHover),
                    radius: self.iconHover ? 24 : 16)
                .scaleEffect(self.iconHover ? 1.1 : 1.0)
                .pointingHandCursor()
                .onHover { hover in
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.72)) { self.iconHover = hover }
                }

            VStack(spacing: 3) {
                Text("OpenClaw")
                    .font(.title3.bold())
                AboutBuildMetadataStrip(metadata: self.buildMetadata)
                    .padding(.top, 3)
                Text("Menu bar companion for notifications, screenshots, and privileged agent actions.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 18)
            }

            // Unified first-party link set shared with the iOS and Android About screens.
            VStack(alignment: .center, spacing: 6) {
                AboutLinkRow(icon: "globe", title: "Website", url: "https://openclaw.ai")
                AboutLinkRow(icon: "book", title: "Docs", url: "https://docs.openclaw.ai")
                AboutLinkRow(
                    icon: "chevron.left.slash.chevron.right",
                    title: "GitHub",
                    url: "https://github.com/openclaw/openclaw")
                AboutLinkRow(
                    icon: "bubble.left.and.bubble.right",
                    title: "Discord",
                    url: "https://discord.gg/clawd")
            }
            .frame(maxWidth: .infinity)
            .multilineTextAlignment(.center)
            .padding(.vertical, 10)

            if let updater {
                Divider()
                    .padding(.vertical, 8)

                if updater.isAvailable {
                    VStack(spacing: 10) {
                        Toggle("Check for updates automatically", isOn: self.$autoCheckEnabled)
                            .toggleStyle(.checkbox)
                            .frame(maxWidth: .infinity, alignment: .center)

                        Button("Check for Updates…") { updater.checkForUpdates(nil) }
                    }
                } else {
                    Text("Updates unavailable in this build.")
                        .foregroundStyle(.secondary)
                        .padding(.top, 4)
                }
            }

            Text("© 2026 OpenClaw Foundation — MIT License.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.top, 4)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .settingsDetailContent()
        .onAppear {
            guard let updater, !self.didLoadUpdaterState else { return }
            // Keep Sparkle’s auto-check setting in sync with the persisted toggle.
            updater.automaticallyChecksForUpdates = self.autoCheckEnabled
            updater.automaticallyDownloadsUpdates = self.autoCheckEnabled
            self.didLoadUpdaterState = true
        }
        .onChange(of: self.autoCheckEnabled) { _, newValue in
            self.updater?.automaticallyChecksForUpdates = newValue
            self.updater?.automaticallyDownloadsUpdates = newValue
        }
    }

    private var buildMetadata: ArtifactBuildInfo {
        ArtifactBuildInfo(infoDictionary: Bundle.main.infoDictionary ?? [:])
    }
}

private struct AboutBuildMetadataStrip: View {
    let metadata: ArtifactBuildInfo
    @Environment(\.layoutDirection) private var layoutDirection

    private struct Field: Identifiable {
        enum ID: String {
            case version
            case commit
            case built
        }

        let id: ID
        let title: LocalizedStringKey
        let value: String?
        let forceLeftToRight: Bool
    }

    private var fields: [Field] {
        [
            Field(id: .version, title: "Version", value: self.metadata.versionDisplay, forceLeftToRight: true),
            Field(id: .commit, title: "Commit", value: self.metadata.shortCommit, forceLeftToRight: true),
            Field(id: .built, title: "Built", value: self.metadata.localizedBuildDate(), forceLeftToRight: false),
        ]
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 12) {
                ForEach(Array(self.fields.enumerated()), id: \.element.id) { index, field in
                    if index > 0 {
                        Divider()
                            .frame(height: 28)
                    }
                    self.metadataField(field)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .fixedSize(horizontal: true, vertical: false)

            VStack(alignment: .center, spacing: 7) {
                ForEach(self.fields) { field in
                    self.metadataField(field)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(self.metadataAccessibilityLabel)
        .accessibilityActions {
            if self.metadata.gitCommit != nil {
                Button("Copy full commit hash") {
                    self.copyCommit()
                }
            }
            Button("Copy build info") {
                self.copyBuildInfo()
            }
        }
        .contextMenu {
            if self.metadata.gitCommit != nil {
                Button("Copy Commit") {
                    self.copyCommit()
                }
            }
            Button("Copy Build Info") {
                self.copyBuildInfo()
            }
        }
        .help(self.metadata.copyText)
    }

    private func metadataField(_ field: Field) -> some View {
        VStack(alignment: .center, spacing: 1) {
            Text(field.title)
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
            Group {
                if let value = field.value {
                    Text(verbatim: value)
                } else {
                    Text("Unavailable")
                }
            }
            .font(.caption.monospaced())
            .environment(
                \.layoutDirection,
                field.forceLeftToRight ? .leftToRight : self.layoutDirection)
        }
    }

    private var metadataAccessibilityLabel: Text {
        let version = self.metadata.versionDisplay
        let commit = self.metadata.spokenCommit
        let timestamp = self.metadata.buildTimestamp
        let built = self.metadata.localizedBuildDate() ?? timestamp
        if let commit, let timestamp, let built {
            return Text("Version \(version), commit \(commit), built \(built), timestamp \(timestamp)")
        }
        if let commit {
            return Text("Version \(version), commit \(commit), build date unavailable")
        }
        if let timestamp, let built {
            return Text("Version \(version), commit unavailable, built \(built), timestamp \(timestamp)")
        }
        return Text("Version \(version), commit unavailable, build date unavailable")
    }

    private func copyCommit() {
        guard let gitCommit = self.metadata.gitCommit else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(gitCommit, forType: .string)
    }

    private func copyBuildInfo() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(self.metadata.copyText, forType: .string)
    }
}

@MainActor
private struct AboutLinkRow: View {
    let icon: String
    let title: String
    let url: String

    @State private var hovering = false

    var body: some View {
        Button {
            if let url = URL(string: url) {
                NSWorkspace.shared.open(url)
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: self.icon)
                Text(self.title)
                    .underline(self.hovering, color: .accentColor)
            }
            .foregroundColor(.accentColor)
        }
        .buttonStyle(.plain)
        .onHover { self.hovering = $0 }
        .pointingHandCursor()
    }
}

#if DEBUG
struct AboutSettings_Previews: PreviewProvider {
    private static let updater = DisabledUpdaterController()
    static var previews: some View {
        AboutSettings(updater: updater)
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
