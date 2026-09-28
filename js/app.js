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
  const pendingAttContainer = document.getElementById('pendingAttList');

  // 대기 중인 첨부파일 목록 (객체 배열: { id, name, mimeType, size, data })
  let pendingAttachments = [];

  function renderPendingAttList() {
    if (!pendingAttContainer) return;
    if (pendingAttachments.length === 0) {
      pendingAttContainer.innerHTML = '';
      return;
    }

    pendingAttContainer.innerHTML = `
      <div class="pending-att-box">
        <div class="pending-att-header">
          <span>📎 첨부된 파일 (${pendingAttachments.length}개)</span>
        </div>
        <div class="att-chips-list">
          ${pendingAttachments.map((att, idx) => `
            <div class="att-chip pending-chip">
              <span class="att-chip-icon">${UI.getFileIcon(att.name, att.mimeType)}</span>
              <span class="att-chip-name btn-preview-pending" data-idx="${idx}" title="클릭하여 확인">${UI.escHtml(att.name)}</span>
              <span class="att-chip-size">${UI.formatFileSize(att.size)}</span>
              <button type="button" class="att-chip-action btn-preview-pending" data-idx="${idx}" title="미리보기">🔍 확인</button>
              <button type="button" class="att-chip-remove btn-remove-pending" data-idx="${idx}" title="첨부 취소">✕</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    // 첨부 대기 파일 확인 클릭 이벤트
    pendingAttContainer.querySelectorAll('.btn-preview-pending').forEach(el => {
      el.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.dataset.idx, 10);
        const targetAtt = pendingAttachments[idx];
        if (targetAtt) openAttachmentViewer(null, targetAtt);
      });
    });

    // 첨부 취소(삭제) 클릭 이벤트
    pendingAttContainer.querySelectorAll('.btn-remove-pending').forEach(el => {
      el.addEventListener('click', async (e) => {
        const idx = parseInt(e.currentTarget.dataset.idx, 10);
        const removed = pendingAttachments.splice(idx, 1)[0];
        if (removed && removed.id) {
          await db.deleteAttachment(removed.id).catch(() => {});
        }
        renderPendingAttList();
        showToast(`🗑️ ${removed.name} 첨부 취소`);
      });
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      if (files.length === 0) return;

      for (const file of files) {
        try {
          const arrayBuffer = await file.arrayBuffer();

          if (file.name.endsWith('.txt') || file.name.endsWith('.md') || file.name.endsWith('.csv')) {
            // ① 텍스트 원본 파일도 첨부파일 스토어에 보존하여 확인/다운로드 지원
            const saved = await db.addAttachment({ name: file.name, mimeType: file.type || 'text/plain', data: arrayBuffer });
            pendingAttachments.push({
              id: saved.id,
              name: file.name,
              mimeType: file.type || 'text/plain',
              size: arrayBuffer.byteLength,
              data: arrayBuffer
            });

            const text = new TextDecoder('utf-8').decode(arrayBuffer);
            input.value = (input.value ? input.value + '\n\n' : '') + `[문서: ${file.name}]\n${text}`;
            showToast(`📄 ${file.name} 첨부 완료`);

          } else if (file.type.startsWith('image/') || file.type === 'application/pdf') {
            showToast(`📷 ${file.name} 분석 중...`);

            // ① 원본 파일을 스토어에 저장
            const saved = await db.addAttachment({ name: file.name, mimeType: file.type, data: arrayBuffer });
            pendingAttachments.push({
              id: saved.id,
              name: file.name,
              mimeType: file.type,
              size: arrayBuffer.byteLength,
              data: arrayBuffer
            });

            // ② base64 변환 후 Gemini OCR
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 8192) {
              binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            }
            const base64 = btoa(binary);

            const { default: gemini } = await import('./gemini.js');
            const ocrText = await gemini.generate('gemini-3.5-flash',
              `이 ${file.type.startsWith('image/') ? '이미지' : 'PDF'}의 내용을 최대한 상세히 텍스트로 추출하고 설명하세요.\n표, 수식, 도표가 있으면 마크다운 형식으로 변환하세요.\n파일명: ${file.name}`,
              { temperature: 0.1, maxTokens: 2048, attachments: [{ mimeType: file.type, data: base64 }] }
            );

            input.value = (input.value ? input.value + '\n\n' : '') + `[📎 ${file.name} — OCR 결과]\n${ocrText}`;
            showToast(`✅ ${file.name} 분석 및 첨부 완료`);

          } else {
            // 기타 바이너리 파일도 첨부파일로 저장
            const saved = await db.addAttachment({ name: file.name, mimeType: file.type || 'application/octet-stream', data: arrayBuffer });
            pendingAttachments.push({
              id: saved.id,
              name: file.name,
              mimeType: file.type || 'application/octet-stream',
              size: arrayBuffer.byteLength,
              data: arrayBuffer
            });
            showToast(`📎 ${file.name} 첨부 완료`);
          }
        } catch (err) {
          showToast(`❌ ${file.name} 처리 실패: ${err.message}`);
        }
      }
      fileInput.value = '';
      renderPendingAttList();
    });
  }

  if (btn && input) {
    btn.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text && pendingAttachments.length === 0) {
        showToast('메모 내용이나 첨부파일을 입력하세요.');
        return;
      }
      const attIds = pendingAttachments.map(a => a.id);
      await db.addMemo(text, attIds);
      input.value = '';
      pendingAttachments = [];
      renderPendingAttList();
      showToast('📥 메모가 추가되었습니다.');
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
    btn.addEventListener('click', (e) => processMemo(e.currentTarget.dataset.id));
  });

  // Process all
  const btnAll = document.getElementById('btnProcessAll');
  if (btnAll) btnAll.addEventListener('click', processAllMemos);

  // Edit memo
  document.querySelectorAll('.btn-edit-memo').forEach(btn => {
    btn.addEventListener('click', (e) => openEditMemoModal(e.currentTarget.dataset.id));
  });

  // Delete memo
  document.querySelectorAll('.btn-delete-memo').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      if (!confirm('이 메모를 삭제하시겠습니까? (첨부파일도 함께 삭제됩니다)')) return;
      await db.deleteMemo(id);
      showToast('🗑️ 메모가 삭제되었습니다.');
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

  // 첨부파일 확인 모달 (카드 내 첨부파일 버튼)
  document.querySelectorAll('.btn-view-att').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const attId = e.currentTarget.dataset.attId;
      openAttachmentViewer(attId);
    });
  });
}

/**
 * ✏️ 메모 수정 전용 모달
 */
async function openEditMemoModal(memoId) {
  const memo = await db.getMemo(memoId);
  if (!memo) {
    showToast('해당 메모를 찾을 수 없습니다.');
    return;
  }

  // 첨부파일 정보 조회
  const attIds = memo.attachmentIds || [];
  const attList = [];
  for (const id of attIds) {
    const att = await db.getAttachment(id);
    if (att) attList.push(att);
  }

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'editMemoModal';

  const dateStr = new Date(memo.created).toLocaleString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const statusKo = { pending: '⏳ 처리 대기', processing: '⚙️ 처리 중', done: '✅ 처리 완료', error: '❌ 오류' }[memo.status] || memo.status;

  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-header">
        <div class="modal-title-wrap">
          <h3>✏️ 메모 수정</h3>
          <span class="memo-status-badge ${memo.status}">${statusKo}</span>
        </div>
        <button type="button" class="btn-close-modal" id="btnEditClose">✕</button>
      </div>

      <div class="modal-body">
        <div class="modal-info-row">
          <span class="modal-info-time">📅 작성일시: ${dateStr}</span>
        </div>

        <div class="modal-field">
          <label for="editMemoText" class="modal-label">메모 내용</label>
          <textarea id="editMemoText" class="memo-edit-textarea" rows="7" placeholder="메모 내용을 입력하세요...">${UI.escHtml(memo.text || '')}</textarea>
        </div>

        ${attList.length > 0 ? `
          <div class="modal-att-section">
            <label class="modal-label">📎 첨부된 파일 (${attList.length}개) — 클릭하여 내용 확인</label>
            <div class="att-chips-list">
              ${attList.map(att => `
                <button type="button" class="att-chip btn-view-modal-att" data-att-id="${att.id}" title="${UI.escHtml(att.name)} 확인하기">
                  <span class="att-chip-icon">${UI.getFileIcon(att.name, att.mimeType)}</span>
                  <span class="att-chip-name">${UI.escHtml(att.name)}</span>
                  <span class="att-chip-size">${UI.formatFileSize(att.data?.byteLength || 0)}</span>
                  <span class="att-chip-action">🔍 확인</span>
                </button>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>

      <div class="modal-footer">
        <button type="button" class="btn-sm btn-secondary" id="btnEditCancel">취소</button>
        <button type="button" class="btn-sm btn-action-primary" id="btnEditSave">💾 저장</button>
        ${memo.status === 'pending' || memo.status === 'error' || memo.status === 'done' ? `
          <button type="button" class="btn-sm btn-accent-sm" id="btnEditSaveAndProcess" title="수정 내용을 저장하고 즉시 위키로 합성합니다">
            🚀 저장 후 위키 반영
          </button>
        ` : ''}
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const textarea = modal.querySelector('#editMemoText');
  if (textarea) {
    textarea.focus();
    // 커서를 텍스트 맨 끝으로 이동
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
  }

  // 모달 내부 첨부파일 확인 클릭
  modal.querySelectorAll('.btn-view-modal-att').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const attId = e.currentTarget.dataset.attId;
      openAttachmentViewer(attId);
    });
  });

  const closeModal = () => modal.remove();

  modal.querySelector('#btnEditClose')?.addEventListener('click', closeModal);
  modal.querySelector('#btnEditCancel')?.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // 단순 저장
  modal.querySelector('#btnEditSave')?.addEventListener('click', async () => {
    const updatedText = textarea.value.trim();
    memo.text = updatedText;
    memo.updated = new Date().toISOString();
    await db.updateMemo(memo);
    showToast('✅ 메모가 수정되었습니다.');
    closeModal();
    await navigate('inbox');
  });

  // 저장 후 바로 위키 처리
  modal.querySelector('#btnEditSaveAndProcess')?.addEventListener('click', async () => {
    const updatedText = textarea.value.trim();
    memo.text = updatedText;
    memo.updated = new Date().toISOString();
    await db.updateMemo(memo);
    closeModal();
    await processMemo(memo.id);
  });
}

/**
 * 🔍 첨부파일 확인 뷰어 모달 (이미지, PDF, 텍스트 미리보기 및 다운로드 지원)
 */
async function openAttachmentViewer(attId, preloadedAtt = null) {
  const att = preloadedAtt || (attId ? await db.getAttachment(attId) : null);
  if (!att) {
    showToast('첨부파일을 찾을 수 없습니다.');
    return;
  }

  const mime = att.mimeType || '';
  const isImage = mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(att.name);
  const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(att.name);
  const isText = mime.startsWith('text/') || /\.(txt|md|csv|json|log)$/i.test(att.name);

  const blob = new Blob([att.data], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  let textContent = '';
  if (isText && att.data) {
    try {
      textContent = new TextDecoder('utf-8').decode(att.data);
    } catch (err) {
      textContent = '텍스트 디코딩 실패';
    }
  }

  const modal = document.createElement('div');
  modal.className = 'modal-overlay att-viewer-overlay';
  modal.id = 'attViewerModal';

  const icon = UI.getFileIcon(att.name, mime);
  const sizeStr = UI.formatFileSize(att.data?.byteLength || 0);

  modal.innerHTML = `
    <div class="att-viewer-card">
      <div class="att-viewer-header">
        <div class="att-viewer-title-wrap">
          <span class="att-viewer-icon">${icon}</span>
          <div class="att-viewer-names">
            <span class="att-viewer-filename">${UI.escHtml(att.name)}</span>
            <span class="att-viewer-meta">${sizeStr} · ${UI.escHtml(mime || 'unknown')}</span>
          </div>
        </div>
        <div class="att-viewer-actions">
          <a href="${url}" download="${UI.escHtml(att.name)}" class="btn-sm btn-action-primary" title="기기에 파일 저장">
            ⬇️ 다운로드
          </a>
          <button type="button" class="btn-close-modal" id="btnCloseViewer">✕</button>
        </div>
      </div>

      <div class="att-viewer-body">
        ${isImage ? `
          <div class="viewer-image-wrap">
            <img src="${url}" class="viewer-full-image" alt="${UI.escHtml(att.name)}">
          </div>
        ` : isPdf ? `
          <div class="viewer-pdf-wrap">
            <iframe src="${url}" class="viewer-pdf-frame" title="${UI.escHtml(att.name)}"></iframe>
            <div class="viewer-pdf-fallback">
              <span>💡 모바일 브라우저에서 PDF 미리보기가 안 보일 경우 새 창에서 확인하세요:</span>
              <a href="${url}" target="_blank" rel="noopener noreferrer" class="btn-sm btn-action-secondary">
                📄 새 창에서 PDF 열기
              </a>
            </div>
          </div>
        ` : isText ? `
          <div class="viewer-text-wrap">
            <pre class="viewer-text-code"><code>${UI.escHtml(textContent)}</code></pre>
          </div>
        ` : `
          <div class="viewer-binary-wrap">
            <div class="viewer-binary-icon">${icon}</div>
            <p class="viewer-binary-text">이 파일 형식은 앱 내 직접 미리보기를 지원하지 않습니다.</p>
            <a href="${url}" download="${UI.escHtml(att.name)}" class="btn-primary-sm">
              ⬇️ 다운로드하여 열기 (${sizeStr})
            </a>
          </div>
        `}
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const cleanup = () => {
    URL.revokeObjectURL(url);
    modal.remove();
  };

  modal.querySelector('#btnCloseViewer')?.addEventListener('click', cleanup);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) cleanup();
  });

  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      cleanup();
      document.removeEventListener('keydown', onKeydown);
    }
  };
  document.addEventListener('keydown', onKeydown);
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
      if (!confirm('경고: 모든 메모, 첨부파일, 위키 문서, 로그가 완전히 삭제됩니다!\n(단, API 키 등 설정은 유지됩니다)\n정말 공장 초기화하시겠습니까?')) return;
      await db.factoryReset(DEFAULT_SCHEMA);
      showToast('모든 데이터가 초기화되었습니다 🗑️');
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
