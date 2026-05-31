//#region packages/normalization-core/src/number-coercion.ts
function asFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function asFiniteNumberInRange(value, range) {
	const number = asFiniteNumber(value);
	if (number === void 0) return;
	if (range.min !== void 0) {
		if (range.minExclusive ? number <= range.min : number < range.min) return;
	}
	if (range.max !== void 0) {
		if (range.maxExclusive ? number >= range.max : number > range.max) return;
	}
	return number;
}
function asSafeIntegerInRange(value, range) {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) return;
	if (range.min !== void 0 && value < range.min) return;
	if (range.max !== void 0 && value > range.max) return;
	return value;
}
function normalizeNumericString(value) {
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function parseFiniteNumber(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
	return parseStrictFiniteNumber(value);
}
function parseStrictInteger(value) {
	if (typeof value === "number") return Number.isSafeInteger(value) ? value : void 0;
	if (typeof value !== "string") return;
	const normalized = normalizeNumericString(value);
	if (!normalized || !/^[+-]?\d+$/.test(normalized)) return;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) ? parsed : void 0;
}
function parseStrictFiniteNumber(value) {
	if (typeof value === "number") return Number.isFinite(value) ? value : void 0;
	if (typeof value !== "string") return;
	const normalized = normalizeNumericString(value);
	if (!normalized || !/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(normalized)) return;
	const parsed = Number(normalized);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function asPositiveSafeInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
const MAX_TIMER_TIMEOUT_MS = 2147e6;
const MAX_TIMER_TIMEOUT_SECONDS = Math.floor(MAX_TIMER_TIMEOUT_MS / 1e3);
const MAX_DATE_TIMESTAMP_MS = 864e13;
const UNIX_EPOCH_ISO_STRING = "1970-01-01T00:00:00.000Z";
function asDateTimestampMs(value) {
	return asFiniteNumberInRange(value, {
		min: -864e13,
		max: MAX_DATE_TIMESTAMP_MS
	});
}
function isFutureDateTimestampMs(value, opts = {}) {
	const timestampMs = asDateTimestampMs(value);
	const nowMs = asDateTimestampMs(opts.nowMs ?? Date.now());
	return timestampMs !== void 0 && nowMs !== void 0 && timestampMs > nowMs;
}
function timestampMsToIsoString(value) {
	const timestampMs = asDateTimestampMs(value);
	return timestampMs === void 0 ? void 0 : new Date(timestampMs).toISOString();
}
function resolveDateTimestampMs(value, fallbackValue = Date.now()) {
	return asDateTimestampMs(value) ?? asDateTimestampMs(fallbackValue) ?? 0;
}
function resolveTimestampMsToIsoString(value, fallbackValue = Date.now()) {
	return timestampMsToIsoString(value) ?? timestampMsToIsoString(fallbackValue) ?? "1970-01-01T00:00:00.000Z";
}
function timestampMsToIsoFileStamp(value, fallbackValue = Date.now()) {
	return resolveTimestampMsToIsoString(value, fallbackValue).replaceAll(":", "-");
}
function clampTimerTimeoutMs(valueMs, minMs = 1) {
	const value = asFiniteNumber(valueMs);
	if (value === void 0) return;
	return Math.min(Math.max(Math.floor(value), Math.max(1, Math.floor(minMs))), MAX_TIMER_TIMEOUT_MS);
}
function clampPositiveTimerTimeoutMs(valueMs) {
	const value = asFiniteNumber(valueMs);
	if (value === void 0 || value <= 0) return;
	return clampTimerTimeoutMs(value);
}
function resolvePositiveTimerTimeoutMs(valueMs, fallbackMs) {
	return clampPositiveTimerTimeoutMs(valueMs) ?? resolveTimerTimeoutMs(fallbackMs, 1);
}
function resolveTimerTimeoutMs(valueMs, fallbackMs, minMs = 1) {
	const value = asFiniteNumber(valueMs) ?? asFiniteNumber(fallbackMs);
	const min = Math.max(0, Math.floor(minMs));
	if (value === void 0) return min;
	return Math.min(Math.max(Math.floor(value), min), MAX_TIMER_TIMEOUT_MS);
}
function addTimerTimeoutGraceMs(timeoutMs, graceMs = 5e3) {
	const timeout = asFiniteNumber(timeoutMs);
	const grace = asFiniteNumber(graceMs);
	if (timeout === void 0 || grace === void 0) return;
	const withGrace = timeout + grace;
	return Number.isFinite(withGrace) ? clampTimerTimeoutMs(withGrace) : MAX_TIMER_TIMEOUT_MS;
}
function finiteSecondsToTimerSafeMilliseconds(value, opts = {}) {
	const seconds = asFiniteNumber(value);
	if (seconds === void 0 || seconds <= 0) return;
	const boundedSeconds = opts.floorSeconds ? Math.floor(seconds) : seconds;
	const milliseconds = Math.floor(boundedSeconds * 1e3);
	if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
	return Math.min(milliseconds, MAX_TIMER_TIMEOUT_MS);
}
function resolveIntegerOption(value, fallback, range = {}) {
	const floored = Math.floor(typeof value === "number" && Number.isFinite(value) ? value : fallback);
	const minBounded = range.min === void 0 ? floored : Math.max(range.min, floored);
	return range.max === void 0 ? minBounded : Math.min(range.max, minBounded);
}
function resolveOptionalIntegerOption(value, range = {}) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	return resolveIntegerOption(value, value, range);
}
function resolveNonNegativeIntegerOption(value, fallback) {
	return resolveIntegerOption(value, fallback, { min: 0 });
}
function parseStrictPositiveInteger(value) {
	const parsed = parseStrictInteger(value);
	return parsed !== void 0 && parsed > 0 ? parsed : void 0;
}
function parseStrictNonNegativeInteger(value) {
	const parsed = parseStrictInteger(value);
	return parsed !== void 0 && parsed >= 0 ? parsed : void 0;
}
function positiveSecondsToSafeMilliseconds(value) {
	const seconds = parseStrictPositiveInteger(value);
	if (seconds === void 0) return;
	const milliseconds = seconds * 1e3;
	return Number.isSafeInteger(milliseconds) ? milliseconds : void 0;
}
function nonNegativeSecondsToSafeMilliseconds(value) {
	const seconds = parseStrictNonNegativeInteger(value);
	if (seconds === void 0) return;
	const milliseconds = seconds * 1e3;
	return Number.isSafeInteger(milliseconds) ? milliseconds : void 0;
}
function resolveExpiresAtMsFromDurationMs(value, opts = {}) {
	const durationMs = asPositiveSafeInteger(value);
	if (durationMs === void 0) return;
	const nowMs = asDateTimestampMs(opts.nowMs ?? Date.now());
	const bufferMs = asFiniteNumber(opts.bufferMs ?? 0);
	if (nowMs === void 0 || bufferMs === void 0) return;
	const expiresAt = nowMs + durationMs - bufferMs;
	if (!Number.isSafeInteger(expiresAt) || timestampMsToIsoString(expiresAt) === void 0) return;
	const minRemainingMs = opts.minRemainingMs;
	if (minRemainingMs === void 0) return expiresAt;
	const minExpiresAt = nowMs + minRemainingMs;
	if (!Number.isSafeInteger(minExpiresAt) || timestampMsToIsoString(minExpiresAt) === void 0) return expiresAt;
	return Math.max(expiresAt, minExpiresAt);
}
function resolveExpiresAtMsFromDurationSeconds(value, opts = {}) {
	const durationMs = positiveSecondsToSafeMilliseconds(value);
	return durationMs === void 0 ? void 0 : resolveExpiresAtMsFromDurationMs(durationMs, opts);
}
function resolveExpiresAtMsFromEpochSeconds(value, opts = {}) {
	const epochMs = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) * 1e3 : positiveSecondsToSafeMilliseconds(value);
	if (epochMs === void 0) return;
	const expiresAt = epochMs - (opts.bufferMs ?? 0);
	if (!Number.isSafeInteger(expiresAt)) return;
	if (timestampMsToIsoString(expiresAt) === void 0) return;
	const maxMs = opts.maxMs;
	return maxMs === void 0 || expiresAt <= maxMs ? expiresAt : void 0;
}
function resolveExpiresAtMsFromDurationOrEpoch(value, opts = {}) {
	const parsed = parseStrictPositiveInteger(value);
	if (parsed === void 0) return;
	if (parsed < (opts.relativeSecondsThreshold ?? 1e9)) return resolveExpiresAtMsFromDurationSeconds(parsed, { nowMs: opts.nowMs });
	if (parsed < (opts.absoluteMillisecondsThreshold ?? 0xe8d4a51000)) return resolveExpiresAtMsFromEpochSeconds(parsed);
	return asDateTimestampMs(parsed);
}
//#endregion
export { MAX_DATE_TIMESTAMP_MS, MAX_TIMER_TIMEOUT_MS, MAX_TIMER_TIMEOUT_SECONDS, UNIX_EPOCH_ISO_STRING, addTimerTimeoutGraceMs, asDateTimestampMs, asFiniteNumber, asFiniteNumberInRange, asPositiveSafeInteger, asSafeIntegerInRange, clampPositiveTimerTimeoutMs, clampTimerTimeoutMs, finiteSecondsToTimerSafeMilliseconds, isFutureDateTimestampMs, nonNegativeSecondsToSafeMilliseconds, parseFiniteNumber, parseStrictFiniteNumber, parseStrictInteger, parseStrictNonNegativeInteger, parseStrictPositiveInteger, positiveSecondsToSafeMilliseconds, resolveDateTimestampMs, resolveExpiresAtMsFromDurationMs, resolveExpiresAtMsFromDurationOrEpoch, resolveExpiresAtMsFromDurationSeconds, resolveExpiresAtMsFromEpochSeconds, resolveIntegerOption, resolveNonNegativeIntegerOption, resolveOptionalIntegerOption, resolvePositiveTimerTimeoutMs, resolveTimerTimeoutMs, resolveTimestampMsToIsoString, timestampMsToIsoFileStamp, timestampMsToIsoString };
