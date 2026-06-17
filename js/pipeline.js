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
    this.processingPages = new Set(); // 동시에 같은 페이지 처리 방지
    this.onProgress = null; // callback(step, detail)
  }

  getSchema() {
    return DEFAULT_SCHEMA;
  }

  // --- 1. Routing ---
  async route(memoText, attachments = []) {
    this._emit('route', '관련 페이지를 찾는 중...');

    const pages = await db.getPages();
    const schemaDesc = pages.map(p =>
      `- slug: "${p.slug}" | title: "${p.title}" | desc: "${p.description}"`
    ).join('\n');

    let prompt = `당신은 위키 라우터입니다. 아래의 메모를 읽고, 관련 있는 위키 페이지의 slug를 JSON 배열로 반환하세요.
최소 1개, 최대 3개의 관련 페이지를 선택하세요.
기존 페이지에 맞지 않으면 가장 가까운 것을 선택하세요.

위키 페이지 목록:
${schemaDesc}

메모:
${memoText}`;

    if (attachments.length > 0) {
      prompt += `\n\n[주의: 첨부파일 데이터도 함께 제공되었습니다. 텍스트와 첨부파일을 모두 고려하여 적절한 위키 페이지를 선택하세요.]`;
    }

    // json 모드 제거: Gemini가 배열 대신 객체를 반환하면 파싱 실패하여 항상 daily-work 폴백되는 버그 수정
    const options = { temperature: 0.1, maxTokens: 512 };
    if (attachments.length > 0) options.attachments = attachments;

    const raw = await gemini.flash(prompt, options);
    try {
      // 마크다운 코드블록 제거 후 JSON 배열 추출
      const cleaned = raw.replace(/```json?\n?/gi, '').replace(/```/g, '').trim();

      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        // 응답 내 JSON 배열 패턴 직접 추출
        const match = cleaned.match(/\[[\s\S]*?\]/);
        if (match) parsed = JSON.parse(match[0]);
        else throw new Error('JSON 배열 없음');
      }

      // 배열 또는 객체({"pages":[...]} 등) 모두 처리
      const arr = Array.isArray(parsed)
        ? parsed
        : Object.values(parsed).find(v => Array.isArray(v)) || [];

      const validSlugs = arr.filter(s => typeof s === 'string' && s.trim());
      return validSlugs.length > 0 ? validSlugs : ['daily-work'];
    } catch (e) {
      console.warn('라우팅 파싱 실패, 기본값 사용:', raw, e);
      return ['daily-work'];
    }
  }

  // --- 2. Synthesis ---
  async synthesize(page, memoText, attachments = []) {
    this._emit('synthesize', `"${page.title}" 페이지 업데이트 중...`);

    const now = new Date();
    const dateStr = now.toLocaleDateString('ko-KR', { year:'numeric', month:'2-digit', day:'2-digit' });
    const timeStr = now.toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit' });

    // 현재 위키 slug 목록 → 링크 힌트 제공
    const pages = await db.getPages();
    const otherSlugs = pages.filter(p => p.slug !== page.slug).map(p => `${p.slug} (${p.title})`).join(', ');

    let prompt = `당신은 개인 위키 편집자입니다. 기존 위키 페이지에 새로운 메모 내용을 통합하여 문서를 재작성하세요.

## 절대 지켜야 할 규칙 (위반 시 매우 심각한 문제 발생)
1. **기존 정보를 절대 삭제하거나 압축하지 마세요** — 모든 기존 내용을 그대로 유지하고 새 내용을 추가합니다
2. **"아직 내용이 없습니다" 같은 플레이스홀더 문구를 절대 포함하지 마세요** — 실제 내용만 작성하세요
3. **출력 결과는 기존 페이지 내용보다 반드시 길어야 합니다** — 요약이나 압축은 금지입니다
4. 새로운 정보를 논리적으로 적절한 위치에 자연스럽게 통합하세요
5. 날짜와 시간 맥락을 보존하세요 (오늘: ${dateStr} ${timeStr})
6. 마크다운 형식을 유지하세요 (제목, 목록, 강조 등)
7. 모순되는 정보가 있으면 양쪽을 모두 기록하고 주석을 다세요
8. 페이지 제목(# 헤더)은 유지하세요
9. **위키링크 규칙**: 다른 위키 페이지와 관련된 내용이 있을 때 반드시 [[slug]] 형식으로 링크를 삽입하세요
   - 예: 프로젝트 관련 내용 → [[projects]], 할 일 관련 → [[tasks]], 학습 내용 → [[learnings]]
   - 사용 가능한 slug 목록: ${otherSlugs}
   - 자연스러운 문장 내에 삽입하세요 (예: "[[projects]] 페이지에도 기록됨")

## 기존 위키 페이지 (이 내용을 기반으로 확장하세요)
${page.content}

## 새로운 메모 (${dateStr} ${timeStr} 작성) — 위 내용에 통합해야 합니다
${memoText}`;

    if (attachments.length > 0) {
      prompt += `\n\n[주의: 첨부파일 데이터가 함께 제공되었습니다. 첨부파일의 내용도 상세히 분석하여 위키에 알맞게 통합하세요.]`;
    }

    prompt += `\n\n## 출력\n통합된 위키 페이지 전체를 마크다운으로 출력하세요 (프론트매터 없이, 본문만):`;

    const options = { temperature: 0.3, maxTokens: 4096 };
    if (attachments.length > 0) options.attachments = attachments;

    return await gemini.pro(prompt, options);
  }


  // --- Full Pipeline ---
  async process(memoId) {
    if (this.isProcessing) {
      console.warn('[Pipeline] isProcessing 플래그 강제 해제 후 재시도');
      this.isProcessing = false; // 락 해제 후 진행 (이전 처리가 비정상 종료된 경우 대비)
    }
    this.isProcessing = true;

    const memo = await db.getMemo(memoId);
    if (!memo) throw new Error('메모를 찾을 수 없습니다.');

    // 이미 완료된 메모 재처리 경고 (실수로 덮어쓰는 것 방지)
    if (memo.status === 'done') {
      console.warn(`[Pipeline] 메모 ${memoId}는 이미 처리 완료 상태입니다. 재처리합니다.`);
    }

    memo.status = 'processing';
    await db.updateMemo(memo);

    const logEntry = { memoId, memoText: memo.text, steps: [] };

    try {
      // 이제 OCR은 업로드 시점에 완료 → pipeline에서는 빈 첨부파일로 처리
      const attachments = [];
      // Step 1: Route
      const slugs = await this.route(memo.text, attachments);
      logEntry.steps.push({ step: 'route', result: slugs });
      console.log('[Pipeline] 라우팅 결과:', slugs);

      // Step 2: Synthesize each page
      const updatedPages = [];
      const skippedPages = [];
      for (const slug of slugs) {
        // 같은 slug가 이미 처리 중이면 스킵 (동시 처리 방지)
        if (this.processingPages.has(slug)) {
          console.warn(`[Pipeline] ${slug} 페이지가 이미 처리 중이어서 스킵합니다.`);
          continue;
        }
        this.processingPages.add(slug);

        try {
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

          const prevContent = page.content || '';
          console.log(`[Pipeline] ${slug} 합성 시작 (기존 ${prevContent.length}자)`);
          const newContent = await this.synthesize(page, memo.text, attachments);
          console.log(`[Pipeline] ${slug} 합성 완료 (결과 ${newContent?.length ?? 0}자)`);

          // 안전장치: 합성 결과가 비어있으면 저장하지 않음
          if (!newContent || newContent.trim().length === 0) {
            const reason = 'empty_result';
            console.error(`[Pipeline] ${slug} 합성 결과가 비어있습니다. 기존 내용 보존.`);
            logEntry.steps.push({ step: 'synthesize', page: slug, success: false, reason });
            skippedPages.push(`${slug}(빈 결과)`);
            continue;
          }

          // 안전장치: 기존 내용(200자+)보다 합성 결과가 50% 미만이면 경고 후 보존
          // (기존 20% 임계값이 너무 엄격하여 정상 결과도 차단하는 버그 수정)
          if (prevContent.length > 200 && newContent.trim().length < prevContent.length * 0.5) {
            const reason = 'content_too_short';
            console.error(`[Pipeline] ${slug} 합성 결과(${newContent.length}자)가 기존 내용(${prevContent.length}자)의 50% 미만입니다. 기존 내용 보존.`);
            logEntry.steps.push({ step: 'synthesize', page: slug, success: false, reason,
              prevLen: prevContent.length, newLen: newContent.length });
            skippedPages.push(`${slug}(결과 너무 짧음: ${newContent.length}/${prevContent.length}자)`);
            continue;
          }

          page.content = newContent;
          await db.savePage(page);
          console.log(`[Pipeline] ${slug} 저장 완료`);

          // GitHub 자동 동기화 (실패해도 앱 흐름은 중단하지 않음)
          try {
            await github.syncPage(slug, newContent);
          } catch (e) {
            console.warn(`GitHub 자동 동기화 실패 (${slug}):`, e);
          }

          updatedPages.push(slug);
          logEntry.steps.push({ step: 'synthesize', page: slug, success: true,
            prevLen: prevContent.length, newLen: newContent.length });
        } catch (pageErr) {
          // 개별 페이지 처리 실패 → 로그 남기고 다음 페이지 계속 처리
          console.error(`[Pipeline] ${slug} 처리 중 오류:`, pageErr);
          logEntry.steps.push({ step: 'synthesize', page: slug, success: false,
            reason: 'error', error: pageErr.message });
          skippedPages.push(`${slug}(오류: ${pageErr.message})`);
        } finally {
          this.processingPages.delete(slug);
        }
      }

      // Step 3: Update memo status
      memo.status = 'done';
      memo.result = { routedTo: slugs, updatedPages, skippedPages, completedAt: new Date().toISOString() };
      await db.updateMemo(memo);

      // Step 4: Log
      logEntry.status = 'success';
      logEntry.updatedPages = updatedPages;
      if (skippedPages.length > 0) logEntry.skippedPages = skippedPages;
      await db.addLog(logEntry);

      const msg = updatedPages.length > 0
        ? `${updatedPages.length}개 페이지 업데이트 완료`
        : `처리 완료 (저장된 페이지 없음${skippedPages.length > 0 ? ' — ' + skippedPages.join(', ') : ''})`;
      this._emit('done', msg);
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
      this.processingPages.clear(); // 비정상 종료 시에도 락 해제
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
