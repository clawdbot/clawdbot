import AppKit
import SwiftUI

struct ExecApprovalPanelView: View {
    let request: ExecApprovalPromptRequest
    let decisions: [ExecApprovalDecision]
    let onDecision: (ExecApprovalDecision) -> Void

    @State private var showingDetails = false

    private var command: String {
        ExecApprovalCommandDisplaySanitizer.sanitize(self.request.command)
    }

    var body: some View {
        VStack(spacing: 0) {
            self.header
            VStack(alignment: .leading, spacing: 18) {
                self.commandCard
                self.context
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 20)
            self.actions
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            if let icon = NSApp.applicationIconImage {
                Image(nsImage: icon)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 64, height: 64)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 5) {
                Text("OpenClaw")
                    .font(.system(size: 13, weight: .semibold))
                Text("Allow this command?")
                    .font(.system(size: 23, weight: .semibold))
                let agent = ExecApprovalsPromptPresenter.sanitizedContextValue(self.request.agentId)
                let host = ExecApprovalsPromptPresenter.sanitizedContextValue(self.request.host)
                let summary = [
                    agent.map { String(format: String(localized: "Agent %@"), $0) },
                    host.map { String(format: String(localized: "Host %@"), $0) },
                ].compactMap(\.self).joined(separator: " · ")
                if !summary.isEmpty {
                    Text(verbatim: summary)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(summary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(24)
    }

    private var commandCard: some View {
        VStack(spacing: 0) {
            HStack {
                Text("COMMAND")
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(1.2)
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    // Copy the same escaped text that was reviewed, never hidden control characters.
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(self.command, forType: .string)
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                        .font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .help("Copy displayed command")
                .accessibilityLabel("Copy displayed command")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            Divider()
            ExecApprovalCommandView(command: self.command)
                .frame(minHeight: 56, maxHeight: .infinity)
        }
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.primary.opacity(0.1)))
    }

    private var context: some View {
        HStack(alignment: .top, spacing: 10) {
            if let cwd = ExecApprovalsPromptPresenter.sanitizedContextValue(self.request.cwd) {
                Image(systemName: "folder")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                ScrollView {
                    Text(verbatim: cwd)
                        .font(.system(size: 12, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityLabel(Text(verbatim: String(
                            format: String(localized: "Working directory: %@"), cwd)))
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxHeight: 44)
            } else {
                Spacer(minLength: 0)
            }
            if let executable = ExecApprovalsPromptPresenter.sanitizedContextValue(self.request.resolvedPath) {
                Button("Details") { self.showingDetails.toggle() }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .popover(isPresented: self.$showingDetails) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Resolved executable").font(.headline)
                            ScrollView {
                                Text(verbatim: executable)
                                    .font(.system(size: 12, design: .monospaced))
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .frame(width: 360, height: 60)
                        }
                        .padding(16)
                    }
            }
        }
        .font(.system(size: 12))
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 0) {
            Divider()
            HStack(spacing: 10) {
                if self.decisions.contains(.allowAlways) {
                    Button("Always Allow Here") { self.onDecision(.allowAlways) }
                        .help("Save a reusable approval for this execution")
                }
                Spacer(minLength: 8)
                if self.decisions.contains(.deny) {
                    Button("Don't Allow") { self.onDecision(.deny) }
                        .keyboardShortcut(.cancelAction)
                }
                if self.decisions.contains(.allowOnce) {
                    Button("Allow Once") { self.onDecision(.allowOnce) }
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.return, modifiers: .command)
                        .help("Allow only this request (⌘Return)")
                }
            }
            .controlSize(.large)
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
            if self.decisions.contains(.allowAlways) {
                Text("Always Allow Here saves approval for future matching requests.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 16)
            }
        }
    }
}

private struct ExecApprovalCommandView: NSViewRepresentable {
    let command: String

    func makeNSView(context: Context) -> NSScrollView {
        let textView = NSTextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.drawsBackground = false
        textView.textColor = .labelColor
        textView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.textContainerInset = NSSize(width: 16, height: 14)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.setAccessibilityLabel(String(localized: "Command"))
        textView.string = self.command

        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView, textView.string != self.command else { return }
        textView.string = self.command
    }
}
