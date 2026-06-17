/**
 * LLM Wiki — App Controller
 */
import db from './db.js';
import { pipeline, DEFAULT_SCHEMA } from './pipeline.js';
import * as UI from './ui.js';
import github from './github.js';
import gemini from './gemini.js';


let activeTab = 'inbox';

// ============================================================
// Init
// ============================================================
async function init() {
  await db.init();

  // Init default pages if empty
  const pages = await db.getPages();
  if (pages.length === 0) {
    await db.initDefaultPages(DEFAULT_SCHEMA);
  }

  bindTabNav();
  await navigate('inbox');

  // Register SW
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ============================================================
// Navigation
// ============================================================
function bindTabNav() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.tab));
  });
}

async function navigate(tab) {
  activeTab = tab;

  // Update tab UI
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  const main = document.getElementById('mainContent');
  main.classList.add('fade-out');
  await sleep(150);

  let html = '';
  switch(tab) {
    case 'inbox': html = await UI.renderInbox(); break;
    case 'wiki': html = await UI.renderWiki(); break;
    case 'chat': html = await UI.renderChat(); break;
    case 'dashboard': html = await UI.renderDashboard(); break;
    case 'settings': html = await UI.renderSettings(); break;
    case 'log': html = await UI.renderLog(); break;
    case 'graph': html = await UI.renderGraph(); break;
  }
  main.innerHTML = html;
  main.classList.remove('fade-out');

  bindScreenEvents(tab);

  // 그래프는 DOM 삽입 후 별도로 D3 마운트
  if (tab === 'graph') {
    await UI.mountGraph((slug) => {
      UI.setCurrentPage(slug);
      navigate('wiki');
    });
  }
}

// ============================================================
// Screen Events
// ============================================================
function bindScreenEvents(tab) {
  switch(tab) {
    case 'inbox': bindInboxEvents(); break;
    case 'wiki': bindWikiEvents(); break;
    case 'chat': bindChatEvents(); break;
    case 'settings': bindSettingsEvents(); break;
  }
}

function bindInboxEvents() {
  const btn = document.getElementById('btnAddMemo');
  const input = document.getElementById('memoInput');
  const fileInput = document.getElementById('memoFile');

  let pendingAttachmentIds = [];

  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      if (files.length === 0) return;

      for (const file of files) {
        if (file.name.endsWith('.txt') || file.name.endsWith('.md') || file.name.endsWith('.csv')) {
          const text = await file.text();
          input.value = (input.value ? input.value + '\n\n' : '') + `[문서: ${file.name}]\n${text}`;

        } else if (file.type.startsWith('image/') || file.type === 'application/pdf') {
          showToast(`📷 ${file.name} 분석 중...`);
          try {
            const arrayBuffer = await file.arrayBuffer();

            // ① 원본 파일을 별도 스토어에 저장 (메모 객체와 분리)
            const saved = await db.addAttachment({ name: file.name, mimeType: file.type, data: arrayBuffer });
            pendingAttachmentIds.push(saved.id);

            // ② base64 변환 후 Gemini OCR
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 8192) {
              binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            }
            const base64 = btoa(binary);

            const { default: gemini } = await import('./gemini.js');
            const ocrText = await gemini.generate('gemini-2.5-flash',
              `이 ${file.type.startsWith('image/') ? '이미지' : 'PDF'}의 내용을 최대한 상세히 텍스트로 추출하고 설명하세요.\n표, 수식, 도표가 있으면 마크다운 형식으로 변환하세요.\n파일명: ${file.name}`,
              { temperature: 0.1, maxTokens: 2048, attachments: [{ mimeType: file.type, data: base64 }] }
            );

            input.value = (input.value ? input.value + '\n\n' : '') + `[📎 ${file.name} — OCR 결과]\n${ocrText}`;
            showToast(`✅ ${file.name} 분석 완료`);

          } catch (err) {
            showToast(`❌ ${file.name} 분석 실패: ${err.message}`);
          }

        } else {
          showToast(`지원하지 않는 파일 형식입니다: ${file.name}`);
        }
      }
      fileInput.value = '';
    });
  }

  if (btn && input) {
    btn.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text && pendingAttachmentIds.length === 0) return;
      await db.addMemo(text, pendingAttachmentIds);
      input.value = '';
      pendingAttachmentIds = [];
      await navigate('inbox');
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.ctrlKey) btn.click();
    });
  }

  // Voice input
  const btnVoice = document.getElementById('btnVoice');
  if (btnVoice && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    btnVoice.addEventListener('click', () => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognition = new SR();
      recognition.lang = 'ko-KR';
      recognition.continuous = false;
      recognition.interimResults = false;

      btnVoice.textContent = '🔴';
      btnVoice.disabled = true;

      recognition.onresult = (e) => {
        const text = e.results[0][0].transcript;
        input.value = (input.value ? input.value + '\n' : '') + text;
        btnVoice.textContent = '🎤';
        btnVoice.disabled = false;
      };
      recognition.onerror = () => {
        btnVoice.textContent = '🎤';
        btnVoice.disabled = false;
      };
      recognition.onend = () => {
        btnVoice.textContent = '🎤';
        btnVoice.disabled = false;
      };
      recognition.start();
    });
  } else if (btnVoice) {
    btnVoice.style.display = 'none';
  }

  // Process single
  document.querySelectorAll('.btn-process').forEach(btn => {
    btn.addEventListener('click', (e) => processMemo(e.target.dataset.id));
  });

  // Process all
  const btnAll = document.getElementById('btnProcessAll');
  if (btnAll) btnAll.addEventListener('click', processAllMemos);

  // Delete memo
  document.querySelectorAll('.btn-delete-memo').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      await db.deleteMemo(e.target.dataset.id);
      await navigate('inbox');
    });
  });

  // Expand / collapse memo text
  document.querySelectorAll('.btn-expand-memo').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const expanded = btn.dataset.expanded === 'true';
      const card = btn.closest('.memo-card');
      const preview = card?.querySelector('.memo-preview');
      if (!preview) return;

      if (expanded) {
        preview.textContent = preview.dataset.short;
        btn.textContent = '▼ 더보기';
        btn.dataset.expanded = 'false';
      } else {
        preview.textContent = preview.dataset.full;
        btn.textContent = '▲ 접기';
        btn.dataset.expanded = 'true';
      }
    });
  });

  // 첨부파일 원본 보기 모달
  document.querySelectorAll('.btn-view-att').forEach(btn => {
    btn.addEventListener('click', async () => {
      const attId = btn.dataset.attId;
      const att = await db.getAttachment(attId);
      if (!att) { showToast('첨부파일을 찾을 수 없습니다.'); return; }

      const blob = new Blob([att.data], { type: att.mimeType });
      const url = URL.createObjectURL(blob);
      const isImage = att.mimeType.startsWith('image/');

      const modal = document.createElement('div');
      modal.style.cssText = `
        position:fixed;inset:0;z-index:500;
        background:rgba(0,0,0,0.92);
        display:flex;flex-direction:column;
        align-items:center;justify-content:flex-start;
        padding:1rem;overflow:auto;
      `;
      modal.innerHTML = `
        <div style="width:100%;max-width:600px;margin:0 auto;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.8rem;">
            <span style="color:#9090b0;font-size:0.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📎 ${escHtml(att.name)}</span>
            <button id="btnCloseModal" style="background:none;border:1px solid rgba(255,255,255,0.2);color:#f0f0f8;border-radius:8px;padding:0.4rem 0.8rem;cursor:pointer;font-size:0.85rem;flex-shrink:0;margin-left:0.5rem;">✕ 닫기</button>
          </div>
          ${isImage
            ? `<img src="${url}" style="width:100%;border-radius:10px;display:block;" alt="${escHtml(att.name)}">`
            : `<iframe src="${url}" style="width:100%;height:80vh;border:none;border-radius:10px;" title="${escHtml(att.name)}"></iframe>`
          }
        </div>
      `;
      document.body.appendChild(modal);

      modal.querySelector('#btnCloseModal').addEventListener('click', () => {
        URL.revokeObjectURL(url);
        modal.remove();
      });
      modal.addEventListener('click', (e) => {
        if (e.target === modal) { URL.revokeObjectURL(url); modal.remove(); }
      });
    });
  });
}

async function processMemo(id) {
  const overlay = document.getElementById('progressOverlay');
  const text = document.getElementById('progressText');
  if (overlay) overlay.classList.remove('hidden');

  pipeline.onProgress = (step, detail) => { if (text) text.textContent = detail; };
  gemini.onRateLimit = (msg) => { if (text) text.textContent = msg; };

  try {
    await pipeline.process(id);
  } catch (e) {
    if (text) text.textContent = '오류: ' + e.message;
    await sleep(2000);
  }

  gemini.onRateLimit = null;
  if (overlay) overlay.classList.add('hidden');
  await navigate('inbox');
}

async function processAllMemos() {
  const overlay = document.getElementById('progressOverlay');
  const text = document.getElementById('progressText');
  if (overlay) overlay.classList.remove('hidden');

  pipeline.onProgress = (step, detail) => { if (text) text.textContent = detail; };
  gemini.onRateLimit = (msg) => { if (text) text.textContent = msg; };

  try {
    const pending = await db.getPendingMemos();
    for (let i = 0; i < pending.length; i++) {
      if (text) text.textContent = `(${i + 1}/${pending.length}) 처리 중...`;
      try {
        await pipeline.process(pending[i].id);
      } catch (e) {
        console.warn('메모 처리 실패:', pending[i].id, e.message);
      }
      // 메모 간 딜레이: 무료 티어 rate limit 방지 (3초)
      if (i < pending.length - 1) await sleep(3000);
    }
  } catch (e) {
    if (text) text.textContent = '오류: ' + e.message;
    await sleep(2000);
  }

  gemini.onRateLimit = null;
  if (overlay) overlay.classList.add('hidden');
  await navigate('inbox');
}

function bindWikiEvents() {
  // Wiki card click → detail
  document.querySelectorAll('.wiki-card').forEach(card => {
    card.addEventListener('click', async () => {
      UI.setCurrentPage(card.dataset.slug);
      await navigate('wiki');
    });
  });

  // Back button
  const btnBack = document.getElementById('btnBackWiki');
  if (btnBack) {
    btnBack.addEventListener('click', async () => {
      UI.clearCurrentPage();
      await navigate('wiki');
    });
  }

  // Wiki links
  document.querySelectorAll('.md-wikilink').forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      UI.setCurrentPage(link.dataset.slug);
      await navigate('wiki');
    });
  });
}

function bindSettingsEvents() {
  // Save API key
  const btnSave = document.getElementById('btnSaveApi');
  if (btnSave) {
    btnSave.addEventListener('click', async () => {
      const key = document.getElementById('inputApiKey').value.trim();
      if (key) {
        await db.setSetting('apiKey', key);
        showToast('API 키가 저장되었습니다 ✅');
      }
    });
  }

  // GitHub Settings
  const btnGhSave = document.getElementById('btnSaveGithub');
  if (btnGhSave) {
    btnGhSave.addEventListener('click', async () => {
      const token = document.getElementById('inputGhToken').value.trim();
      const repo = document.getElementById('inputGhRepo').value.trim();
      await db.setSetting('githubToken', token);
      await db.setSetting('githubRepo', repo);
      showToast('GitHub 연동 정보가 저장되었습니다 🐙');
    });
  }

  // GitHub Sync All
  const btnGhSync = document.getElementById('btnSyncGithubNow');
  if (btnGhSync) {
    btnGhSync.addEventListener('click', async () => {
      const overlay = document.getElementById('progressOverlay');
      const text = document.getElementById('progressText');
      
      const opts = await github.getOptions();
      if (!github.isConfigured(opts)) {
        showToast('먼저 GitHub Token과 저장소 경로를 저장해주세요.');
        return;
      }
      
      if (overlay) { overlay.classList.remove('hidden'); if(text) text.textContent = 'GitHub에 전체 위키 동기화 중...'; }
      
      try {
        const { successCount, errors } = await github.syncAllPages();
        if (errors.length > 0) {
          showToast(`동기화 성공: ${successCount}개 / 실패: ${errors.length}개`);
          console.error(errors);
        } else {
          showToast(`${successCount}개 위키 페이지 동기화 완료! 🚀`);
        }
      } catch (e) {
        showToast('동기화 오류: ' + e.message);
      } finally {
        if (overlay) overlay.classList.add('hidden');
      }
    });
  }

  // Export Markdown
  const btnMd = document.getElementById('btnExportMd');
  if (btnMd) {
    btnMd.addEventListener('click', async () => {
      try {
        const files = await db.exportToMarkdown();
        if (window.JSZip) {
          const zip = new window.JSZip();
          for (const [name, content] of Object.entries(files)) {
            zip.file(name, content);
          }
          const blob = await zip.generateAsync({ type: 'blob' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'llm-wiki-export.zip';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          showToast(`${Object.keys(files).length}개 파일 ZIP 내보내기 완료`);
        } else {
          // Fallback
          for (const [name, content] of Object.entries(files)) {
            downloadFile(name, content, 'text/markdown');
          }
          showToast(`${Object.keys(files).length}개 파일 내보내기 완료`);
        }
      } catch (e) {
        showToast('내보내기 오류: ' + e.message);
      }
    });
  }

  // Export JSON
  const btnJson = document.getElementById('btnExportJson');
  if (btnJson) {
    btnJson.addEventListener('click', async () => {
      const data = await db.exportAllAsJSON();
      downloadFile('llm-wiki-backup.json', JSON.stringify(data, null, 2), 'application/json');
      showToast('백업 완료 💾');
    });
  }

  // Import
  const inputImport = document.getElementById('inputImport');
  if (inputImport) {
    inputImport.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      const data = JSON.parse(text);
      await db.importFromJSON(data);
      showToast('데이터 복원 완료 ✅');
      await navigate('settings');
    });
  }

  // Init pages
  const btnInit = document.getElementById('btnInitPages');
  if (btnInit) {
    btnInit.addEventListener('click', async () => {
      await db.initDefaultPages(DEFAULT_SCHEMA, true);
      showToast('위키 페이지 초기화 완료');
    });
  }

  // Force Refresh App
  const btnRefresh = document.getElementById('btnForceRefresh');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', async () => {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        for (let r of regs) await r.unregister();
      }
      window.location.reload();
    });
  }
}

function bindChatEvents() {
  const btnClear = document.getElementById('btnClearChat');
  if (btnClear) {
    btnClear.addEventListener('click', async () => {
      UI.clearChatHistory();
      await navigate('chat');
    });
  }

  const btn = document.getElementById('btnSendChat');
  const input = document.getElementById('chatInput');

  if (btn && input) {
    btn.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) return;

      appendChatMessage('user', text);
      input.value = '';

      const loadingId = appendChatMessage('bot', '위키 내용을 검토하며 생각 중...', true);

      try {
        const pages = await db.getPages();
        let context = '내 위키 데이터:\n\n';
        for (const p of pages) {
          if (p.content && p.content.length > 50) {
            context += `--- Page: ${p.title} ---\n${p.content}\n\n`;
          }
        }

        let historyText = '';
        const recentHistory = UI.chatHistory.slice(-5, -1);
        if (recentHistory.length > 0) {
          historyText = '\n\n[최근 대화 맥락]\n';
          for(const m of recentHistory) {
            historyText += `${m.role === 'user' ? '사용자' : 'AI'}: ${m.text}\n`;
          }
        }

        const prompt = `당신은 사용자의 업무일지 위키를 기반으로 답변하는 똑똑한 AI 어시스턴트입니다.
제공된 위키 데이터를 바탕으로 사용자의 질문에 정확하게 답변하세요.
만약 위키 데이터에 관련 내용이 없다면 "위키에 관련 내용이 없습니다"라고 밝힌 후 일반적인 지식으로 답변하세요.
답변은 마크다운 형식으로 보기 좋게 정리해서 제공하세요.

${context}${historyText}

사용자 최신 질문: ${text}`;

        const { default: gemini } = await import('./gemini.js');
        const reply = await gemini.flash(prompt, { maxTokens: 1024 });
        updateChatMessage(loadingId, reply);
      } catch (e) {
        updateChatMessage(loadingId, '오류 발생: ' + e.message);
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        btn.click();
      }
    });
  }
}

function appendChatMessage(role, text, isLoading = false) {
  if (!isLoading) UI.chatHistory.push({ role, text });
  
  const chatMsgs = document.getElementById('chatMessages');
  if (!chatMsgs) return null;
  const id = 'msg-' + Date.now();
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.id = id;

  if (isLoading) div.classList.add('loading');

  if (role === 'bot' && !isLoading) {
    import('./markdown.js').then(({renderMarkdown}) => {
      div.innerHTML = `<div class="msg-bubble markdown-body">${renderMarkdown(text)}</div>`;
    });
  } else {
    div.innerHTML = `<div class="msg-bubble">${escHtml(text)}</div>`;
  }

  chatMsgs.appendChild(div);
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
  return id;
}

function updateChatMessage(id, text) {
  UI.chatHistory.push({ role: 'bot', text });
  const div = document.getElementById(id);
  if (div) {
    div.classList.remove('loading');
    import('./markdown.js').then(({renderMarkdown}) => {
      div.innerHTML = `<div class="msg-bubble markdown-body">${renderMarkdown(text)}</div>`;
      const chatMsgs = document.getElementById('chatMessages');
      if(chatMsgs) chatMsgs.scrollTop = chatMsgs.scrollHeight;
    });
  }
}

// ============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2500);
}

function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// --- Boot ---
document.addEventListener('DOMContentLoaded', init);
