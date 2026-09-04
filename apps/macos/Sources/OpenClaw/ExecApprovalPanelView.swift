import AppKit
import SwiftUI

struct ExecApprovalPanelView: View {
    let request: ExecApprovalPromptRequest
    let decisions: [ExecApprovalDecision]
    let onDecision: (ExecApprovalDecision) -> Void

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
                Text("Review what will run before granting permission.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
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
                .frame(minHeight: 100, maxHeight: .infinity)
        }
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.primary.opacity(0.1)))
    }

    private var context: some View {
        ScrollView {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 10) {
                self.detail("Run on", value: self.request.host, symbol: "desktopcomputer")
                self.detail("Agent", value: self.request.agentId, symbol: "person.crop.circle")
                self.detail("Directory", value: self.request.cwd, symbol: "folder")
                self.detail(
                    "Executable",
                    value: self.request.resolvedPath,
                    symbol: "chevron.left.forwardslash.chevron.right")
                self.detail("Security", value: self.request.security, symbol: "shield")
                self.detail("Ask mode", value: self.request.ask, symbol: "hand.raised")
            }
            .font(.system(size: 12))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxHeight: 170)
    }

    @ViewBuilder
    private func detail(_ title: String, value: String?, symbol: String) -> some View {
        if let value = ExecApprovalsPromptPresenter.sanitizedContextValue(value) {
            GridRow(alignment: .top) {
                Label(title, systemImage: symbol)
                    .foregroundStyle(.secondary)
                    .fixedSize()
                Text(value)
                    .fontDesign(title == "Directory" || title == "Executable" ? .monospaced : .default)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("\(title): \(value)")
            }
        }
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 12) {
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
            Text("Approval is required before this command can run.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 24)
                .padding(.bottom, 18)
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
        textView.setAccessibilityLabel("Command")
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
