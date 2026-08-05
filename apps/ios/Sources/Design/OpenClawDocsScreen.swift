import SwiftUI

struct OpenClawDocsScreen: View {
    private let docsURL = URL(string: "https://docs.openclaw.ai")!
    private let gatewayURL = URL(string: "https://docs.openclaw.ai/gateway")!
    private let pairingURL = URL(string: "https://docs.openclaw.ai/channels/pairing")!
    let headerSidebarAction: OpenClawSidebarHeaderAction?
    let usesNativeNavigationChrome: Bool
    let gatewayAction: (() -> Void)?

    init(
        headerSidebarAction: OpenClawSidebarHeaderAction? = nil,
        usesNativeNavigationChrome: Bool = false,
        gatewayAction: (() -> Void)? = nil)
    {
        self.headerSidebarAction = headerSidebarAction
        self.usesNativeNavigationChrome = usesNativeNavigationChrome
        self.gatewayAction = gatewayAction
    }

    var body: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if !self.usesNativeNavigationChrome {
                        self.headerCard
                    }
                    self.linkCard
                }
                .padding(.vertical, 18)
                .font(OpenClawType.body)
            }
        }
        .navigationTitle("Docs")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(self.usesNativeNavigationChrome ? .visible : .hidden, for: .navigationBar)
        .toolbar {
            if self.usesNativeNavigationChrome, let gatewayAction {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: gatewayAction) {
                        Image(systemName: "antenna.radiowaves.left.and.right")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .accessibilityLabel("Gateway settings")
                }
            }
            if self.usesNativeNavigationChrome, let headerSidebarAction {
                OpenClawSidebarToolbarItem(
                    action: headerSidebarAction,
                    placement: .topBarLeading)
            }
        }
    }

    private var headerCard: some View {
        ProCard(radius: OpenClawProMetric.cardRadius) {
            OpenClawAdaptiveHeaderRow(
                title: "Docs",
                subtitle: "Gateway setup, pairing, channels, and mobile node reference.",
                titleFont: OpenClawType.headline,
                subtitleFont: OpenClawType.caption)
            {
                HStack(spacing: 10) {
                    if let headerSidebarAction {
                        OpenClawSidebarHeaderLeadingSlot(action: headerSidebarAction)
                    }
                    ProIconBadge(systemName: "book", color: OpenClawBrand.accent)
                }
            } accessory: {
                self.gatewayPill
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    @ViewBuilder
    private var gatewayPill: some View {
        if let gatewayAction {
            Button(action: gatewayAction) {
                OpenClawGatewayCompactPill()
            }
            .buttonBorderShape(.capsule)
            .openClawGlassButton()
            .accessibilityHint("Opens Settings / Gateway")
        } else {
            OpenClawGatewayCompactPill()
        }
    }

    private var linkCard: some View {
        ProCard(padding: 0, radius: OpenClawProMetric.cardRadius) {
            VStack(spacing: 0) {
                self.docsLinkRow(
                    title: "Docs Home",
                    detail: "Browse the current OpenClaw reference.",
                    icon: "book",
                    url: self.docsURL)
                Divider().padding(.leading, 58)
                self.docsLinkRow(
                    title: "Gateway",
                    detail: "Connection, auth, and diagnostics.",
                    icon: "network",
                    url: self.gatewayURL)
                Divider().padding(.leading, 58)
                self.docsLinkRow(
                    title: "Pairing",
                    detail: "Mobile setup codes, QR, and node approval.",
                    icon: "qrcode",
                    url: self.pairingURL)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func docsLinkRow(title: String, detail: String, icon: String, url: URL) -> some View {
        Link(destination: url) {
            HStack(spacing: 12) {
                ProIconBadge(systemName: icon, color: OpenClawBrand.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(OpenClawType.subheadSemiBold)
                    Text(detail)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "arrow.up.right")
                    .font(OpenClawType.captionBold)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
