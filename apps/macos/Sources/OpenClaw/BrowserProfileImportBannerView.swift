import AppKit
import SwiftUI

/// Presentation for one banner phase, derived separately from the view so the
/// copy and available actions stay unit-testable.
struct BrowserProfileImportBannerContent: Equatable {
    enum Badge: Equatable {
        case globe
        case progress
        case success
        case failure
    }

    enum Action: Equatable {
        case importProfiles([BrowserSystemProfile])
        case retry
        case none
    }

    let title: String
    let subtitle: String
    let badge: Badge
    let action: Action

    static func content(for phase: BrowserProfileImportModel.Phase) -> BrowserProfileImportBannerContent? {
        switch phase {
        case .hidden:
            return nil
        case let .offering(status):
            let profiles = status.importableProfiles
            let browsers = Self.browserList(for: profiles)
            return BrowserProfileImportBannerContent(
                title: String(localized: "Use your browser logins"),
                subtitle: String(localized: """
                Copy cookies from \(browsers) into an isolated agent profile. \
                Passwords are never touched.
                """),
                badge: .globe,
                action: .importProfiles(profiles))
        case let .importing(profile, target):
            return BrowserProfileImportBannerContent(
                title: String(localized: "Importing browser cookies…"),
                subtitle: String(localized: """
                Copying \(profile.displayName) into “\(target)”. Touch ID may be required.
                """),
                badge: .progress,
                action: .none)
        case let .imported(result):
            return BrowserProfileImportBannerContent(
                title: String(localized: "Browser logins imported"),
                subtitle: String(localized: """
                \(result.cookies.imported) of \(result.cookies.total) cookies copied into \
                “\(result.into)” — now the default profile for agent browsing.
                """),
                badge: .success,
                action: .none)
        case let .failed(message, _):
            return BrowserProfileImportBannerContent(
                title: String(localized: "Browser import failed"),
                subtitle: message,
                badge: .failure,
                action: .retry)
        }
    }

    static func browserList(for profiles: [BrowserSystemProfile]) -> String {
        var names: [String] = []
        for profile in profiles {
            let name = profile.browserDisplayName
            if !names.contains(name) {
                names.append(name)
            }
        }
        switch names.count {
        case 0:
            return String(localized: "your browser")
        case 1:
            return names[0]
        default:
            return ListFormatter.localizedString(byJoining: names)
        }
    }
}

/// Floating, dismissible import offer shown over the dashboard — the inline
/// replacement for the old modal browser-login alert.
struct BrowserProfileImportBannerView: View {
    let model: BrowserProfileImportModel

    var body: some View {
        if let content = BrowserProfileImportBannerContent.content(for: self.model.phase) {
            self.card(content)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    private func card(_ content: BrowserProfileImportBannerContent) -> some View {
        HStack(alignment: .center, spacing: 12) {
            BannerBadgeIcon(badge: content.badge)
            VStack(alignment: .leading, spacing: 2) {
                Text(content.title)
                    .font(.system(size: 13, weight: .semibold))
                Text(content.subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            self.trailingControls(for: content)
            self.dismissButton(for: content)
        }
        .padding(.vertical, 10)
        .padding(.leading, 12)
        .padding(.trailing, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1))
        .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(content.title). \(content.subtitle)")
    }

    @ViewBuilder
    private func trailingControls(for content: BrowserProfileImportBannerContent) -> some View {
        switch content.action {
        case let .importProfiles(profiles):
            if profiles.count == 1, let profile = profiles.first {
                Button("Import") {
                    Task { await self.model.importProfile(profile) }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            } else {
                Menu("Import") {
                    ForEach(profiles, id: \.menuID) { profile in
                        Button(profile.displayName) {
                            Task { await self.model.importProfile(profile) }
                        }
                    }
                }
                .menuStyle(.button)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .fixedSize()
            }
        case .retry:
            Button("Retry") {
                self.model.retry()
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        case .none:
            if content.badge == .progress {
                ProgressView()
                    .controlSize(.small)
            }
        }
    }

    private func dismissButton(for content: BrowserProfileImportBannerContent) -> some View {
        Button {
            self.model.dismiss()
        } label: {
            Image(systemName: "xmark")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 20, height: 20)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(content.badge == .progress)
        .opacity(content.badge == .progress ? 0.4 : 1)
        .help("Dismiss")
        .accessibilityLabel("Dismiss")
    }
}

extension BrowserProfileImportBannerView {
    /// Wraps the dashboard web view in a pane that floats the shared import
    /// banner on top; the banner renders empty (zero height) until the model
    /// has an offer or outcome to show.
    @MainActor
    static func makeDashboardPane(webView: NSView) -> NSView {
        let container = NSView()
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        let banner = NSHostingView(rootView: BrowserProfileImportBannerView(model: .shared))
        banner.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(banner)
        // Preferred card width; the required side insets win on narrow panes.
        let bannerWidth = banner.widthAnchor.constraint(equalToConstant: 560)
        bannerWidth.priority = .defaultHigh
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            // Float just below the 50px titlebar clearance the native chrome
            // CSS reserves so the card never collides with window controls.
            banner.topAnchor.constraint(equalTo: container.topAnchor, constant: 58),
            banner.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            banner.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 16),
            bannerWidth,
        ])
        return container
    }
}

/// App icon with a status badge in the corner — mirrors the familiar
/// "import from browser" banner iconography without shipping third-party logos.
private struct BannerBadgeIcon: View {
    let badge: BrowserProfileImportBannerContent.Badge

    var body: some View {
        Image(nsImage: NSApp.applicationIconImage ?? NSImage())
            .resizable()
            .frame(width: 34, height: 34)
            .overlay(alignment: .bottomTrailing) {
                self.badgeSymbol
                    .frame(width: 16, height: 16)
                    .background(Circle().fill(.background))
                    .offset(x: 4, y: 4)
            }
            .padding(.trailing, 2)
    }

    @ViewBuilder
    private var badgeSymbol: some View {
        switch self.badge {
        case .globe, .progress:
            Image(systemName: "globe")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color.accentColor)
        case .success:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.green)
        case .failure:
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.orange)
        }
    }
}
