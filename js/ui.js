/**
 * LLM Wiki — UI Renderer
 * 5 screens: inbox, wiki, dashboard, settings, log
 */
import db from './db.js';
import { pipeline, DEFAULT_SCHEMA } from './pipeline.js';
import { renderMarkdown } from './markdown.js';

// --- State ---
let currentPage = null; // for wiki detail view

// ============================================================
// INBOX
// ============================================================
export async function renderInbox() {
  const memos = await db.getMemos();
  const pending = memos.filter(m => m.status === 'pending');
  const done = memos.filter(m => m.status === 'done').slice(0, 10);
  const processing = memos.filter(m => m.status === 'processing');
  const errors = memos.filter(m => m.status === 'error');

  return `
    <div class="screen-header">
      <h1>📥 Inbox</h1>
      <p class="screen-subtitle">메모를 작성하면 LLM이 자동으로 위키에 통합합니다</p>
    </div>

    <div class="memo-input-wrap">
      <textarea id="memoInput" class="memo-textarea" placeholder="업무 메모를 자유롭게 작성하세요...&#10;&#10;예: 오늘 고객사 미팅에서 API 응답 지연 문제 논의. 캐시 도입 검토 필요." rows="4"></textarea>
      <div id="memoAttachment" class="memo-attachment hidden"></div>
      <div class="memo-actions">
        <label class="btn-icon" title="파일 첨부 (텍스트, PDF, 이미지)">
          📎<input type="file" id="memoFile" accept=".txt,.md,.csv,.pdf,image/*" style="display:none;">
        </label>
        <button id="btnVoice" class="btn-icon" title="음성 입력">🎤</button>
        <button id="btnAddMemo" class="btn-primary-sm">메모 추가</button>
      </div>
    </div>

    ${pending.length > 0 ? `
      <div class="memo-section">
        <div class="memo-section-header">
          <h3>⏳ 처리 대기 (${pending.length})</h3>
          <button id="btnProcessAll" class="btn-accent-sm">모두 처리</button>
        </div>
        ${pending.map(m => memoCard(m, true)).join('')}
      </div>
    ` : ''}

    ${processing.length > 0 ? `
      <div class="memo-section">
        <h3>⚙️ 처리 중...</h3>
        ${processing.map(m => memoCard(m)).join('')}
      </div>
    ` : ''}

    ${errors.length > 0 ? `
      <div class="memo-section">
        <h3>❌ 오류</h3>
        ${errors.map(m => memoCard(m, true)).join('')}
      </div>
    ` : ''}

    ${done.length > 0 ? `
      <div class="memo-section">
        <h3>✅ 최근 처리 완료</h3>
        ${done.sort((a,b)=>new Date(b.created)-new Date(a.created)).map(m => memoCard(m)).join('')}
      </div>
    ` : ''}

    <div id="progressOverlay" class="progress-overlay hidden">
      <div class="progress-card">
        <div class="spinner"></div>
        <p id="progressText">처리 중...</p>
      </div>
    </div>
  `;
}

function memoCard(memo, showActions = false) {
  const date = new Date(memo.created);
  const timeStr = date.toLocaleString('ko-KR', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  const statusIcon = { pending:'⏳', processing:'⚙️', done:'✅', error:'❌' }[memo.status];
  const preview = memo.text.length > 120 ? memo.text.slice(0, 120) + '...' : memo.text;

  return `
    <div class="memo-card ${memo.status}" data-id="${memo.id}">
      <div class="memo-card-header">
        <span class="memo-time">${timeStr}</span>
        <span class="memo-status">${statusIcon}</span>
      </div>
      <p class="memo-text">${escHtml(preview)}</p>
      ${memo.attachment ? `<div class="memo-attachment-badge">📎 ${escHtml(memo.attachment.name || '첨부파일')}</div>` : ''}
      ${memo.result?.routedTo ? `<div class="memo-routed">→ ${memo.result.routedTo.join(', ')}</div>` : ''}
      ${memo.result?.error ? `<div class="memo-error">${escHtml(memo.result.error)}</div>` : ''}
      ${showActions ? `
        <div class="memo-card-actions">
          <button class="btn-sm btn-process" data-id="${memo.id}">처리</button>
          <button class="btn-sm btn-delete-memo" data-id="${memo.id}">삭제</button>
        </div>
      ` : ''}
    </div>
  `;
}

// ============================================================
// WIKI
// ============================================================
export async function renderWiki() {
  if (currentPage) return renderWikiDetail(currentPage);

  const pages = await db.getPages();
  pages.sort((a, b) => new Date(b.updated) - new Date(a.updated));

  return `
    <div class="screen-header">
      <h1>📝 Wiki</h1>
      <p class="screen-subtitle">${pages.length}개의 위키 페이지</p>
    </div>
    <div class="wiki-grid">
      ${pages.map(p => {
        const updated = new Date(p.updated).toLocaleDateString('ko-KR');
        const contentLen = (p.content || '').length;
        return `
          <div class="wiki-card" data-slug="${p.slug}">
            <h3>${escHtml(p.title)}</h3>
            <p class="wiki-desc">${escHtml(p.description || '')}</p>
            <div class="wiki-meta">
              <span>📅 ${updated}</span>
              <span>📄 ${contentLen > 100 ? Math.round(contentLen/100)*100 + '자' : '미작성'}</span>
            </div>
            <div class="wiki-tags">${(p.tags||[]).map(t => `<span class="tag-sm">${t}</span>`).join('')}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

async function renderWikiDetail(slug) {
  const page = await db.getPage(slug);
  if (!page) { currentPage = null; return renderWiki(); }

  return `
    <div class="screen-header">
      <button id="btnBackWiki" class="btn-back">← 목록</button>
      <h1>${escHtml(page.title)}</h1>
      <div class="wiki-detail-meta">
        <span>📅 ${new Date(page.updated).toLocaleDateString('ko-KR')}</span>
        <span>🏷️ ${(page.tags||[]).join(', ')}</span>
      </div>
    </div>
    <div class="wiki-content markdown-body">
      ${renderMarkdown(page.content || '')}
    </div>
  `;
}

export function setCurrentPage(slug) { currentPage = slug; }
export function clearCurrentPage() { currentPage = null; }

// ============================================================
// CHAT
// ============================================================
export async function renderChat() {
  return `
    <div class="screen-header">
      <h1>💬 Chat</h1>
      <p class="screen-subtitle">내 업무일지(위키)를 바탕으로 질문하세요</p>
    </div>
    
    <div class="chat-container">
      <div id="chatMessages" class="chat-messages">
        <div class="chat-msg bot">
          <div class="msg-bubble">안녕하세요! 지금까지 작성하신 위키 내용을 바탕으로 답변해 드릴 수 있습니다. 궁금한 점을 물어보세요!</div>
        </div>
      </div>
      
      <div class="chat-input-wrap">
        <textarea id="chatInput" class="chat-textarea" placeholder="질문을 입력하세요... (예: A프로젝트의 진행 상황이 어떻게 돼?)" rows="2"></textarea>
        <button id="btnSendChat" class="btn-primary-sm">전송</button>
      </div>
    </div>
  `;
}

// ============================================================
// DASHBOARD
// ============================================================
export async function renderDashboard() {
  const memos = await db.getMemos();
  const pages = await db.getPages();
  const logs = await db.getLogs();

  const pending = memos.filter(m => m.status === 'pending').length;
  const totalDone = memos.filter(m => m.status === 'done').length;
  const totalPages = pages.length;
  const activePages = pages.filter(p => (p.content||'').length > 100).length;

  // Weekly activity
  const now = new Date();
  const weekDays = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dayStr = d.toLocaleDateString('ko-KR', { weekday:'short' });
    const dateStr = d.toISOString().slice(0, 10);
    const count = memos.filter(m => m.created.startsWith(dateStr)).length;
    weekDays.push({ day: dayStr, count, date: dateStr });
  }
  const maxCount = Math.max(...weekDays.map(d => d.count), 1);

  return `
    <div class="screen-header">
      <h1>📊 Dashboard</h1>
      <p class="screen-subtitle">업무일지 활동 요약</p>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${totalDone + pending}</div>
        <div class="stat-label">총 메모</div>
      </div>
      <div class="stat-card accent">
        <div class="stat-value">${pending}</div>
        <div class="stat-label">처리 대기</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${activePages}</div>
        <div class="stat-label">활성 페이지</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${logs.length}</div>
        <div class="stat-label">처리 이력</div>
      </div>
    </div>

    <div class="chart-section">
      <h3>📈 주간 메모 활동</h3>
      <div class="bar-chart">
        ${weekDays.map(d => `
          <div class="bar-col">
            <div class="bar" style="height:${Math.max((d.count / maxCount) * 100, 4)}%">
              ${d.count > 0 ? `<span class="bar-val">${d.count}</span>` : ''}
            </div>
            <span class="bar-label">${d.day}</span>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="chart-section">
      <h3>📝 위키 페이지 현황</h3>
      <div class="page-list">
        ${pages.sort((a,b) => (b.content||'').length - (a.content||'').length).map(p => {
          const len = (p.content||'').length;
          const pct = Math.min((len / 2000) * 100, 100);
          return `
            <div class="page-bar-row">
              <span class="page-bar-name">${escHtml(p.title)}</span>
              <div class="page-bar-track"><div class="page-bar-fill" style="width:${pct}%"></div></div>
              <span class="page-bar-size">${len > 0 ? Math.round(len/10)*10 + '자' : '-'}</span>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

// ============================================================
// SETTINGS
// ============================================================
export async function renderSettings() {
  const apiKey = await db.getSetting('apiKey') || '';
  const masked = apiKey ? apiKey.slice(0, 6) + '••••••' + apiKey.slice(-4) : '';

  return `
    <div class="screen-header">
      <h1>⚙️ Settings</h1>
    </div>

    <div class="settings-group">
      <h3>🔑 Google AI Studio API</h3>
      <div class="setting-row">
        <label>API Key</label>
        <div class="setting-input-wrap">
          <input id="inputApiKey" type="password" class="setting-input" placeholder="API 키 입력" value="${escHtml(apiKey)}">
          <button id="btnSaveApi" class="btn-primary-sm">저장</button>
        </div>
        ${masked ? `<p class="setting-hint">현재: ${masked}</p>` : '<p class="setting-hint">https://aistudio.google.com/apikey 에서 발급</p>'}
      </div>
    </div>

    <div class="settings-group">
      <h3>📦 데이터 관리</h3>
      <div class="setting-row">
        <label>Obsidian 마크다운 내보내기</label>
        <button id="btnExportMd" class="btn-secondary-sm">📄 내보내기</button>
      </div>
      <div class="setting-row">
        <label>전체 데이터 백업 (JSON)</label>
        <button id="btnExportJson" class="btn-secondary-sm">💾 백업</button>
      </div>
      <div class="setting-row">
        <label>데이터 복원</label>
        <input type="file" id="inputImport" accept=".json" class="setting-file">
      </div>
    </div>

    <div class="settings-group">
      <h3>🗂️ 위키 초기화</h3>
      <div class="setting-row">
        <label>기본 위키 페이지 생성 (최초 1회)</label>
        <button id="btnInitPages" class="btn-secondary-sm">📝 초기화</button>
      </div>
    </div>

    <div class="settings-group">
      <h3>🔄 앱 업데이트</h3>
      <div class="setting-row">
        <label>최신 기능 반영 (캐시 지우지 않고 새로고침)</label>
        <button id="btnForceRefresh" class="btn-secondary-sm">🔄 앱 새로고침</button>
      </div>
    </div>
  `;
}

// ============================================================
// LOG
// ============================================================
export async function renderLog() {
  const logs = await db.getLogs();

  return `
    <div class="screen-header">
      <h1>📋 Log</h1>
      <p class="screen-subtitle">파이프라인 처리 이력 (${logs.length}건)</p>
    </div>
    ${logs.length === 0 ? '<p class="empty-msg">아직 처리 이력이 없습니다.</p>' : ''}
    ${logs.map(log => {
      const time = new Date(log.timestamp).toLocaleString('ko-KR');
      const isErr = log.status === 'error';
      return `
        <div class="log-card ${isErr ? 'error' : ''}">
          <div class="log-header">
            <span>${isErr ? '❌' : '✅'} ${time}</span>
          </div>
          <p class="log-memo">${escHtml((log.memoText||'').slice(0, 150))}</p>
          ${log.updatedPages ? `<div class="log-pages">→ ${log.updatedPages.join(', ')}</div>` : ''}
          ${log.error ? `<div class="log-error">${escHtml(log.error)}</div>` : ''}
        </div>
      `;
    }).join('')}
  `;
}

// ============================================================
// Helpers
// ============================================================
function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
