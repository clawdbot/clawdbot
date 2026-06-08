import SwiftUI
import UIKit

struct TalkRuntimeIssueBanner: View {
    @Environment(\.colorScheme) private var colorScheme

    let issue: TalkRuntimeIssue
    var onOpenSettings: (() -> Void)?
    var onShowDetails: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: self.iconName)
                    .font(.headline.weight(.semibold))
                    .foregroundStyle(self.tint)
                    .frame(width: 20)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(self.issue.fallbackBannerTitle)
                            .font(.subheadline.weight(.semibold))
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        Text(self.issue.fallbackBannerOwnerLabel)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }

                    Text(self.issue.fallbackBannerMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    Text(self.issue.displayMessage)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(self.tint)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            HStack(spacing: 10) {
                if let onOpenSettings {
                    Button("Open Settings", action: onOpenSettings)
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                }
                if let onShowDetails {
                    Button("Details", action: onShowDetails)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(13)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.ultraThickMaterial)
                .overlay {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(Color.primary.opacity(self.colorScheme == .dark ? 0.12 : 0.07), lineWidth: 1)
                }
                .shadow(color: .black.opacity(self.colorScheme == .dark ? 0.16 : 0.07), radius: 16, y: 7)
        }
    }

    private var iconName: String {
        "exclamationmark.triangle.fill"
    }

    private var tint: Color {
        .orange
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
                            .font(.title3.weight(.semibold))
                        Text(self.issue.fallbackBannerMessage)
                            .font(.body)
                            .foregroundStyle(.secondary)
                        Text(self.issue.displayMessage)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
                }

                Section("Technical details") {
                    Text(verbatim: self.issue.technicalDetails)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    Button("Copy diagnostics") {
                        UIPasteboard.general.string = self.issue.technicalDetails
                        self.copyFeedback = "Copied diagnostics"
                    }
                }

                if let copyFeedback {
                    Section {
                        Text(copyFeedback)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Talk fallback")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if let onOpenSettings {
                        Button("Open Settings") {
                            self.dismiss()
                            onOpenSettings()
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        self.dismiss()
                    }
                }
            }
        }
    }
}
