import Foundation
import Testing
@testable import OpenClawKit

#if canImport(WebKit)
struct WebViewJavaScriptSupportTests {
    @Test func `evaluation results preserve boolean and numeric scalars`() {
        #expect(WebViewJavaScriptSupport.evaluationResultString(NSNumber(value: false)) == "false")
        #expect(WebViewJavaScriptSupport.evaluationResultString(NSNumber(value: true)) == "true")
        #expect(WebViewJavaScriptSupport.evaluationResultString(NSNumber(value: 0)) == "0")
        #expect(WebViewJavaScriptSupport.evaluationResultString(NSNumber(value: 1)) == "1")
        #expect(WebViewJavaScriptSupport.evaluationResultString(NSNumber(value: 1.5)) == "1.5")
        #expect(WebViewJavaScriptSupport.evaluationResultString("") == "")
        #expect(WebViewJavaScriptSupport.evaluationResultString(nil) == "")
    }
}
#endif
