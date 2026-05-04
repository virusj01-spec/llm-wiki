/**
 * LLM Wiki — Ingest Pipeline
 * Route → Synthesize → Save → Log
 */
import db from './db.js';
import gemini from './gemini.js';
import github from './github.js';

const DEFAULT_SCHEMA = {
  pages: [
    { slug: "daily-work", title: "일일 업무 기록", description: "일상적인 업무 활동, 회의, 작업 내용", tags: ["daily", "work", "meeting"] },
    { slug: "projects", title: "프로젝트 관리", description: "진행 중인 프로젝트, 마일스톤, 이슈", tags: ["project", "milestone", "issue"] },
    { slug: "ideas", title: "아이디어 & 인사이트", description: "새로운 아이디어, 영감, 개선 제안", tags: ["idea", "insight", "improvement"] },
    { slug: "learnings", title: "학습 & 기술 노트", description: "새로 배운 것, 기술 메모, 참고 자료", tags: ["learning", "tech", "reference"] },
    { slug: "people", title: "사람 & 커뮤니케이션", description: "동료, 고객, 미팅 참석자 관련 메모", tags: ["people", "communication", "contact"] },
    { slug: "tasks", title: "할 일 & 체크리스트", description: "해야 할 일, 마감일, 우선순위", tags: ["todo", "deadline", "priority"] },
    { slug: "issues", title: "문제 & 해결", description: "발생한 문제, 버그, 해결 과정", tags: ["issue", "bug", "solution"] },
    { slug: "reflection", title: "회고 & 성찰", description: "업무 회고, 자기 평가, 목표 점검", tags: ["reflection", "review", "goal"] }
  ]
};

class Pipeline {
  constructor() {
    this.isProcessing = false;
    this.onProgress = null; // callback(step, detail)
  }

  getSchema() {
    return DEFAULT_SCHEMA;
  }

  // --- 1. Routing ---
  async route(memoText, attachment) {
    this._emit('route', '관련 페이지를 찾는 중...');

    const pages = await db.getPages();
    const schemaDesc = pages.map(p =>
      `- slug: "${p.slug}" | title: "${p.title}" | desc: "${p.description}"`
    ).join('\\n');

    let prompt = `당신은 위키 라우터입니다. 아래의 메모를 읽고, 관련 있는 위키 페이지의 slug를 JSON 배열로 반환하세요.
최소 1개, 최대 3개의 관련 페이지를 선택하세요.
기존 페이지에 맞지 않으면 가장 가까운 것을 선택하세요.

위키 페이지 목록:
${schemaDesc}

메모:
${memoText}`;

    if (attachment) {
      prompt += `\\n\\n[주의: 첨부파일 데이터도 함께 제공되었습니다. 텍스트와 첨부파일을 모두 고려하여 적절한 위키 페이지를 선택하세요.]`;
    }

    const options = { temperature: 0.1, maxTokens: 256, json: true };
    if (attachment) options.attachment = attachment;

    const raw = await gemini.flash(prompt, options);
    try {
      // JSON 모드 시 바로 파싱 가능성이 높지만 방어적 파싱
      const cleaned = raw.replace(/```json?\\n?/gi, '').replace(/```/g, '').trim();
      const slugs = JSON.parse(cleaned);
      if (!Array.isArray(slugs)) throw new Error('배열이 아닙니다');
      
      const validSlugs = slugs.filter(s => typeof s === 'string');
      return validSlugs.length > 0 ? validSlugs : ['daily-work'];
    } catch (e) {
      console.warn('라우팅 파싱 실패, 기본값 사용:', raw, e);
      return ['daily-work'];
    }
  }

  // --- 2. Synthesis ---
  async synthesize(page, memoText, attachment) {
    this._emit('synthesize', `"${page.title}" 페이지 업데이트 중...`);

    const now = new Date();
    const dateStr = now.toLocaleDateString('ko-KR', { year:'numeric', month:'2-digit', day:'2-digit' });
    const timeStr = now.toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit' });

    let prompt = `당신은 개인 위키 편집자입니다. 기존 위키 페이지에 새로운 메모 내용을 통합하여 문서를 재작성하세요.

## 규칙
1. 기존 정보를 절대 삭제하지 마세요 (Preserve and Extend)
2. 새로운 정보를 논리적으로 적절한 위치에 자연스럽게 통합하세요
3. 날짜와 시간 맥락을 보존하세요 (오늘: ${dateStr} ${timeStr})
4. 마크다운 형식을 유지하세요 (제목, 목록, 강조 등)
5. 모순되는 정보가 있으면 양쪽을 모두 기록하고 주석을 다세요
6. 페이지 제목(# 헤더)은 유지하세요

## 기존 위키 페이지
${page.content}

## 새로운 메모 (${dateStr} ${timeStr} 작성)
${memoText}`;

    if (attachment) {
      prompt += `\\n\\n[주의: 첨부파일 데이터가 함께 제공되었습니다. 첨부파일의 내용도 상세히 분석하여 위키에 알맞게 통합하세요.]`;
    }

    prompt += `\\n\\n## 출력\\n통합된 위키 페이지 전체를 마크다운으로 출력하세요 (프론트매터 없이, 본문만):`;

    const options = { temperature: 0.3, maxTokens: 4096 };
    if (attachment) options.attachment = attachment;

    return await gemini.pro(prompt, options);
  }

  // --- Full Pipeline ---
  async process(memoId) {
    if (this.isProcessing) throw new Error('이미 처리 중인 작업이 있습니다.');
    this.isProcessing = true;

    const memo = await db.getMemo(memoId);
    if (!memo) throw new Error('메모를 찾을 수 없습니다.');

    memo.status = 'processing';
    await db.updateMemo(memo);

    const logEntry = { memoId, memoText: memo.text, steps: [] };

    try {
      // Step 1: Route
      const slugs = await this.route(memo.text, memo.attachment);
      logEntry.steps.push({ step: 'route', result: slugs });

      // Step 2: Synthesize each page
      const updatedPages = [];
      for (const slug of slugs) {
        let page = await db.getPage(slug);
        if (!page) {
          page = {
            slug,
            title: slug,
            description: '',
            tags: [],
            content: `# ${slug}\n\n`,
            created: new Date().toISOString()
          };
        }

        const newContent = await this.synthesize(page, memo.text, memo.attachment);
        page.content = newContent;
        await db.savePage(page);

        // GitHub 자동 동기화 (실패해도 앱 흐름은 중단하지 않음)
        try {
          await github.syncPage(slug, newContent);
        } catch (e) {
          console.warn(`GitHub 자동 동기화 실패 (${slug}):`, e);
        }

        updatedPages.push(slug);
        logEntry.steps.push({ step: 'synthesize', page: slug, success: true });
      }

      // Step 3: Update memo status
      memo.status = 'done';
      memo.result = { routedTo: slugs, updatedPages };
      await db.updateMemo(memo);

      // Step 4: Log
      logEntry.status = 'success';
      logEntry.updatedPages = updatedPages;
      await db.addLog(logEntry);

      this._emit('done', `${updatedPages.length}개 페이지 업데이트 완료`);
      return logEntry;

    } catch (err) {
      memo.status = 'error';
      memo.result = { error: err.message };
      await db.updateMemo(memo);

      logEntry.status = 'error';
      logEntry.error = err.message;
      await db.addLog(logEntry);

      this._emit('error', err.message);
      throw err;
    } finally {
      this.isProcessing = false;
    }
  }

  // Process all pending memos
  async processAll() {
    const pending = await db.getPendingMemos();
    const results = [];
    for (const memo of pending) {
      try {
        const r = await this.process(memo.id);
        results.push(r);
      } catch (e) {
        results.push({ memoId: memo.id, error: e.message });
      }
    }
    return results;
  }

  _emit(step, detail) {
    if (this.onProgress) this.onProgress(step, detail);
  }
}

const pipeline = new Pipeline();
export { pipeline, DEFAULT_SCHEMA };
