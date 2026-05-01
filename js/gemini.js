/**
 * LLM Wiki — Gemini API Client
 * Google AI Studio REST API wrapper
 */
class GeminiClient {
  constructor() {
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
  }

  async getApiKey() {
    // Dynamic import to avoid circular deps
    const { default: db } = await import('./db.js');
    const key = await db.getSetting('apiKey');
    if (!key) throw new Error('API 키가 설정되지 않았습니다. 설정에서 입력해 주세요.');
    return key;
  }

  async generate(model, prompt, options = {}) {
    const apiKey = await this.getApiKey();
    const url = `${this.baseUrl}/${model}:generateContent?key=${apiKey}`;

    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: options.temperature ?? 0.3,
        maxOutputTokens: options.maxTokens ?? 8192,
      }
    };

    let lastError;
    const maxRetries = options.retries ?? 2;

    for (let i = 0; i <= maxRetries; i++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          const msg = err.error?.message || res.statusText;
          if (res.status === 429) {
            // Rate limit — wait and retry
            await this._sleep(2000 * (i + 1));
            lastError = new Error(`Rate limit: ${msg}`);
            continue;
          }
          throw new Error(`API 오류 (${res.status}): ${msg}`);
        }

        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('빈 응답을 받았습니다.');
        return text;
      } catch (e) {
        lastError = e;
        if (i < maxRetries) await this._sleep(1000 * (i + 1));
      }
    }
    throw lastError;
  }

  // Convenience methods
  async flash(prompt, options = {}) {
    return this.generate('gemini-2.5-flash-preview-05-20', prompt, options);
  }

  async pro(prompt, options = {}) {
    return this.generate('gemini-2.5-pro-preview-05-06', prompt, options);
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

const gemini = new GeminiClient();
export default gemini;
