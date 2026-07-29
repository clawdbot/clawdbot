import OpenClawKit
import SwiftUI
import UIKit

extension GatewayConnectionProblem.PresentationText {
    var localizedString: String {
        switch self {
        case let .localized(key):
            String(localized: String.LocalizationValue(key))
        case let .localizedFormat(format, arguments):
            String(
                format: String(localized: String.LocalizationValue(format)),
                locale: .current,
                arguments: arguments.map { $0 as CVarArg })
        case let .verbatim(value):
            value
        }
    }
}

extension GatewayConnectionProblem {
    var localizedTitle: String {
        self.titlePresentation.localizedString
    }

    var localizedMessage: String {
        self.messagePresentation.localizedString
    }

    var localizedActionLabel: String? {
        self.actionLabelPresentation?.localizedString
    }

    var localizedStatusText: String {
        switch self.kind {
        case .pairingRequired, .pairingRoleUpgradeRequired, .pairingScopeUpgradeRequired,
             .pairingMetadataUpgradeRequired, .protocolMismatch:
            guard let requestId else { return self.localizedTitle }
            return String(
                format: String(localized: "%@ (request ID: %@)"),
                self.localizedTitle,
                requestId)
        default:
            return self.localizedTitle
        }
    }
}

struct GatewayProblemBanner: View {
    let problem: GatewayConnectionProblem
    var primaryActionTitle: String?
    var onPrimaryAction: (() -> Void)?
    var onShowDetails: (() -> Void)?

    var body: some View {
        OpenClawNoticeBanner(
            icon: self.iconName,
            title: .verbatim(self.problem.localizedTitle),
            message: .verbatim(self.problem.localizedMessage),
            ownerLabel: .localized(self.ownerLabel),
            tint: self.tint,
            detail: self.problem.requestId.map(OpenClawNoticeDetail.requestID),
            primaryActionTitle: self.primaryActionTitle.map(OpenClawTextValue.verbatim),
            onPrimaryAction: self.onPrimaryAction,
            secondaryActionTitle: "Details",
            onSecondaryAction: self.onShowDetails)
    }

    private var iconName: String {
        switch self.problem.kind {
        case .pairingRequired,
             .pairingRoleUpgradeRequired,
             .pairingScopeUpgradeRequired,
             .pairingMetadataUpgradeRequired:
            "person.crop.circle.badge.clock"
        case .timeout, .connectionRefused, .reachabilityFailed, .websocketCancelled:
            "wifi.exclamationmark"
        case .deviceIdentityRequired,
             .deviceSignatureExpired,
             .deviceNonceRequired,
             .deviceNonceMismatch,
             .deviceSignatureInvalid,
             .devicePublicKeyInvalid,
             .deviceIdMismatch:
            "lock.shield"
        default:
            "exclamationmark.triangle.fill"
        }
    }

    private var tint: Color {
        switch self.problem.kind {
        case .pairingRequired,
             .pairingRoleUpgradeRequired,
             .pairingScopeUpgradeRequired,
             .pairingMetadataUpgradeRequired:
            OpenClawBrand.warn
        case .timeout, .connectionRefused, .reachabilityFailed, .websocketCancelled:
            OpenClawBrand.warn
        default:
            OpenClawBrand.danger
        }
    }

    private var ownerLabel: String {
        switch self.problem.owner {
        case .gateway:
            "Fix on gateway"
        case .iphone:
            "Fix on this device"
        case .both:
            "Check both"
        case .network:
            "Check network"
        case .unknown:
            "Needs attention"
        }
    }
}

struct GatewayProblemDetailsSheet: View {
    @Environment(\.dismiss) private var dismiss

    let problem: GatewayConnectionProblem
    var primaryActionTitle: String?
    var onPrimaryAction: (() -> Void)?

    @State private var copyFeedback: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(verbatim: self.problem.localizedTitle)
                            .font(OpenClawType.title3)
                        Text(verbatim: self.problem.localizedMessage)
                            .font(OpenClawType.body)
                            .foregroundStyle(.secondary)
                        Text(LocalizedStringKey(self.ownerSummary))
                            .font(OpenClawType.footnoteSemiBold)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
                }

                if let requestId = self.problem.requestId {
                    Section {
                        Text(verbatim: requestId)
                            .font(OpenClawType.mono)
                            .textSelection(.enabled)
                        Button {
                            UIPasteboard.general.string = requestId
                            self.copyFeedback = "Copied request ID"
                        } label: {
                            Text("Copy request ID")
                                .font(OpenClawType.subheadSemiBold)
                        }
                        .font(OpenClawType.subheadSemiBold)
                    } header: {
                        Text("Request")
                            .font(OpenClawType.captionSemiBold)
                    }
                }

                if let actionCommand = self.problem.actionCommand {
                    Section {
                        Text(verbatim: actionCommand)
                            .font(OpenClawType.mono)
                            .textSelection(.enabled)
                        Button {
                            UIPasteboard.general.string = actionCommand
                            self.copyFeedback = "Copied command"
                        } label: {
                            Text("Copy command")
                                .font(OpenClawType.subheadSemiBold)
                        }
                        .font(OpenClawType.subheadSemiBold)
                    } header: {
                        Text("Gateway command")
                            .font(OpenClawType.captionSemiBold)
                    }
                }

                if let docsURL = self.problem.docsURL {
                    Section {
                        Link(destination: docsURL) {
                            Label("Open docs", systemImage: "book")
                                .font(OpenClawType.subheadSemiBold)
                        }
                        .font(OpenClawType.subheadSemiBold)
                        Text(verbatim: docsURL.absoluteString)
                            .font(OpenClawType.footnote)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    } header: {
                        Text("Help")
                            .font(OpenClawType.captionSemiBold)
                    }
                }

                if let technicalDetails = self.problem.technicalDetails {
                    Section {
                        Text(verbatim: technicalDetails)
                            .font(OpenClawType.monoFootnote)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    } header: {
                        Text("Technical details")
                            .font(OpenClawType.captionSemiBold)
                    }
                }

                if let copyFeedback {
                    Section {
                        Text(verbatim: copyFeedback)
                            .font(OpenClawType.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Connection problem")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("Connection problem")
                        .font(OpenClawType.headline)
                }
                ToolbarItem(placement: .topBarLeading) {
                    if let primaryActionTitle, let onPrimaryAction {
                        Button {
                            self.dismiss()
                            onPrimaryAction()
                        } label: {
                            Text(verbatim: primaryActionTitle)
                                .font(OpenClawType.subheadSemiBold)
                        }
                        .font(OpenClawType.subheadSemiBold)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        self.dismiss()
                    } label: {
                        Text("Done")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .font(OpenClawType.subheadSemiBold)
                }
            }
        }
    }

    private var ownerSummary: String {
        switch self.problem.owner {
        case .gateway:
            "Primary fix: gateway"
        case .iphone:
            "Primary fix: this device"
        case .both:
            "Primary fix: check both this device and the gateway"
        case .network:
            "Primary fix: network or remote access"
        case .unknown:
            "Primary fix: review details and retry"
        }
    }
}
