/**
 * LLM Wiki — App Controller
 */
import db from './db.js';
import { pipeline, DEFAULT_SCHEMA } from './pipeline.js';
import * as UI from './ui.js';

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
  }
  main.innerHTML = html;
  main.classList.remove('fade-out');

  bindScreenEvents(tab);
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
  // Add memo
  const btn = document.getElementById('btnAddMemo');
  const input = document.getElementById('memoInput');
  if (btn && input) {
    btn.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) return;
      await db.addMemo(text);
      input.value = '';
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
}

async function processMemo(id) {
  const overlay = document.getElementById('progressOverlay');
  const text = document.getElementById('progressText');
  if (overlay) overlay.classList.remove('hidden');

  pipeline.onProgress = (step, detail) => {
    if (text) text.textContent = detail;
  };

  try {
    await pipeline.process(id);
  } catch (e) {
    if (text) text.textContent = '오류: ' + e.message;
    await sleep(2000);
  }

  if (overlay) overlay.classList.add('hidden');
  await navigate('inbox');
}

async function processAllMemos() {
  const overlay = document.getElementById('progressOverlay');
  const text = document.getElementById('progressText');
  if (overlay) overlay.classList.remove('hidden');

  pipeline.onProgress = (step, detail) => {
    if (text) text.textContent = detail;
  };

  try {
    await pipeline.processAll();
  } catch (e) {
    if (text) text.textContent = '오류: ' + e.message;
    await sleep(2000);
  }

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

  // Export Markdown
  const btnMd = document.getElementById('btnExportMd');
  if (btnMd) {
    btnMd.addEventListener('click', async () => {
      const files = await db.exportToMarkdown();
      for (const [name, content] of Object.entries(files)) {
        downloadFile(name, content, 'text/markdown');
      }
      showToast(`${Object.keys(files).length}개 파일 내보내기 완료`);
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
      await db.initDefaultPages(DEFAULT_SCHEMA);
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
        let context = '내 위키 데이터:\\n\\n';
        for (const p of pages) {
          if (p.content && p.content.length > 50) {
            context += `--- Page: ${p.title} ---\\n${p.content}\\n\\n`;
          }
        }

        const prompt = `당신은 사용자의 업무일지 위키를 기반으로 답변하는 똑똑한 AI 어시스턴트입니다.
제공된 위키 데이터를 바탕으로 사용자의 질문에 정확하게 답변하세요.
만약 위키 데이터에 관련 내용이 없다면 "위키에 관련 내용이 없습니다"라고 밝힌 후 일반적인 지식으로 답변하세요.
답변은 마크다운 형식으로 보기 좋게 정리해서 제공하세요.

${context}

사용자 질문: ${text}`;

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

// --- Boot ---
document.addEventListener('DOMContentLoaded', init);
