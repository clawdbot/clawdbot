import UIKit

/// Compose card UI for the share extension. This target cannot link the app
/// design layer (`Sources/Design`), so the accent below mirrors
/// `OpenClawBrand.activationPrimaryAction`; keep both in sync when rebranding.
final class ShareComposeView: UIView, UITextViewDelegate {
    private enum Metric {
        static let pagePadding: CGFloat = 16
        static let cardRadius: CGFloat = 16
        static let sendHeight: CGFloat = 54
        static let thumbnailSize: CGFloat = 56
        static let thumbnailRadius: CGFloat = 12
        static let headerHeight: CGFloat = 48
    }

    private static let accent = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 238 / 255, green: 82 / 255, blue: 76 / 255, alpha: 1)
            : UIColor(red: 209 / 255, green: 54 / 255, blue: 51 / 255, alpha: 1)
    }

    var onSend: (() -> Void)?
    var onCancel: (() -> Void)?

    var draftText: String {
        self.textView.text ?? ""
    }

    private let titleLabel = UILabel()
    private let cancelButton = UIButton(configuration: .plain())
    private let hairline = UIView()
    private let textView = UITextView()
    private let placeholderLabel = UILabel()
    private let attachmentsRow = UIStackView()
    private let statusContainer = UIView()
    private let statusStack = UIStackView()
    private let statusSpinner = UIActivityIndicatorView(style: .medium)
    private let statusIcon = UIImageView()
    private let statusLabel = UILabel()
    private let sendButton = UIButton(configuration: ShareComposeView.makeSendConfiguration())
    private var status: ShareComposeStatus = .preparing

    override init(frame: CGRect) {
        super.init(frame: frame)
        self.configureSubviews()
        self.installLayout()
        self.apply(.preparing)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func setDraft(_ text: String) {
        self.textView.text = text
        self.draftDidChange()
    }

    func setAttachmentPreviews(_ images: [UIImage]) {
        for view in self.attachmentsRow.arrangedSubviews {
            view.removeFromSuperview()
        }
        guard !images.isEmpty else {
            self.attachmentsRow.isHidden = true
            return
        }
        for image in images {
            let thumbnail = UIImageView(image: image)
            thumbnail.contentMode = .scaleAspectFill
            thumbnail.clipsToBounds = true
            thumbnail.layer.cornerRadius = Metric.thumbnailRadius
            thumbnail.layer.cornerCurve = .continuous
            thumbnail.widthAnchor.constraint(equalToConstant: Metric.thumbnailSize).isActive = true
            self.attachmentsRow.addArrangedSubview(thumbnail)
        }
        let spacer = UIView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        self.attachmentsRow.addArrangedSubview(spacer)
        self.attachmentsRow.isHidden = false
    }

    func apply(_ status: ShareComposeStatus) {
        self.status = status
        switch status {
        case .preparing:
            self.showFooter(
                text: NSLocalizedString("Preparing share…", comment: "Share extension preparation status"),
                icon: nil,
                spinning: true)
        case .ready:
            self.statusContainer.isHidden = true
        case .sending:
            self.showFooter(
                text: NSLocalizedString("Sending to OpenClaw gateway…", comment: "Share extension sending status"),
                icon: nil,
                spinning: true)
        case .sent:
            self.showFooter(
                text: NSLocalizedString("Sent to OpenClaw.", comment: "Share extension success status"),
                icon: (name: "checkmark.circle.fill", tint: .systemGreen),
                spinning: false)
        case let .blocked(message), let .failed(message):
            self.showFooter(
                text: message,
                icon: (name: "exclamationmark.triangle.fill", tint: .systemOrange),
                spinning: false)
        }
        self.updateControls()
    }

    func focusDraft() {
        self.textView.becomeFirstResponder()
    }

    func textViewDidChange(_ textView: UITextView) {
        self.draftDidChange()
    }

    private func draftDidChange() {
        if case .failed = self.status {
            // Stale failure feedback confuses fresh edits; clear it once typing resumes.
            self.apply(.ready)
            return
        }
        self.updateControls()
    }

    private func updateControls() {
        let hasDraftText = !self.draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let controls = ShareComposeControlState.resolve(status: self.status, hasDraftText: hasDraftText)
        self.sendButton.isEnabled = controls.isSendEnabled
        self.cancelButton.isEnabled = controls.isCancelEnabled
        self.textView.isEditable = controls.isEditable
        self.placeholderLabel.isHidden = !self.draftText.isEmpty
    }

    private func showFooter(text: String, icon: (name: String, tint: UIColor)?, spinning: Bool) {
        self.statusContainer.isHidden = false
        self.statusLabel.text = text
        if spinning {
            self.statusSpinner.startAnimating()
        } else {
            self.statusSpinner.stopAnimating()
        }
        if let icon {
            self.statusIcon.image = UIImage(systemName: icon.name)
            self.statusIcon.tintColor = icon.tint
            self.statusIcon.isHidden = false
        } else {
            self.statusIcon.isHidden = true
        }
        UIAccessibility.post(notification: .announcement, argument: text)
    }

    private func configureSubviews() {
        self.backgroundColor = .systemGroupedBackground

        self.titleLabel.text = "OpenClaw"
        self.titleLabel.font = .preferredFont(forTextStyle: .headline)
        self.titleLabel.adjustsFontForContentSizeCategory = true
        self.titleLabel.accessibilityTraits.insert(.header)

        var cancelConfiguration = UIButton.Configuration.plain()
        cancelConfiguration.attributedTitle = Self.attributedTitle(
            NSLocalizedString("Cancel", comment: "Share extension cancel action"),
            style: .body)
        cancelConfiguration.baseForegroundColor = Self.accent
        cancelConfiguration.contentInsets = NSDirectionalEdgeInsets(top: 11, leading: 0, bottom: 11, trailing: 8)
        self.cancelButton.configuration = cancelConfiguration
        self.cancelButton.accessibilityIdentifier = "share-compose.cancel"
        self.cancelButton.addAction(UIAction { [weak self] _ in self?.onCancel?() }, for: .touchUpInside)

        self.hairline.backgroundColor = .separator

        self.textView.font = .preferredFont(forTextStyle: .body)
        self.textView.adjustsFontForContentSizeCategory = true
        self.textView.backgroundColor = .secondarySystemGroupedBackground
        self.textView.layer.cornerRadius = Metric.cardRadius
        self.textView.layer.cornerCurve = .continuous
        self.textView.textContainerInset = UIEdgeInsets(top: 14, left: 12, bottom: 14, right: 12)
        self.textView.delegate = self
        self.textView.accessibilityIdentifier = "share-compose.draft"

        self.placeholderLabel.text = NSLocalizedString(
            "Add a message, then tap Send.",
            comment: "Share extension empty draft guidance")
        self.placeholderLabel.font = .preferredFont(forTextStyle: .body)
        self.placeholderLabel.adjustsFontForContentSizeCategory = true
        self.placeholderLabel.textColor = .tertiaryLabel
        self.placeholderLabel.numberOfLines = 0
        self.placeholderLabel.isAccessibilityElement = false
        self.textView.accessibilityHint = self.placeholderLabel.text

        self.attachmentsRow.axis = .horizontal
        self.attachmentsRow.spacing = 8
        self.attachmentsRow.isHidden = true

        self.statusSpinner.hidesWhenStopped = true
        self.statusIcon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .footnote)
        self.statusIcon.isHidden = true
        self.statusLabel.font = .preferredFont(forTextStyle: .footnote)
        self.statusLabel.adjustsFontForContentSizeCategory = true
        self.statusLabel.textColor = .secondaryLabel
        self.statusLabel.numberOfLines = 0
        self.statusLabel.textAlignment = .center

        self.sendButton.accessibilityIdentifier = "share-compose.send"
        self.sendButton.addAction(UIAction { [weak self] _ in self?.onSend?() }, for: .touchUpInside)
        self.sendButton.configurationUpdateHandler = { button in
            var configuration = button.configuration
            configuration?.baseBackgroundColor = button.isEnabled ? Self.accent : .tertiarySystemFill
            configuration?.baseForegroundColor = button.isEnabled ? .white : .secondaryLabel
            button.configuration = configuration
        }
    }

    private func installLayout() {
        let header = UIView()
        header.addSubview(self.cancelButton)
        header.addSubview(self.titleLabel)

        self.textView.addSubview(self.placeholderLabel)

        self.statusStack.axis = .horizontal
        self.statusStack.spacing = 6
        self.statusStack.alignment = .center
        self.statusStack.addArrangedSubview(self.statusSpinner)
        self.statusStack.addArrangedSubview(self.statusIcon)
        self.statusStack.addArrangedSubview(self.statusLabel)
        self.statusContainer.addSubview(self.statusStack)

        let contentStack = UIStackView(arrangedSubviews: [
            self.textView,
            self.attachmentsRow,
            self.statusContainer,
            self.sendButton,
        ])
        contentStack.axis = .vertical
        contentStack.spacing = 12

        self.addSubview(header)
        self.addSubview(self.hairline)
        self.addSubview(contentStack)

        for view in [
            header, self.cancelButton, self.titleLabel, self.hairline,
            self.placeholderLabel, self.statusStack, contentStack,
        ] {
            view.translatesAutoresizingMaskIntoConstraints = false
        }

        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: self.safeAreaLayoutGuide.topAnchor),
            header.leadingAnchor.constraint(equalTo: self.leadingAnchor, constant: Metric.pagePadding),
            header.trailingAnchor.constraint(equalTo: self.trailingAnchor, constant: -Metric.pagePadding),
            header.heightAnchor.constraint(equalToConstant: Metric.headerHeight),

            self.cancelButton.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            self.cancelButton.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            self.titleLabel.centerXAnchor.constraint(equalTo: header.centerXAnchor),
            self.titleLabel.centerYAnchor.constraint(equalTo: header.centerYAnchor),

            self.hairline.topAnchor.constraint(equalTo: header.bottomAnchor),
            self.hairline.leadingAnchor.constraint(equalTo: self.leadingAnchor),
            self.hairline.trailingAnchor.constraint(equalTo: self.trailingAnchor),
            self.hairline.heightAnchor.constraint(equalToConstant: 0.5),

            contentStack.topAnchor.constraint(equalTo: self.hairline.bottomAnchor, constant: 12),
            contentStack.leadingAnchor.constraint(equalTo: self.leadingAnchor, constant: Metric.pagePadding),
            contentStack.trailingAnchor.constraint(equalTo: self.trailingAnchor, constant: -Metric.pagePadding),
            contentStack.bottomAnchor.constraint(equalTo: self.keyboardLayoutGuide.topAnchor, constant: -12),

            self.textView.heightAnchor.constraint(greaterThanOrEqualToConstant: 72),
            self.attachmentsRow.heightAnchor.constraint(equalToConstant: Metric.thumbnailSize),
            self.sendButton.heightAnchor.constraint(equalToConstant: Metric.sendHeight),

            self.placeholderLabel.topAnchor.constraint(
                equalTo: self.textView.frameLayoutGuide.topAnchor,
                constant: 14),
            self.placeholderLabel.leadingAnchor.constraint(
                equalTo: self.textView.frameLayoutGuide.leadingAnchor,
                constant: 17),
            self.placeholderLabel.widthAnchor.constraint(
                lessThanOrEqualTo: self.textView.frameLayoutGuide.widthAnchor,
                constant: -34),

            self.statusStack.topAnchor.constraint(equalTo: self.statusContainer.topAnchor),
            self.statusStack.bottomAnchor.constraint(equalTo: self.statusContainer.bottomAnchor),
            self.statusStack.centerXAnchor.constraint(equalTo: self.statusContainer.centerXAnchor),
            self.statusStack.leadingAnchor.constraint(greaterThanOrEqualTo: self.statusContainer.leadingAnchor),
            self.statusStack.trailingAnchor.constraint(lessThanOrEqualTo: self.statusContainer.trailingAnchor),
        ])
    }

    private static func makeSendConfiguration() -> UIButton.Configuration {
        var configuration = self.sendConfigurationBase()
        configuration.cornerStyle = .capsule
        configuration.baseBackgroundColor = self.accent
        configuration.baseForegroundColor = .white
        configuration.image = UIImage(systemName: "paperplane.fill")
        configuration.imagePadding = 8
        configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(textStyle: .subheadline)
        configuration.attributedTitle = self.attributedTitle(
            NSLocalizedString("Send to OpenClaw", comment: "Share extension send action"),
            style: .headline)
        return configuration
    }

    /// Liquid Glass primary action on iOS 26 with the filled fallback that keeps
    /// the same label, tint, and hit target on iOS 18 hosts (see DESIGN.md).
    private static func sendConfigurationBase() -> UIButton.Configuration {
        if #available(iOS 26.0, *) {
            return .prominentGlass()
        }
        return .filled()
    }

    private static func attributedTitle(_ text: String, style: UIFont.TextStyle) -> AttributedString {
        var title = AttributedString(text)
        title.font = UIFont.preferredFont(forTextStyle: style)
        return title
    }
}
