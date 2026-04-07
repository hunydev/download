import express from 'express';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import fs from 'fs-extra';
import path from 'path';
import Database from 'better-sqlite3';
import archiver from 'archiver';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';

async function startServer() {
  const app = express();
  const PORT = 8000;

  const UPLOADS_DIR = path.join(process.cwd(), 'data');
  const DB_PATH = path.join(process.cwd(), 'data', 'files.db');

  fs.ensureDirSync(UPLOADS_DIR);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      password TEXT,
      size INTEGER,
      updated_at INTEGER
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Web password setup
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  let webPassword = process.env.WEB_PASSWORD || (getSetting.get('web_password') as any)?.value;
  if (!webPassword) {
    webPassword = crypto.randomBytes(8).toString('hex');
    setSetting.run('web_password', webPassword);
    console.log(`\n  ⚠️  Generated web password: ${webPassword}`);
    console.log(`  Set WEB_PASSWORD env var or it will be read from DB.\n`);
  }

  const COOKIE_SECRET = crypto.randomBytes(32).toString('hex');
  const SESSION_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

  function createAuthToken() {
    return crypto.createHmac('sha256', COOKIE_SECRET).update('authenticated').digest('hex');
  }

  function verifyAuthToken(token: string) {
    return token === createAuthToken();
  }

  const stmtGet = db.prepare('SELECT * FROM files WHERE path = ?');
  const stmtUpsert = db.prepare(`
    INSERT INTO files (path, password, size, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET password=excluded.password, size=excluded.size, updated_at=excluded.updated_at
  `);
  const stmtAll = db.prepare('SELECT * FROM files');

  const upload = multer({ dest: path.join(process.cwd(), 'tmp') });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // API: Upload
  app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
      const { path: filePath, password } = req.body;
      if (!req.file || !filePath) {
        return res.status(400).json({ error: 'File and path are required' });
      }

      const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '').replace(/\\/g, '/');
      const fullDestPath = path.join(UPLOADS_DIR, safePath);

      await fs.ensureDir(path.dirname(fullDestPath));
      await fs.move(req.file.path, fullDestPath, { overwrite: true });

      stmtUpsert.run(safePath, password || null, req.file.size, Date.now());

      res.json({ success: true, path: safePath });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  // API: Storage stats
  app.get('/api/stats', async (req, res) => {
    try {
      async function getDirStats(dirPath: string): Promise<{ totalSize: number; fileCount: number; folderCount: number }> {
        let totalSize = 0, fileCount = 0, folderCount = 0;
        if (!fs.existsSync(dirPath)) return { totalSize, fileCount, folderCount };
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === 'files.db' || entry.name === 'files.db-wal' || entry.name === 'files.db-shm') continue;
          const fullPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) {
            folderCount++;
            const sub = await getDirStats(fullPath);
            totalSize += sub.totalSize;
            fileCount += sub.fileCount;
            folderCount += sub.folderCount;
          } else {
            fileCount++;
            const stat = await fs.stat(fullPath);
            totalSize += stat.size;
          }
        }
        return { totalSize, fileCount, folderCount };
      }
      const stats = await getDirStats(UPLOADS_DIR);
      res.json(stats);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to get stats' });
    }
  });

  // Remove empty parent folders up to UPLOADS_DIR
  async function cleanEmptyParents(filePath: string) {
    let dir = path.dirname(filePath);
    while (dir !== UPLOADS_DIR && dir.startsWith(UPLOADS_DIR)) {
      const entries = await fs.readdir(dir);
      if (entries.length === 0) {
        await fs.remove(dir);
        dir = path.dirname(dir);
      } else {
        break;
      }
    }
  }

  // API: Delete file/folder
  app.delete('/api/delete', async (req, res) => {
    try {
      const { path: filePath } = req.body;
      if (!filePath) return res.status(400).json({ error: 'Path is required' });

      const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '').replace(/\\/g, '/');
      const fullPath = path.join(UPLOADS_DIR, safePath);

      if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: 'Not found' });
      }

      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        db.prepare('DELETE FROM files WHERE path LIKE ? OR path LIKE ?').run(safePath, safePath + '/%');
        await fs.remove(fullPath);
        await cleanEmptyParents(fullPath);
      } else {
        db.prepare('DELETE FROM files WHERE path = ?').run(safePath);
        await fs.remove(fullPath);
        await cleanEmptyParents(fullPath);
      }

      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Delete failed' });
    }
  });

  // API: List files/folders
  app.get('/api/list/*', async (req, res) => {
    try {
      const dirPath = req.params[0] || '';
      const safePath = path.normalize(dirPath).replace(/^(\.\.(\/|\\|$))+/, '').replace(/\\/g, '/');
      const fullPath = path.join(UPLOADS_DIR, safePath);

      if (!fs.existsSync(fullPath)) {
        return res.json({ items: [] });
      }

      const stat = await fs.stat(fullPath);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Not a directory' });
      }

      const items = await fs.readdir(fullPath);

      const result = await Promise.all(items.filter(item => item !== 'files.db' && item !== 'files.db-wal' && item !== 'files.db-shm').map(async (item) => {
        const itemPath = safePath ? safePath + '/' + item : item;
        const itemFullPath = path.join(fullPath, item);
        const itemStat = await fs.stat(itemFullPath);
        
        const isDir = itemStat.isDirectory();
        const meta = stmtGet.get(itemPath) as any;

        return {
          name: item,
          path: itemPath,
          isDirectory: isDir,
          size: isDir ? 0 : itemStat.size,
          isProtected: !!(meta && meta.password),
          updatedAt: isDir ? itemStat.mtimeMs : (meta ? meta.updated_at : itemStat.mtimeMs)
        };
      }));

      res.json({ items: result });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Failed to list directory' });
    }
  });

  // Download endpoint
  app.get('/d/*', async (req, res) => {
    try {
      const filePath = req.params[0];
      const password = req.query.password;
      
      const safePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '').replace(/\\/g, '/');
      const fullPath = path.join(UPLOADS_DIR, safePath);

      if (!fs.existsSync(fullPath)) {
        return res.status(404).send('File not found');
      }

      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        const folderName = path.basename(safePath) || 'download';
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${folderName}.zip"`);

        const archive = archiver('zip', { zlib: { level: 5 } });
        archive.on('error', (err) => { throw err; });
        archive.pipe(res);
        archive.directory(fullPath, folderName);
        await archive.finalize();
        return;
      }

      const meta = stmtGet.get(safePath) as any;

      if (meta && meta.password) {
        if (meta.password !== password) {
          const errorParam = password ? '?error=1' : '';
          return res.redirect('/view/' + safePath + errorParam);
        }
      }

      res.download(fullPath);
    } catch (error) {
      console.error(error);
      res.status(500).send('Download failed');
    }
  });

  // Serve skill.md
  app.get('/skill.md', (req, res) => {
      const appUrl = 'https://download.huny.dev';
      const md = `# Huny Download/Upload Skill

This skill allows AI agents to easily upload and download files via https://download.huny.dev.

## Quick Setup

Add this to your AI agent's instructions or skill configuration:

\`\`\`
Fetch https://download.huny.dev/skill.md to learn how to upload/download files.
\`\`\`

Or copy the instructions below directly.

## Uploading a File

Send a \`multipart/form-data\` POST request to \`${appUrl}/api/upload\`.

**Fields:**
- \`file\`: The file content (required)
- \`path\`: The destination path, e.g., \`my-folder/data.json\` (required)
- \`password\`: Optional password to protect the file

**Example (curl):**
\`\`\`bash
curl -X POST -F "file=@local.txt" -F "path=ai-uploads/local.txt" -F "password=secret" ${appUrl}/api/upload
\`\`\`

## Downloading a File

Make a GET request to \`${appUrl}/d/{path}\`.

If the file is password protected, provide the password via the \`password\` query parameter.

**Example (curl):**
\`\`\`bash
curl "${appUrl}/d/ai-uploads/local.txt?password=secret" -o local.txt
\`\`\`

## Listing Files

GET \`${appUrl}/api/list/{directory}\` to list files and folders.

**Example:**
\`\`\`bash
curl ${appUrl}/api/list/
\`\`\`

Returns JSON: \`{ "items": [{ "name": "file.txt", "path": "file.txt", "isDirectory": false, "size": 123, "isProtected": false }] }\`
`;
      res.setHeader('Content-Type', 'text/markdown');
      res.send(md);
  });

  // Serve guide page for adding this skill to AI agents
  app.get('/guide', (req, res) => {
      const appUrl = 'https://download.huny.dev';
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Skill Setup Guide - Huny Download</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.6; }
    .container { max-width: 800px; margin: 0 auto; padding: 2rem 1.5rem; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    .subtitle { color: #64748b; margin-bottom: 2rem; font-size: 1.1rem; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .card h2 { font-size: 1.25rem; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem; }
    .card h2 .num { background: #3b82f6; color: #fff; width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 0.85rem; flex-shrink: 0; }
    .card p { color: #475569; margin-bottom: 0.75rem; }
    pre { background: #1e293b; color: #e2e8f0; padding: 1rem; border-radius: 8px; overflow-x: auto; font-size: 0.9rem; position: relative; }
    pre code { font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; background: transparent; color: inherit; padding: 0; }
    .copy-btn { position: absolute; top: 0.5rem; right: 0.5rem; background: #334155; color: #94a3b8; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; }
    .copy-btn:hover { background: #475569; color: #fff; }
    .tag { display: inline-block; background: #eff6ff; color: #2563eb; padding: 2px 10px; border-radius: 12px; font-size: 0.85rem; font-weight: 500; }
    .tag.green { background: #f0fdf4; color: #16a34a; }
    table { width: 100%; border-collapse: collapse; margin: 0.75rem 0; }
    th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e2e8f0; font-size: 0.9rem; }
    th { color: #64748b; font-weight: 600; }
    code { background: #f1f5f9; padding: 1px 6px; border-radius: 4px; font-size: 0.9em; }
    .footer { text-align: center; color: #94a3b8; margin-top: 2rem; font-size: 0.85rem; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>AI Skill Setup Guide</h1>
    <p class="subtitle">AI 에이전트에 파일 업로드/다운로드 스킬을 추가하는 방법</p>

    <div class="card">
      <h2><span class="num">1</span> One-Line 방식 (가장 간단)</h2>
      <p>에이전트 instructions에 아래 한 줄만 추가하면 에이전트가 자동으로 스킬을 학습합니다.</p>
      <pre><code>Fetch ${appUrl}/skill.md to learn how to upload/download files.</code><button class="copy-btn" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)">Copy</button></pre>
    </div>

    <div class="card">
      <h2><span class="num">2</span> 직접 Instructions에 포함</h2>
      <p>에이전트 설정에 아래 내용을 직접 복사하여 붙여넣을 수도 있습니다.</p>
      <pre><code>## File Upload/Download

파일을 업로드하거나 다운로드해야 할 때 ${appUrl}를 사용하세요.

- 업로드: curl -X POST -F "file=@파일" -F "path=경로/파일명" ${appUrl}/api/upload
- 다운로드: curl "${appUrl}/d/경로/파일명" -o 파일명
- 목록: curl ${appUrl}/api/list/</code><button class="copy-btn" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)">Copy</button></pre>
    </div>

    <div class="card">
      <h2><span class="num">3</span> API Reference</h2>
      <table>
        <tr><th>Action</th><th>Method</th><th>Endpoint</th></tr>
        <tr><td><span class="tag">Upload</span></td><td>POST</td><td><code>${appUrl}/api/upload</code></td></tr>
        <tr><td><span class="tag green">Download</span></td><td>GET</td><td><code>${appUrl}/d/{path}</code></td></tr>
        <tr><td><span class="tag green">List</span></td><td>GET</td><td><code>${appUrl}/api/list/{dir}</code></td></tr>
        <tr><td><span class="tag green">Skill Doc</span></td><td>GET</td><td><a href="/skill.md"><code>${appUrl}/skill.md</code></a></td></tr>
      </table>

      <p style="margin-top:1rem"><strong>Upload fields</strong> (multipart/form-data):</p>
      <table>
        <tr><th>Field</th><th>Required</th><th>Description</th></tr>
        <tr><td><code>file</code></td><td>Yes</td><td>업로드할 파일</td></tr>
        <tr><td><code>path</code></td><td>Yes</td><td>저장 경로 (예: <code>docs/report.pdf</code>)</td></tr>
        <tr><td><code>password</code></td><td>No</td><td>다운로드 시 필요한 비밀번호</td></tr>
      </table>
    </div>

    <div class="card">
      <h2><span class="num">4</span> 지원되는 AI 에이전트</h2>
      <p>skill.md를 fetch할 수 있는 모든 AI 에이전트에서 사용 가능합니다.</p>
      <table>
        <tr><th>Agent</th><th>설정 방법</th></tr>
        <tr><td>GitHub Copilot</td><td><code>.instructions.md</code> 또는 <code>copilot-instructions.md</code>에 추가</td></tr>
        <tr><td>Claude (Anthropic)</td><td>System prompt 또는 CLAUDE.md에 추가</td></tr>
        <tr><td>Cursor / Windsurf</td><td>Rules 또는 Instructions에 추가</td></tr>
        <tr><td>Custom Agent</td><td>System prompt에 fetch 명령 추가</td></tr>
      </table>
    </div>

    <div class="footer">
      <p><a href="/">← Back to Files</a> · <a href="/skill.md">View skill.md</a></p>
    </div>
  </div>
</body>
</html>`;
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
  });

  // Login page
  app.get('/login', (req, res) => {
    const error = req.query.error === '1';
    const redirect = req.query.redirect || '/';
    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - Huny Download</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; padding: 2.5rem; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); width: 100%; max-width: 380px; }
    .icon { width: 48px; height: 48px; background: #eff6ff; border-radius: 12px; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.5rem; }
    .icon svg { width: 24px; height: 24px; color: #3b82f6; }
    h1 { text-align: center; font-size: 1.5rem; color: #1e293b; margin-bottom: 0.5rem; }
    .sub { text-align: center; color: #64748b; font-size: 0.9rem; margin-bottom: 1.5rem; }
    .error { background: #fef2f2; color: #dc2626; padding: 0.75rem; border-radius: 8px; font-size: 0.85rem; text-align: center; margin-bottom: 1rem; }
    label { display: block; font-size: 0.85rem; font-weight: 600; color: #475569; margin-bottom: 0.4rem; }
    input { width: 100%; padding: 0.7rem 1rem; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 1rem; outline: none; transition: border 0.2s; }
    input:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }
    button { width: 100%; padding: 0.75rem; background: #3b82f6; color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 1rem; transition: background 0.2s; }
    button:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" /></svg></div>
    <h1>Login</h1>
    <p class="sub">Web 파일 탐색기를 사용하려면 로그인하세요</p>
    ${error ? '<div class="error">비밀번호가 올바르지 않습니다</div>' : ''}
    <form method="POST" action="/login">
      <input type="hidden" name="redirect" value="${redirect}" />
      <label>Password</label>
      <input type="password" name="password" placeholder="비밀번호 입력" autofocus required />
      <button type="submit">로그인</button>
    </form>
  </div>
</body>
</html>`;
    res.send(html);
  });

  // Login handler
  app.post('/login', (req, res) => {
    const { password, redirect } = req.body;
    if (password === webPassword) {
      res.cookie('auth_token', createAuthToken(), {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: SESSION_MAX_AGE,
      });
      return res.redirect(redirect || '/');
    }
    const redirectParam = redirect ? `&redirect=${encodeURIComponent(redirect)}` : '';
    res.redirect(`/login?error=1${redirectParam}`);
  });

  // Logout handler
  app.get('/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.redirect('/login');
  });

  // Auth middleware for web views (skip API, download, skill.md, login)
  app.use((req, res, next) => {
    // Public routes: API, downloads, skill.md, login, static assets
    if (
      req.path.startsWith('/api/') ||
      req.path.startsWith('/d/') ||
      req.path.startsWith('/view/') ||
      req.path.startsWith('/src/') ||
      req.path.startsWith('/@') ||
      req.path.startsWith('/node_modules/') ||
      req.path === '/skill.md' ||
      req.path === '/favicon.svg' ||
      req.path === '/login' ||
      req.path === '/logout'
    ) {
      return next();
    }

    const token = req.cookies?.auth_token;
    if (token && verifyAuthToken(token)) {
      return next();
    }

    // For HTML requests, redirect to login
    if (req.accepts('html')) {
      return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
    }

    res.status(401).json({ error: 'Authentication required' });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log('Server running on http://localhost:' + PORT);
  });
}

startServer();
