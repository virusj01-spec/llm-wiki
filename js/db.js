/**
 * LLM Wiki — IndexedDB Wrapper
 * Stores: memos, pages, logs, settings
 */
class WikiDB {
  constructor() {
    this.dbName = 'llm-wiki-db';
    this.version = 1;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.version);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        // Inbox memos
        if (!db.objectStoreNames.contains('memos')) {
          const memos = db.createObjectStore('memos', { keyPath: 'id' });
          memos.createIndex('status', 'status', { unique: false });
          memos.createIndex('created', 'created', { unique: false });
        }
        // Wiki pages
        if (!db.objectStoreNames.contains('pages')) {
          const pages = db.createObjectStore('pages', { keyPath: 'slug' });
          pages.createIndex('updated', 'updated', { unique: false });
        }
        // Processing logs
        if (!db.objectStoreNames.contains('logs')) {
          const logs = db.createObjectStore('logs', { keyPath: 'id' });
          logs.createIndex('timestamp', 'timestamp', { unique: false });
        }
        // Settings (key-value)
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // --- Generic CRUD ---
  _tx(store, mode = 'readonly') {
    return this.db.transaction(store, mode).objectStore(store);
  }

  async _put(store, data) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store, 'readwrite').put(data);
      req.onsuccess = () => resolve(data);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async _get(store, key) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async _getAll(store) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async _delete(store, key) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store, 'readwrite').delete(key);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // --- Memos ---
  async addMemo(text) {
    const memo = {
      id: 'memo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      text: text.trim(),
      status: 'pending', // pending | processing | done | error
      created: new Date().toISOString(),
      result: null
    };
    return this._put('memos', memo);
  }

  async getMemos() { return this._getAll('memos'); }
  async getMemo(id) { return this._get('memos', id); }
  async updateMemo(memo) { return this._put('memos', memo); }
  async deleteMemo(id) { return this._delete('memos', id); }

  async getPendingMemos() {
    const all = await this.getMemos();
    return all.filter(m => m.status === 'pending').sort((a, b) => new Date(b.created) - new Date(a.created));
  }

  // --- Wiki Pages ---
  async savePage(page) {
    page.updated = new Date().toISOString();
    return this._put('pages', page);
  }

  async getPage(slug) { return this._get('pages', slug); }
  async getPages() { return this._getAll('pages'); }
  async deletePage(slug) { return this._delete('pages', slug); }

  async initDefaultPages(schema) {
    const existing = await this.getPages();
    if (existing.length > 0) return;
    for (const p of schema.pages) {
      await this.savePage({
        slug: p.slug,
        title: p.title,
        description: p.description,
        tags: p.tags,
        content: `# ${p.title}\n\n*아직 내용이 없습니다. 메모를 작성하면 자동으로 채워집니다.*`,
        created: new Date().toISOString(),
        updated: new Date().toISOString()
      });
    }
  }

  // --- Logs ---
  async addLog(entry) {
    entry.id = 'log-' + Date.now();
    entry.timestamp = new Date().toISOString();
    return this._put('logs', entry);
  }

  async getLogs() {
    const logs = await this._getAll('logs');
    return logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }

  // --- Settings ---
  async setSetting(key, value) { return this._put('settings', { key, value }); }

  async getSetting(key) {
    const r = await this._get('settings', key);
    return r ? r.value : null;
  }

  // --- Export/Import (Obsidian 호환) ---
  async exportToMarkdown() {
    const pages = await this.getPages();
    const files = {};
    for (const p of pages) {
      const frontmatter = [
        '---',
        `title: "${p.title}"`,
        `slug: ${p.slug}`,
        `tags: [${p.tags.join(', ')}]`,
        `created: ${p.created}`,
        `updated: ${p.updated}`,
        '---',
        ''
      ].join('\n');
      files[`${p.slug}.md`] = frontmatter + p.content;
    }
    return files;
  }

  async exportAllAsJSON() {
    return {
      memos: await this.getMemos(),
      pages: await this.getPages(),
      logs: await this.getLogs(),
      exportedAt: new Date().toISOString()
    };
  }

  async importFromJSON(data) {
    if (data.pages) for (const p of data.pages) await this.savePage(p);
    if (data.memos) for (const m of data.memos) await this._put('memos', m);
  }
}

// Singleton
const db = new WikiDB();
export default db;
