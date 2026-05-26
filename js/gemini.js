/**
 * LLM Wiki — Gemini API Client
 * Google AI Studio REST API wrapper
 */
class GeminiClient {
  constructor() {
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
    this.onRateLimit = null; // callback(message) for rate limit UI feedback
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

    const parts = [{ text: prompt }];
    
    // 호환성 유지 및 다중 첨부파일 지원
    const attachments = options.attachments || (options.attachment ? [options.attachment] : []);
    
    if (attachments.length > 0) {
      for (const att of attachments) {
        parts.push({
          inlineData: {
            mimeType: att.mimeType,
            data: att.data
          }
        });
      }
    }

    const body = {
      contents: [{ parts: parts }],
      generationConfig: {
        temperature: options.temperature ?? 0.3,
        maxOutputTokens: options.maxTokens ?? 8192,
      }
    };

    if (options.json) {
      body.generationConfig.responseMimeType = "application/json";
    }

    let lastError;
    const maxRetries = options.retries ?? 3;

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
            // 에러 메시지에서 "retry in Xs" 파싱
            const match = msg.match(/retry in ([0-9.]+)s/i);
            const waitSec = match ? Math.ceil(parseFloat(match[1])) + 2 : 60;
            this._emit429(`⏳ API 한도 초과 — ${waitSec}초 후 재시도...`);
            await this._sleep(waitSec * 1000);
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
    return this.generate('gemini-2.5-flash', prompt, options);
  }

  async pro(prompt, options = {}) {
    // 무료 티어 Pro 한도 초과(Limit: 0) 문제로 인해 Flash 모델로 대체
    return this.generate('gemini-2.5-flash', prompt, options);
  }

  _emit429(msg) {
    if (this.onRateLimit) this.onRateLimit(msg);
    else console.warn(msg);
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

const gemini = new GeminiClient();
export default gemini;
