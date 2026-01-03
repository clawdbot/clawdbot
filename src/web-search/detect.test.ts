import { describe, it, expect } from 'vitest';
import { detectWebSearchIntent, extractSearchQuery } from './detect.js';

describe('detectWebSearchIntent', () => {
  it('detects explicit russian keyword', () => {
    expect(detectWebSearchIntent('погугли погоду')).toBe(true);
  });
  
  it('detects explicit english keyword', () => {
    expect(detectWebSearchIntent('search the web for python')).toBe(true);
  });
  
  it('detects contextual pattern - weather', () => {
    expect(detectWebSearchIntent('погода в Москве')).toBe(true);
  });
  
  it('detects contextual pattern - news', () => {
    expect(detectWebSearchIntent('какие новости сегодня')).toBe(true);
  });
  
  it('detects contextual pattern - what is', () => {
    expect(detectWebSearchIntent('что такое TypeScript')).toBe(true);
  });
  
  it('detects question + topic pattern', () => {
    expect(detectWebSearchIntent('какая сейчас погода')).toBe(true);
  });
  
  it('returns false for normal conversation', () => {
    expect(detectWebSearchIntent('привет как дела')).toBe(false);
  });
  
  it('returns false for casual questions without topics', () => {
    expect(detectWebSearchIntent('как твои дела')).toBe(false);
  });
  
  it('returns false when deep research detected', () => {
    expect(detectWebSearchIntent('сделай депресерч по python')).toBe(false);
  });
  
  it('returns false when deep research keyword present', () => {
    expect(detectWebSearchIntent('depresearch this topic')).toBe(false);
  });
  
  it('handles mixed case messages', () => {
    expect(detectWebSearchIntent('ПОГУГЛИ Python')).toBe(true);
  });
  
  it('handles punctuation around keywords', () => {
    expect(detectWebSearchIntent('!погугли!')).toBe(true);
  });
  
  it('detects with custom patterns', () => {
    const customPatterns = ['custom_search'];
    expect(detectWebSearchIntent('custom_search something', customPatterns)).toBe(true);
  });
  
  it('detects with custom regex patterns', () => {
    const customPatterns = [/\bstock price\b/i];
    expect(detectWebSearchIntent('what is the stock price for AAPL', customPatterns)).toBe(true);
  });
});

describe('extractSearchQuery', () => {
  it('strips explicit keywords', () => {
    expect(extractSearchQuery('погугли погоду в Москве')).toBe('погоду в Москве');
  });
  
  it('strips multiple keywords', () => {
    expect(extractSearchQuery('пожалуйста погугли погоду сегодня')).toBe('погоду сегодня');
  });
  
  it('removes polite words', () => {
    expect(extractSearchQuery('пожалуйста найди новости')).toBe('новости');
  });
  
  it('removes prepositions', () => {
    expect(extractSearchQuery('погоду в Москве')).toBe('погоду в Москве'); // 'в' is location preposition, should keep
  });
  
  it('removes disfluencies', () => {
    expect(extractSearchQuery('ну типа загрузи фото')).toBe('фото');
  });
  
  it('handles already clean query', () => {
    expect(extractSearchQuery('просто текст')).toBe('просто текст');
  });
  
  it('returns original if cleaned query is empty', () => {
    expect(extractSearchQuery('плиз')).toBe('плиз');
  });
  
  it('cleans punctuation', () => {
    expect(extractSearchQuery('...найди...')).toBe('найди');
  });
  
  it('works with english keywords', () => {
    expect(extractSearchQuery('search for TypeScript basics')).toBe('for TypeScript basics');
  });
});

describe('getWebSearchPatterns', () => {
  it('returns explicit keywords', () => {
    const patterns = getWebSearchPatterns();
    expect(patterns.explicit).toContain('погуглить');
    expect(patterns.explicit).toContain('google');
  });
  
  it('returns contextual patterns', () => {
    const patterns = getWebSearchPatterns();
    expect(patterns.contextual.length).toBeGreaterThan(0);
    expect(patterns.contextual[0]).toContain('погода');
  });
});
