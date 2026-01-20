/**
 * Shared fuzzy filtering utilities for select list components.
 */

/**
 * Word boundary characters for matching.
 */
const WORD_BOUNDARY_CHARS = /[\s\-_./:#@]/;

/**
 * Check if position is at a word boundary.
 */
export function isWordBoundary(text: string, index: number): boolean {
	return index === 0 || WORD_BOUNDARY_CHARS.test(text[index - 1] ?? "");
}

/**
 * Find index where query matches at a word boundary in text.
 * Returns null if no match.
 */
export function findWordBoundaryIndex(text: string, query: string): number | null {
	if (!query) return null;
	const textLower = text.toLowerCase();
	const queryLower = query.toLowerCase();
	const maxIndex = textLower.length - queryLower.length;
	if (maxIndex < 0) return null;
	for (let i = 0; i <= maxIndex; i++) {
		if (textLower.startsWith(queryLower, i) && isWordBoundary(textLower, i)) {
			return i;
		}
	}
	return null;
}

/**
 * Fuzzy match with pre-lowercased inputs (avoids toLowerCase on every keystroke).
 * Returns score (lower = better) or null if no match.
 */
export function fuzzyMatchLower(queryLower: string, textLower: string): number | null {
	if (queryLower.length === 0) return 0;
	if (queryLower.length > textLower.length) return null;

	let queryIndex = 0;
	let score = 0;
	let lastMatchIndex = -1;
	let consecutiveMatches = 0;

	for (let i = 0; i < textLower.length && queryIndex < queryLower.length; i++) {
		if (textLower[i] === queryLower[queryIndex]) {
			const isAtWordBoundary = isWordBoundary(textLower, i);
			if (lastMatchIndex === i - 1) {
				consecutiveMatches++;
				score -= consecutiveMatches * 5; // Reward consecutive matches
			} else {
				consecutiveMatches = 0;
				if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2; // Penalize gaps
			}
			if (isAtWordBoundary) score -= 10; // Reward word boundary matches
			score += i * 0.1; // Slight penalty for later matches
			lastMatchIndex = i;
			queryIndex++;
		}
	}
	return queryIndex < queryLower.length ? null : score;
}

/**
 * Filter items using pre-lowercased searchTextLower field.
 * Supports space-separated tokens (all must match).
 */
export function fuzzyFilterLower<T extends { searchTextLower?: string }>(
	items: T[],
	queryLower: string,
): T[] {
	const trimmed = queryLower.trim();
	if (!trimmed) return items;

	const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length === 0) return items;

	const results: { item: T; score: number }[] = [];
	for (const item of items) {
		const text = item.searchTextLower ?? "";
		let totalScore = 0;
		let allMatch = true;
		for (const token of tokens) {
			const score = fuzzyMatchLower(token, text);
			if (score !== null) {
				totalScore += score;
			} else {
				allMatch = false;
				break;
			}
		}
		if (allMatch) results.push({ item, score: totalScore });
	}
	results.sort((a, b) => a.score - b.score);
	return results.map((r) => r.item);
}

/**
 * Prepare items for fuzzy filtering by pre-computing lowercase search text.
 */
export function prepareSearchItems<T extends { label?: string; description?: string; searchText?: string }>(
	items: T[],
): (T & { searchTextLower: string })[] {
	return items.map((item) => {
		const parts: string[] = [];
		if (item.label) parts.push(item.label);
		if (item.description) parts.push(item.description);
		if (item.searchText) parts.push(item.searchText);
		return { ...item, searchTextLower: parts.join(" ").toLowerCase() };
	});
}
