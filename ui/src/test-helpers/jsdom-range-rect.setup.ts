// jsdom gives elements a rect but leaves Range without one at all, so code that
// measures a rendered text span throws instead of reading the empty geometry
// jsdom reports for everything else. A case needing a real span overrides this.
if (typeof Range.prototype.getBoundingClientRect !== "function") {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
