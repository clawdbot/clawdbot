/**
 * Web Search keyword detection
 */

import { detectDeepResearchIntent } from "../deep-research/detect.js";

const EXPLICIT_KEYWORDS = [
  "погуглить", "погугли", "загугли", "загуглить",
  "поискать", "найди", "найти", "искать",
  "гугл", "поиск", "веб поиск", "вебпоиск",
  "web search", "search the web", "search online",
  "look up", "google"
];

const CONTEXTUAL_PATTERNS = [
  /погода|weather|температура|temperature/i,
  /новости|news|события|events/i,
  /что такое|who is|what is|где|where|когда|when|как|how/i,
  /текущий|current|сейчас|now|сегодня|today/i,
];

/**
 * Detect if message contains web search intent
 * Returns false if deep research intent detected (deep research takes priority)
 */
export function detectWebSearchIntent(
  message: string,
  customPatterns?: readonly (string | RegExp)[]
): boolean {
  const normalized = message.toLowerCase().trim();
  
  // Priority 1: If deep research detected, no web search
  if (detectDeepResearchIntent(normalized)) {
    return false;
  }
  
  // Priority 2: Custom patterns from config
  if (customPatterns) {
    for (const pattern of customPatterns) {
      if (typeof pattern === 'string') {
        if (normalized.includes(pattern.toLowerCase())) {
          return true;
        }
      } else if (pattern instanceof RegExp) {
        if (pattern.test(normalized)) {
          return true;
        }
      }
    }
  }
  
  // Priority 3: Explicit keywords (simple includes check)
  for (const keyword of EXPLICIT_KEYWORDS) {
    if (normalized.includes(keyword.toLowerCase())) {
      return true;
    }
  }
  
  // Priority 4: Contextual patterns
  for (const pattern of CONTEXTUAL_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }
  
  // Priority 5: High-confidence topics with question words
  // Only trigger if both question word and topic appear early in message (first 30 chars)
  const questionWords = ["что", "кто", "где", "когда", "как"];
  const topics = ["погода", "weather", "новости", "news", "курс", "price"];
  
  const hasQuestion = questionWords.some(w => {
    const parts = normalized.split(/\s+/);
    // Check first 3 words
    return parts.slice(0, 3).some(part => part.includes(w));
  });
  const hasTopic = topics.some(t => normalized.includes(t));
  
  if (hasQuestion && hasTopic) {
    return true;
  }
  
  return false;
}

/**
 * Extract clean search query from message
 */
export function extractSearchQuery(message: string): string {
  let query = message.toLowerCase();
  const originalQuery = query;
  
  // Remove explicit keywords
  const keywordsToRemove = [...EXPLICIT_KEYWORDS];
  // Add more action words
  keywordsToRemove.push('найди', 'найти', 'искать', 'поискать', 'загрузи');
  
  // Do multiple passes to catch all
  for (let pass = 0; pass < 3; pass++) {
    for (const keyword of keywordsToRemove) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
      query = query.replace(regex, '');
    }
    
    // Remove polite words
    const politeWords = ['пожалуйста', 'плиз', 'пж', 'спасибо'];
    for (const word of politeWords) {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      query = query.replace(regex, '');
    }
    
    // Remove prepositions and connecting words
    query = query.replace(/\b(про|по|о|на тему|и|или|да|нет)\b/gi, '');
    
    // Remove disfluencies
    const disfluencies = ['эм', 'ну', 'типа', 'значит', 'короче', 'в общем', 'ну'];
    for (const word of disfluencies) {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      query = query.replace(regex, '');
    }
    
    query = query.replace(/\s+/g, ' ').trim();
  }
  
  // Clean whitespace and punctuation (leading/trailing)
  query = query.replace(/^[:,.!\-\—]+/, '').trim();
  query = query.replace(/[:,.!\-\—]+$/, '').trim();
  
  return query || originalQuery; // Fallback to original (lowercased) if empty
}

/**
 * Get default patterns for testing/config
 */
export function getWebSearchPatterns() {
  return {
    explicit: EXPLICIT_KEYWORDS,
    contextual: CONTEXTUAL_PATTERNS.map(p => p.source)
  };
}
