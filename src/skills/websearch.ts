export interface SearchResult {
  title: string;
  snippet: string;
  link: string;
}

/**
 * OpenClaw Skill: Free Web Search Fallback
 * Built with native Node.js fetch and ESM syntax.
 */
export async function freeWebSearch(query: string): Promise<SearchResult[]> {
  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    
    const response = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const html = await response.text();
    const results: SearchResult[] = [];

    // Parse HTML snippets using regex without extra DOM parsing libraries
    const resultBlockRegex = /<a class="result__snippet"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    let match: RegExpExecArray | null;

    while ((match = resultBlockRegex.exec(html)) !== null && results.length < 5) {
      const link = match[1]?.trim() || '';
      const rawSnippet = match[2] || '';
      
      // Clean HTML tags and entities
      const cleanSnippet = rawSnippet
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();

      if (cleanSnippet) {
        results.push({
          title: `Search result for: ${query}`,
          snippet: cleanSnippet,
          link: link,
        });
      }
    }

    return results;
  } catch (error) {
    console.error('[OpenClaw Skill Error] Free Web Search failed:', error);
    return [];
  }
}