import Foundation

extension NSAttributedString {
    func strippingForegroundColor() -> NSAttributedString {
        let mutable = NSMutableAttributedString(attributedString: self)
        mutable.removeAttribute(.foregroundColor, range: NSRange(location: 0, length: mutable.length))
        return mutable
    }
}
