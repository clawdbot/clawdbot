import SwiftUI
import UIKit

struct TalkRuntimeIssueBanner: View {
    let issue: TalkRuntimeIssue
    var onOpenSettings: (() -> Void)?
    var onShowDetails: (() -> Void)?

    var body: some View {
        OpenClawNoticeBanner(
            icon: self.iconName,
            title: .verbatim(self.issue.fallbackBannerTitle),
            message: .verbatim(self.issue.fallbackBannerMessage),
            ownerLabel: .verbatim(self.issue.fallbackBannerOwnerLabel),
            tint: self.tint,
            detail: .accent(self.issue.displayMessage),
            primaryActionTitle: "Open Settings",
            onPrimaryAction: self.onOpenSettings,
            secondaryActionTitle: "Details",
            onSecondaryAction: self.onShowDetails)
    }

    private var iconName: String {
        "exclamationmark.triangle.fill"
    }

    private var tint: Color {
        OpenClawBrand.warn
    }
}

struct TalkRuntimeIssueDetailsSheet: View {
    @Environment(\.dismiss) private var dismiss

    let issue: TalkRuntimeIssue
    var onOpenSettings: (() -> Void)?

    @State private var copyFeedback: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(self.issue.fallbackBannerTitle)
                            .font(OpenClawType.title3SemiBold)
                        Text(self.issue.fallbackBannerMessage)
                            .font(OpenClawType.body)
                            .foregroundStyle(.secondary)
                        Text(self.issue.displayMessage)
                            .font(OpenClawType.footnoteSemiBold)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
                }

                Section {
                    Text(verbatim: self.issue.technicalDetails)
                        .font(OpenClawType.monoFootnote)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    Button {
                        UIPasteboard.general.string = self.issue.technicalDetails
                        self.copyFeedback = "Copied diagnostics"
                    } label: {
                        Text("Copy diagnostics")
                            .font(OpenClawType.subheadSemiBold)
                    }
                } header: {
                    Text("Technical details")
                        .font(OpenClawType.captionSemiBold)
                }

                if let copyFeedback {
                    Section {
                        Text(copyFeedback)
                            .font(OpenClawType.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Talk fallback")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if let onOpenSettings {
                        Button {
                            self.dismiss()
                            onOpenSettings()
                        } label: {
                            Text("Open Settings")
                                .font(OpenClawType.subheadSemiBold)
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        self.dismiss()
                    } label: {
                        Text("Done")
                            .font(OpenClawType.subheadSemiBold)
                    }
                }
            }
        }
    }
}
