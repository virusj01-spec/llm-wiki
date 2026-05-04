import db from './db.js';

export class GitHubClient {
  constructor() {}

  async getOptions() {
    const token = await db.getSetting('githubToken');
    const repoPath = await db.getSetting('githubRepo'); // format: "username/repo"
    return { token, repoPath };
  }

  isConfigured(options) {
    return options.token && options.repoPath && options.repoPath.includes('/');
  }

  // UTF-8 지원 Base64 인코딩
  utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  async syncPage(slug, content) {
    const options = await this.getOptions();
    if (!this.isConfigured(options)) return false;

    const path = `${slug}.md`;
    const url = `https://api.github.com/repos/${options.repoPath}/contents/${path}`;
    
    const headers = {
      'Authorization': `Bearer ${options.token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    };

    try {
      // 1. Check if file exists to get its SHA
      let sha = null;
      const getRes = await fetch(url, { headers });
      if (getRes.ok) {
        const data = await getRes.json();
        sha = data.sha;
      }

      // 2. Upload/Update file
      const body = {
        message: `Auto-sync: Update ${slug}.md via LLM Wiki`,
        content: this.utf8ToBase64(content)
      };
      if (sha) body.sha = sha;

      const putRes = await fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body)
      });

      if (!putRes.ok) {
        const errorData = await putRes.json();
        throw new Error(errorData.message || 'GitHub API Error');
      }

      return true;
    } catch (e) {
      console.error('GitHub Sync Error:', e);
      throw e;
    }
  }

  async syncAllPages() {
    const pages = await db.getPages();
    let successCount = 0;
    let errors = [];

    for (const page of pages) {
      try {
        const ok = await this.syncPage(page.slug, page.content);
        if (ok) successCount++;
      } catch (e) {
        errors.push(`${page.slug}: ${e.message}`);
      }
    }
    return { successCount, errors };
  }
}

const github = new GitHubClient();
export default github;
