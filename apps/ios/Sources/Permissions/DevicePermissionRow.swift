import SwiftUI

/// Capsule action used by permission rows: filled for the initial "Allow",
/// bordered for repair actions like "Open Settings" or "Upgrade".
struct DevicePermissionActionButtonStyle: ButtonStyle {
    let prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(OpenClawType.footnoteSemiBold)
            .padding(.horizontal, 14)
            .frame(height: 32)
            .foregroundStyle(
                self.prominent
                    ? OpenClawBrand.activationPrimaryActionText
                    : OpenClawBrand.activationPrimaryAction)
            .background {
                if self.prominent {
                    Capsule(style: .continuous)
                        .fill(OpenClawBrand.activationPrimaryGradient)
                } else {
                    Capsule(style: .continuous)
                        .fill(OpenClawBrand.activationNeutralSurface)
                }
            }
            .overlay {
                Capsule(style: .continuous)
                    .stroke(
                        self.prominent
                            ? Color.white.opacity(0.26)
                            : OpenClawBrand.activationNeutralStroke,
                        lineWidth: 0.5)
            }
            .opacity(configuration.isPressed ? 0.86 : 1)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.smooth(duration: 0.12), value: configuration.isPressed)
    }
}

/// One device permission with an icon tile, explanation, and a single clear
/// affordance: Allow when unset, a green check when granted, a repair action otherwise.
struct DevicePermissionRow: View {
    let identifierPrefix: String
    let identifier: String
    let symbol: String
    let tint: Color
    let title: LocalizedStringResource
    let detail: LocalizedStringResource
    let grant: DevicePermissionGrant
    var isRequesting: Bool = false
    var statusLabel: LocalizedStringResource?
    var actionTitle: LocalizedStringResource?
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            self.iconTile

            VStack(alignment: .leading, spacing: 2) {
                Text(self.title)
                    .font(OpenClawType.subheadSemiBold)
                Text(self.detail)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 8)

            self.trailingControl
        }
        .padding(.vertical, 6)
    }

    private var isGrantedTile: Bool {
        self.grant == .granted || self.grant == .limited
    }

    private var iconTile: some View {
        Image(systemName: self.symbol)
            .font(OpenClawType.subheadSemiBold)
            .foregroundStyle(self.isGrantedTile ? Color.white : self.tint)
            .frame(width: 36, height: 36)
            .background {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(self.isGrantedTile ? AnyShapeStyle(self.tint) : AnyShapeStyle(self.tint.opacity(0.14)))
            }
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var trailingControl: some View {
        if self.isRequesting {
            ProgressView()
                .progressViewStyle(.circular)
                .controlSize(.small)
                .frame(height: 32)
        } else {
            VStack(alignment: .trailing, spacing: 4) {
                if let actionTitle = self.actionTitle, let action = self.action {
                    Button(action: action) {
                        Text(actionTitle)
                            .font(OpenClawType.footnoteSemiBold)
                    }
                    .buttonStyle(DevicePermissionActionButtonStyle(prominent: self.grant == .notRequested))
                    .accessibilityIdentifier("\(self.identifierPrefix)-\(self.identifier)-action")
                } else if self.grant == .granted || self.grant == .limited {
                    Image(systemName: "checkmark.circle.fill")
                        .font(OpenClawType.title3SemiBold)
                        .foregroundStyle(OpenClawBrand.ok)
                        .accessibilityLabel(Text(self.statusLabel ?? LocalizedStringResource("Allowed")))
                        .accessibilityIdentifier("\(self.identifierPrefix)-\(self.identifier)-status")
                }

                if let statusCaption {
                    Text(statusCaption)
                        .font(OpenClawType.caption2Medium)
                        .foregroundStyle(self.statusCaptionColor)
                        .accessibilityIdentifier("\(self.identifierPrefix)-\(self.identifier)-status")
                }
            }
        }
    }

    /// Shown under the action for partial or blocked states so the row explains
    /// why a repair action (Upgrade / Open Settings) is offered.
    private var statusCaption: LocalizedStringResource? {
        guard self.actionTitle != nil else { return nil }
        switch self.grant {
        case .limited:
            return self.statusLabel ?? LocalizedStringResource("Limited")
        case .denied:
            return self.statusLabel ?? LocalizedStringResource("Off in Settings")
        case .granted, .notRequested:
            return nil
        }
    }

    private var statusCaptionColor: Color {
        self.grant == .denied ? OpenClawBrand.danger : OpenClawBrand.warn
    }
}
