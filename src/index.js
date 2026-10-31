// ระบบสื่อการสอน (teachingmedia.banpadengschool.ac.th)
// - ครูเข้าจากปุ่ม "อัพโหลดสื่อการสอน" ในหน้าบัญชีของ system (SSO) หรือล็อกอินด้วยบัญชี system
// - สื่อของครูแต่ละคน เห็น/จัดการได้เฉพาะเจ้าของบัญชี
// - ไฟล์เก็บใน Google Drive: Teaching Media / <ชื่อครู> / ...  (เบราว์เซอร์อัพโหลดตรงเข้า Drive ไม่จำกัดขนาด)
import { verifyPassword, signJWT, verifyJWT, buildSessionCookie, buildClearCookie, AUTH_COOKIE_NAME } from "./crypto.js";
import * as drive from "./drive.js";
import { CATEGORIES, CATEGORY_KEYS, categorizeFile, analyzeLink, extOf } from "./categorize.js";

import { FolderError, folderId, ownFolder, listFolders, saveFolder, deleteFolder, moveMedia } from "./folders.js";
import { ensurePlanSchema, handlePlansApi, ownedPlan } from "./plans.js";

const ROLES = ["teacher", "executive", "staff", "superadmin"];
const PREVIEW_FOLDER_NAME = "_ตัวอย่างไฟล์ (ระบบ)";
const SESSION_REFRESH_SECONDS = 60 * 60 * 24;
const TEXT_EXT = new Set(["txt", "csv", "tsv", "md", "json", "xml", "html", "htm", "css", "js", "py", "java", "c", "cpp", "srt", "vtt", "log"]);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers },
  });
}
const fail = (error, status = 400) => json({ error }, status);

// ---------- ฐานข้อมูล (D1 ร่วมกับ system; ตารางขึ้นต้นด้วย tm_) ----------
let schemaReady = false;
export async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tm_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      kind TEXT NOT NULL,              -- file | link
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL,          -- หมวดที่ใช้แสดง (เจ้าของเปลี่ยนได้)
      category_auto TEXT NOT NULL,     -- หมวดที่ระบบจัดให้อัตโนมัติ
      file_name TEXT,
      ext TEXT,
      mime_type TEXT,
      file_size INTEGER,
      drive_file_id TEXT,
      drive_folder_id TEXT,
      preview_drive_id TEXT,
      url TEXT,
      link_provider TEXT,
      link_embed TEXT,
      link_thumb TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT)`),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS tm_folders (user_id INTEGER PRIMARY KEY, folder_id TEXT NOT NULL, folder_name TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS tm_state (key TEXT PRIMARY KEY, value TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS tm_login_failures (email TEXT NOT NULL, ip TEXT, at TEXT NOT NULL DEFAULT (datetime('now')))"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tm_sso_codes (
      code_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, session_version INTEGER NOT NULL, expires_at INTEGER NOT NULL)`),
  ]);
  // Additive migration for existing deployments; keep Drive bindings and old media intact.
  const columns = (await env.DB.prepare("PRAGMA table_info(tm_media)").all()).results || [];
  for (const [name, type] of [["collection_id", "INTEGER"], ["favorite", "INTEGER NOT NULL DEFAULT 0"]]) {
    if (!columns.some(c => c.name === name)) {
      try { await env.DB.prepare(`ALTER TABLE tm_media ADD COLUMN ${name} ${type}`).run(); }
      catch (e) { if (!String(e.message).includes("duplicate column")) throw e; }
    }
  }
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tm_collections (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, parent_id INTEGER, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_tm_collection_name ON tm_collections(owner_id, COALESCE(parent_id, 0), name COLLATE NOCASE)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tm_collection_parent ON tm_collections(owner_id, parent_id)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tm_media_collection ON tm_media(owner_id, collection_id, deleted_at)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tm_media_owner ON tm_media(owner_id, deleted_at, created_at)"),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_tm_media_file ON tm_media(drive_file_id) WHERE drive_file_id IS NOT NULL"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tm_login_failures ON tm_login_failures(email, at)"),
  ]);
  await ensurePlanSchema(env);
  schemaReady = true;
}

// ---------- ผู้ใช้ ----------
let cachedSecret = null;
async function jwtSecret(env) {
  if (env.JWT_SECRET) return String(env.JWT_SECRET);
  if (cachedSecret) return cachedSecret;
  const fresh = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.DB.prepare("INSERT OR IGNORE INTO tm_state (key, value) VALUES ('jwt_secret', ?)").bind(fresh).run();
  cachedSecret = (await env.DB.prepare("SELECT value FROM tm_state WHERE key = 'jwt_secret'").first()).value;
  return cachedSecret;
}

function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

async function isViewerAccount(env, userId) {
  try { return !!(await env.DB.prepare("SELECT 1 FROM viewer_accounts WHERE user_id = ?").bind(userId).first()); }
  catch { return false; }
}
const canUse = (u) => u && u.status === "active" && !u.deleted_at && ROLES.includes(u.role);

async function currentUser(request, env) {
  const payload = await verifyJWT(readCookie(request, AUTH_COOKIE_NAME), await jwtSecret(env));
  if (!payload?.sub || payload.app !== "tmedia") return null;
  const user = await env.DB.prepare("SELECT id, email, full_name, role, status, session_version, deleted_at FROM users WHERE id = ?")
    .bind(payload.sub).first().catch(() => null);
  if (!canUse(user)) return null;
  if (user.session_version != null && Number(payload.sv || 1) !== Number(user.session_version)) return null;
  if (await isViewerAccount(env, user.id)) return null;
  return { _iat: Number(payload.iat || 0), _sv: user.session_version ?? 1, id: user.id, email: user.email, full_name: user.full_name, role: user.role };
}

const sessionToken = async (env, user) => signJWT({ sub: user.id, sv: user.session_version ?? user._sv ?? 1, app: "tmedia" }, await jwtSecret(env));

async function login(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) return fail("กรุณากรอกอีเมลและรหัสผ่าน");
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM tm_login_failures WHERE email = ? AND at > datetime('now','-15 minutes')").bind(email).first();
  if (n >= 8) return fail("ลองเข้าสู่ระบบผิดหลายครั้ง กรุณารอ 15 นาที", 429);
  const user = await env.DB.prepare("SELECT id, email, full_name, role, status, password_hash, password_salt, session_version, deleted_at FROM users WHERE lower(email) = ?")
    .bind(email).first();
  const ok = user && await verifyPassword(password, user.password_salt, user.password_hash);
  if (!ok) {
    await env.DB.prepare("INSERT INTO tm_login_failures (email, ip) VALUES (?, ?)").bind(email, ip).run();
    return fail("อีเมลหรือรหัสผ่านไม่ถูกต้อง", 401);
  }
  if (!canUse(user) || await isViewerAccount(env, user.id)) return fail("บัญชีนี้ยังไม่มีสิทธิ์ใช้งาน (ต้องได้รับการกำหนดบทบาทในระบบ system ก่อน)", 403);
  await env.DB.prepare("DELETE FROM tm_login_failures WHERE email = ?").bind(email).run();
  return json({ ok: true }, 200, { "Set-Cookie": buildSessionCookie(await sessionToken(env, user)) });
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// เข้าจากปุ่มในหน้าบัญชีของ system: แลกรหัสใช้ครั้งเดียว (system สร้างใน tm_sso_codes) เป็น session
async function ssoLogin(url, env) {
  const home = new Response(null, { status: 302, headers: { Location: "/", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  const code = String(url.searchParams.get("code") || "");
  if (!/^[0-9a-f]{64}$/.test(code)) return home;
  const row = await env.DB.prepare("DELETE FROM tm_sso_codes WHERE code_hash = ? AND expires_at >= ? RETURNING user_id, session_version")
    .bind(await sha256Hex(code), Math.floor(Date.now() / 1000)).first();
  if (!row) return home;
  const user = await env.DB.prepare("SELECT id, role, status, session_version, deleted_at FROM users WHERE id = ?").bind(row.user_id).first();
  if (!canUse(user) || await isViewerAccount(env, user.id)) return home;
  if (user.session_version != null && Number(row.session_version) !== Number(user.session_version)) return home;
  home.headers.append("Set-Cookie", buildSessionCookie(await sessionToken(env, user)));
  return home;
}

// ---------- โฟลเดอร์ใน Drive ----------
async function stateGet(env, key) {
  return (await env.DB.prepare("SELECT value FROM tm_state WHERE key = ?").bind(key).first())?.value || null;
}
async function stateSet(env, key, value) {
  await env.DB.prepare("INSERT INTO tm_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

async function rootFolder(env) {
  if (env.TEACHING_MEDIA_FOLDER_ID) return String(env.TEACHING_MEDIA_FOLDER_ID);
  const saved = await stateGet(env, "root_folder_id");
  if (saved) {
    const meta = await drive.getMeta(env, saved, "id,trashed");
    if (meta && !meta.trashed) return saved;
  }
  const id = await drive.findOrCreateFolder(env, String(env.TEACHING_MEDIA_FOLDER_NAME || "Teaching Media"), "root");
  await stateSet(env, "root_folder_id", id);
  return id;
}

async function previewFolder(env) {
  const saved = await stateGet(env, "preview_folder_id");
  if (saved) return saved;
  const id = await drive.findOrCreateFolder(env, PREVIEW_FOLDER_NAME, await rootFolder(env));
  await stateSet(env, "preview_folder_id", id);
  return id;
}

// โฟลเดอร์ของครู (ตั้งชื่อตามชื่อครู) — ถ้าชื่อในระบบเปลี่ยน เปลี่ยนชื่อโฟลเดอร์ตาม
async function teacherFolder(env, user) {
  const name = drive.cleanName(user.full_name || user.email) || `user-${user.id}`;
  const row = await env.DB.prepare("SELECT folder_id, folder_name FROM tm_folders WHERE user_id = ?").bind(user.id).first();
  if (row) {
    const meta = await drive.getMeta(env, row.folder_id, "id,trashed");
    if (meta && !meta.trashed) {
      if (row.folder_name !== name) {
        await drive.patchFile(env, row.folder_id, { name });
        await env.DB.prepare("UPDATE tm_folders SET folder_name = ? WHERE user_id = ?").bind(name, user.id).run();
      }
      return row.folder_id;
    }
  }
  const id = await drive.findOrCreateFolder(env, name, await rootFolder(env));
  await env.DB.prepare("INSERT INTO tm_folders (user_id, folder_id, folder_name) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET folder_id = excluded.folder_id, folder_name = excluded.folder_name")
    .bind(user.id, id, name).run();
  return id;
}

// ---------- สื่อ ----------
const MEDIA_COLS = "id, collection_id, favorite, kind, title, description, category, category_auto, file_name, ext, mime_type, file_size, url, link_provider, link_embed, link_thumb, preview_drive_id IS NOT NULL AS has_preview, created_at, updated_at, deleted_at";
const SORTS = {
  newest: "created_at DESC, id DESC",
  oldest: "created_at ASC, id ASC",
  name: "title COLLATE NOCASE ASC, id ASC",
  name_desc: "title COLLATE NOCASE DESC, id DESC",
  size: "COALESCE(file_size, 0) DESC, id DESC",
  type: "category ASC, created_at DESC",
  updated: "updated_at DESC, id DESC",
};

async function listMedia(url, env, user) {
  const trash = url.searchParams.get("trash") === "1";
  const where = ["owner_id = ?", trash ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"];
  const binds = [user.id];
  if (url.searchParams.has("folder")) {
    const f = folderId(url.searchParams.get("folder"));
    await ownFolder(env, user, f);
    where.push("collection_id IS ?"); binds.push(f);
  }
  if (url.searchParams.get("favorites") === "1") where.push("favorite = 1");
  const cat = url.searchParams.get("category");
  if (cat && CATEGORY_KEYS.includes(cat)) { where.push("category = ?"); binds.push(cat); }
  const q = String(url.searchParams.get("q") || "").trim();
  if (q) { where.push("(title LIKE ? OR description LIKE ? OR file_name LIKE ?)"); const like = `%${q.replace(/[%_]/g, "")}%`; binds.push(like, like, like); }
  const sort = SORTS[url.searchParams.get("sort")] || SORTS.newest;
  const items = (await env.DB.prepare(`SELECT ${MEDIA_COLS} FROM tm_media WHERE ${where.join(" AND ")} ORDER BY ${sort} LIMIT 2000`).bind(...binds).all()).results || [];
  const counts = (await env.DB.prepare("SELECT category, COUNT(*) AS n, SUM(COALESCE(file_size,0)) AS bytes FROM tm_media WHERE owner_id = ? AND deleted_at IS NULL GROUP BY category").bind(user.id).all()).results || [];
  const { t } = await env.DB.prepare("SELECT COUNT(*) AS t FROM tm_media WHERE owner_id = ? AND deleted_at IS NOT NULL").bind(user.id).first();
  return json({ items, counts, trash_count: t, categories: CATEGORIES });
}

async function ownedMedia(env, user, id, { includeDeleted = true } = {}) {
  const row = await env.DB.prepare("SELECT * FROM tm_media WHERE id = ? AND owner_id = ?").bind(id, user.id).first();
  if (!row || (!includeDeleted && row.deleted_at)) return null;
  return row;
}

function publicMedia(row) {
  const { owner_id, drive_file_id, drive_folder_id, preview_drive_id, ...rest } = row;
  return { ...rest, has_preview: !!preview_drive_id };
}

async function startUpload(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const name = drive.cleanName(body.name);
  if (!name) return fail("ไม่พบชื่อไฟล์");
  const size = Number(body.size);
  const folder = await teacherFolder(env, user);
  const uploadUrl = await drive.createUploadSession(env, {
    name, mimeType: String(body.mimeType || "") || "application/octet-stream",
    size: Number.isFinite(size) && size >= 0 ? size : null, parent: folder, origin: new URL(request.url).origin,
  });
  return json({ uploadUrl });
}

async function completeUpload(request, env, user) {
  const body = await request.json().catch(() => ({}));
  let collection = folderId(body.collection_id);
  // แฟ้มของคนอื่น → ปฏิเสธทันที; แฟ้มถูกลบระหว่างอัปโหลด → เก็บไฟล์ไว้ที่แฟ้มหลัก ไม่ให้ไฟล์ค้างใน Drive
  let movedToRoot = false;
  if (collection !== null) {
    const f = await env.DB.prepare("SELECT owner_id FROM tm_collections WHERE id = ?").bind(collection).first();
    if (f && f.owner_id !== user.id) return fail("ไม่พบแฟ้มงาน", 404);
    if (!f) { collection = null; movedToRoot = true; }
  }
  const fileId = String(body.driveFileId || "");
  if (!/^[\w-]{10,}$/.test(fileId)) return fail("รหัสไฟล์ไม่ถูกต้อง");
  const folder = await teacherFolder(env, user);
  const meta = await drive.getMeta(env, fileId);
  if (!meta || meta.trashed || !(meta.parents || []).includes(folder)) return fail("ไม่พบไฟล์ในโฟลเดอร์ของคุณ", 404);
  const exists = await env.DB.prepare("SELECT id FROM tm_media WHERE drive_file_id = ?").bind(fileId).first();
  if (exists) return json({ id: exists.id });
  const category = categorizeFile(meta.name, meta.mimeType);
  const title = drive.cleanName(body.title) || meta.name.replace(/\.[^.]{1,8}$/, "") || meta.name;
  const row = await env.DB.prepare(`INSERT INTO tm_media (owner_id, kind, title, description, category, category_auto, file_name, ext, mime_type, file_size, drive_file_id, drive_folder_id, collection_id)
    VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(user.id, title, String(body.description || "").slice(0, 2000) || null, category, category, meta.name, extOf(meta.name), meta.mimeType || null,
      meta.size != null ? Number(meta.size) : null, fileId, folder, collection).first();
  return json({ id: row.id, category, moved_to_root: movedToRoot });
}

async function fetchTitle(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 TeachingMedia" }, redirect: "follow", signal: AbortSignal.timeout(5000) });
    if (!res.ok || !String(res.headers.get("content-type")).includes("html")) return null;
    const text = (await res.text()).slice(0, 200000);
    const og = text.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i);
    const t = og?.[1] || text.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    return t ? t.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim().slice(0, 200) : null;
  } catch { return null; }
}

async function addLink(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const collection = folderId(body.collection_id);
  await ownFolder(env, user, collection);
  const info = analyzeLink(body.url);
  if (!info) return fail("ลิงก์ไม่ถูกต้อง (ต้องขึ้นต้นด้วย http:// หรือ https://)");
  const title = String(body.title || "").trim().slice(0, 200) || await fetchTitle(info.url) || info.host;
  const row = await env.DB.prepare(`INSERT INTO tm_media (owner_id, kind, title, description, category, category_auto, url, link_provider, link_embed, link_thumb, collection_id)
    VALUES (?, 'link', ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(user.id, title, String(body.description || "").slice(0, 2000) || null, info.category, info.category, info.url, info.provider, info.embed, info.thumb, collection).first();
  return json({ id: row.id, category: info.category });
}

async function updateMedia(request, env, user, id) {
  const row = await ownedMedia(env, user, id);
  if (!row) return fail("ไม่พบสื่อ", 404);
  const body = await request.json().catch(() => ({}));
  const sets = [], binds = [];
  if (Object.hasOwn(body, "favorite")) {
    if (typeof body.favorite !== "boolean") return fail("ค่ารายการโปรดไม่ถูกต้อง");
    sets.push("favorite = ?"); binds.push(body.favorite ? 1 : 0);
  }
  if (body.title != null) {
    const title = String(body.title).trim().slice(0, 200);
    if (!title) return fail("กรุณาตั้งชื่อสื่อ");
    sets.push("title = ?"); binds.push(title);
    if (row.kind === "file" && row.drive_file_id) {
      const fileName = drive.cleanName(title) + (row.ext ? `.${row.ext}` : "");
      await drive.patchFile(env, row.drive_file_id, { name: fileName });
      sets.push("file_name = ?"); binds.push(fileName);
    }
  }
  if (body.description != null) { sets.push("description = ?"); binds.push(String(body.description).slice(0, 2000) || null); }
  if (body.category != null) {
    const cat = body.category === "auto" ? row.category_auto : String(body.category);
    if (!CATEGORY_KEYS.includes(cat)) return fail("หมวดไม่ถูกต้อง");
    sets.push("category = ?"); binds.push(cat);
  }
  if (row.kind === "link" && body.url != null) {
    const info = analyzeLink(body.url);
    if (!info) return fail("ลิงก์ไม่ถูกต้อง");
    sets.push("url = ?, link_provider = ?, link_embed = ?, link_thumb = ?, category_auto = ?");
    binds.push(info.url, info.provider, info.embed, info.thumb, info.category);
    if (body.category == null && row.category === row.category_auto) { sets.push("category = ?"); binds.push(info.category); }
  }
  if (!sets.length) return json({ ok: true });
  await env.DB.prepare(`UPDATE tm_media SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ? AND owner_id = ?`).bind(...binds, id, user.id).run();
  return json({ ok: true });
}

// ลบถาวร = ย้ายไฟล์ไปถังขยะ Drive (กู้ใน Drive ได้ 30 วัน) + ลบรายการ
// ถ้าย้ายไฟล์เข้าถังขยะ Drive ไม่สำเร็จ (ยกเว้นไฟล์ไม่มีอยู่แล้ว) จะเก็บรายการไว้ ไม่ให้ไฟล์ค้างใน Drive โดยไม่มีรายการ
async function purge(env, row) {
  if (row.drive_file_id) {
    const res = await drive.driveFetch(env, `/files/${encodeURIComponent(row.drive_file_id)}?supportsAllDrives=true`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }),
    }, { raw: true }).catch(() => null);
    if (!res || (!res.ok && res.status !== 404)) return false;
  }
  if (row.preview_drive_id) await drive.deleteForever(env, row.preview_drive_id).catch(() => {});
  await env.DB.prepare("DELETE FROM tm_media WHERE id = ?").bind(row.id).run();
  return true;
}

async function purgeAll(env, rows) {
  let done = 0;
  for (const row of rows) if (await purge(env, row)) done++;
  return done;
}

// D1 รับค่าได้ไม่เกิน 100 ค่าต่อคำสั่ง จึงแบ่งทำทีละ 80 รายการ
const BULK_CHUNK = 80;
const chunked = (ids) => { const out = []; for (let i = 0; i < ids.length; i += BULK_CHUNK) out.push(ids.slice(i, i + BULK_CHUNK)); return out; };

async function bulkAction(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 500);
  if (!ids.length) return fail("ยังไม่ได้เลือกรายการ");
  const action = String(body.action || "");
  const cat = String(body.category || "");
  if (!["trash", "restore", "delete", "category"].includes(action)) return fail("คำสั่งไม่ถูกต้อง");
  if (action === "category" && cat !== "auto" && !CATEGORY_KEYS.includes(cat)) return fail("หมวดไม่ถูกต้อง");
  const chunks = chunked(ids);
  const marksOf = (c) => c.map(() => "?").join(",");
  const rows = [];
  for (const c of chunks) rows.push(...((await env.DB.prepare(`SELECT * FROM tm_media WHERE owner_id = ? AND id IN (${marksOf(c)})`).bind(user.id, ...c).all()).results || []));
  if (action === "delete") {
    const done = await purgeAll(env, rows);
    if (done < rows.length) return json({ ok: false, count: done, error: `ลบถาวรได้ ${done} จาก ${rows.length} รายการ · ติดต่อ Google Drive ไม่สำเร็จ กรุณาลองใหม่` }, 502);
    return json({ ok: true, count: done });
  }
  const statements = chunks.map((c) => {
    const m = marksOf(c);
    if (action === "trash") return env.DB.prepare(`UPDATE tm_media SET deleted_at = datetime('now') WHERE owner_id = ? AND deleted_at IS NULL AND id IN (${m})`).bind(user.id, ...c);
    if (action === "restore") return env.DB.prepare(`UPDATE tm_media SET deleted_at = NULL WHERE owner_id = ? AND id IN (${m})`).bind(user.id, ...c);
    if (cat === "auto") return env.DB.prepare(`UPDATE tm_media SET category = category_auto, updated_at = datetime('now') WHERE owner_id = ? AND id IN (${m})`).bind(user.id, ...c);
    return env.DB.prepare(`UPDATE tm_media SET category = ?, updated_at = datetime('now') WHERE owner_id = ? AND id IN (${m})`).bind(cat, user.id, ...c);
  });
  await env.DB.batch(statements);
  return json({ ok: true, count: rows.length });
}

async function emptyTrash(env, user) {
  const rows = (await env.DB.prepare("SELECT * FROM tm_media WHERE owner_id = ? AND deleted_at IS NOT NULL").bind(user.id).all()).results || [];
  const done = await purgeAll(env, rows);
  if (done < rows.length) return json({ ok: false, count: done, error: `ลบถาวรได้ ${done} จาก ${rows.length} รายการ · ติดต่อ Google Drive ไม่สำเร็จ กรุณาลองใหม่` }, 502);
  return json({ ok: true, count: done });
}

// ---------- ส่งไฟล์ / ภาพย่อ / ตัวอย่าง ----------
function inlineType(row) {
  const t = String(row.mime_type || "").toLowerCase();
  if (row.category === "pdf") return "application/pdf";
  if (t === "image/svg+xml" || row.ext === "svg") return "image/svg+xml";
  if (/^(image|video|audio)\//.test(t)) return t;
  if (TEXT_EXT.has(row.ext) || t.startsWith("text/")) return "text/plain; charset=utf-8";
  return null;
}

const asciiName = (n) => String(n || "file").replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
function disposition(type, name) {
  return `${type}; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name || "file")}`;
}

async function serveFile(request, env, row, url) {
  if (!row || row.kind !== "file") return new Response("ไม่พบไฟล์", { status: 404 });
  const download = url.searchParams.get("download") === "1";
  const asText = url.searchParams.get("text") === "1";
  const range = asText ? "bytes=0-307199" : request.headers.get("Range");
  const res = await drive.fetchMedia(env, row.drive_file_id, range);
  if (!res.ok && res.status !== 206) return new Response("เปิดไฟล์จาก Google Drive ไม่สำเร็จ", { status: 502 });
  const headers = new Headers(SECURITY_HEADERS);
  for (const h of ["Content-Length", "Content-Range", "Accept-Ranges"]) if (res.headers.get(h)) headers.set(h, res.headers.get(h));
  headers.set("Cache-Control", "private, max-age=300");
  const type = asText ? "text/plain; charset=utf-8" : inlineType(row);
  if (download || !type) {
    headers.set("Content-Type", row.mime_type || "application/octet-stream");
    headers.set("Content-Disposition", disposition("attachment", row.file_name));
  } else {
    headers.set("Content-Type", type);
    headers.set("Content-Disposition", disposition("inline", row.file_name));
    if (type !== "application/pdf") headers.set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
  }
  if (asText) headers.delete("Content-Range");
  return new Response(res.body, { status: asText ? 200 : res.status, headers });
}

async function serveThumb(request, env, ctx, user, id) {
  const row = await ownedMedia(env, user, id);
  if (!row || row.kind !== "file") return new Response(null, { status: 404 });
  const cacheKey = new Request(`https://tm-cache.internal/thumb/${row.drive_file_id}/${row.updated_at}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const res = await drive.fetchThumbnail(env, row.drive_file_id, 480).catch(() => null);
  if (!res) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  const out = new Response(res.body, { headers: { ...SECURITY_HEADERS, "Content-Type": res.headers.get("Content-Type") || "image/jpeg", "Cache-Control": "private, max-age=86400" } });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

// เอกสาร/ตารางคำนวณ/งานนำเสนอ (Office) → แปลงเป็น PDF ครั้งแรกที่เปิดดู แล้วเก็บไว้ใช้ซ้ำ
async function servePreviewPdf(env, row, table = "tm_media") {
  if (!row || row.kind !== "file") return new Response("ไม่พบไฟล์", { status: 404 });
  let pid = row.preview_drive_id;
  if (!pid) {
    if (!["document", "spreadsheet", "presentation"].includes(row.category_auto) || TEXT_EXT.has(row.ext)) return new Response("ไฟล์นี้แสดงตัวอย่างแบบ PDF ไม่ได้", { status: 415 });
    try {
      pid = await drive.convertToPdf(env, row.drive_file_id, row.category_auto, row.title, await previewFolder(env));
    } catch (e) {
      return new Response(`แปลงไฟล์เพื่อแสดงตัวอย่างไม่สำเร็จ: ${String(e.message).slice(0, 150)}`, { status: 502 });
    }
    if (!pid) return new Response("ไฟล์นี้แสดงตัวอย่างไม่ได้", { status: 415 });
    await env.DB.prepare(`UPDATE ${table} SET preview_drive_id = ? WHERE id = ?`).bind(pid, row.id).run();
  }
  const res = await drive.fetchMedia(env, pid);
  if (!res.ok) {
    await env.DB.prepare(`UPDATE ${table} SET preview_drive_id = NULL WHERE id = ?`).bind(row.id).run();
    return new Response("ไม่พบไฟล์ตัวอย่าง กรุณาเปิดใหม่อีกครั้ง", { status: 502 });
  }
  return new Response(res.body, { headers: { ...SECURITY_HEADERS, "Content-Type": "application/pdf", "Content-Disposition": disposition("inline", `${row.title}.pdf`), "Cache-Control": "private, max-age=300" } });
}

// ---------- เส้นทาง ----------
function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

async function handleApi(request, env, url, path, method, user) {
  if (path === "/api/me" && method === "GET") return json({ user: user && { id: user.id, email: user.email, full_name: user.full_name, role: user.role } });
  if (!user) return fail("กรุณาเข้าสู่ระบบ", 401);
  const plans = await handlePlansApi(request, env, url, path, method, user, { teacherFolder });
  if (plans) return plans;
  if (path === "/api/folders" && method === "GET") return json({ folders: await listFolders(env, user) });
  if (path === "/api/folders" && method === "POST") return json({ folder: await saveFolder(env, user, await request.json()) }, 201);
  const folderMatch = path.match(/^\/api\/folders\/(\d+)$/);
  if (folderMatch && method === "PATCH") return json({ folder: await saveFolder(env, user, await request.json(), Number(folderMatch[1])) });
  if (folderMatch && method === "DELETE") { await deleteFolder(env, user, Number(folderMatch[1])); return json({ ok: true }); }
  if (path === "/api/media/move" && method === "POST") {
    const body = await request.json(); return json(await moveMedia(env, user, body.ids, body.collection_id));
  }
  if (path === "/api/media" && method === "GET") return listMedia(url, env, user);
  if (path === "/api/uploads" && method === "POST") return startUpload(request, env, user);
  if (path === "/api/uploads/complete" && method === "POST") return completeUpload(request, env, user);
  if (path === "/api/links" && method === "POST") return addLink(request, env, user);
  if (path === "/api/media/bulk" && method === "POST") return bulkAction(request, env, user);
  if (path === "/api/trash/empty" && method === "POST") return emptyTrash(env, user);
  const m = path.match(/^\/api\/media\/(\d+)$/);
  if (m && method === "GET") {
    const row = await ownedMedia(env, user, Number(m[1]));
    return row ? json({ item: publicMedia(row), categories: CATEGORIES }) : fail("ไม่พบสื่อ", 404);
  }
  if (m && method === "PATCH") return updateMedia(request, env, user, Number(m[1]));
  return fail("ไม่พบหน้านี้", 404);
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/sso" && method === "GET") { await ensureSchema(env); return ssoLogin(url, env); }

  const fileMatch = path.match(/^\/(file|thumb|preview|plan-file|plan-preview)\/(\d+)$/);
  if (fileMatch && method === "GET") {
    await ensureSchema(env);
    const user = await currentUser(request, env);
    if (!user) return new Response("กรุณาเข้าสู่ระบบ", { status: 401 });
    const id = Number(fileMatch[2]);
    if (fileMatch[1] === "file") return serveFile(request, env, await ownedMedia(env, user, id), url);
    if (fileMatch[1] === "thumb") return serveThumb(request, env, ctx, user, id);
    if (fileMatch[1] === "preview") return servePreviewPdf(env, await ownedMedia(env, user, id));
    // แผนการจัดการเรียนรู้ของตนเอง (category_auto ใช้ตัดสินการแปลง PDF)
    const plan = await ownedPlan(env, user, id);
    const row = plan && { ...plan, kind: "file", category_auto: plan.category };
    return fileMatch[1] === "plan-file" ? serveFile(request, env, row, url) : servePreviewPdf(env, row, "tm_lesson_plans");
  }

  if (!path.startsWith("/api/")) {
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  }

  if (method !== "GET" && !sameOrigin(request)) return fail("คำขอไม่ถูกต้อง", 403);
  await ensureSchema(env);
  if (path === "/api/login" && method === "POST") return login(request, env);
  if (path === "/api/logout" && method === "POST") return json({ ok: true }, 200, { "Set-Cookie": buildClearCookie() });

  const user = await currentUser(request, env);
  const response = await handleApi(request, env, url, path, method, user);
  if (user && Date.now() / 1000 - user._iat > SESSION_REFRESH_SECONDS && !response.headers.has("Set-Cookie")) {
    const out = new Response(response.body, response);
    out.headers.append("Set-Cookie", buildSessionCookie(await sessionToken(env, user)));
    return out;
  }
  return response;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      if (error instanceof FolderError) return fail(error.message, error.status);
      console.error(error);
      return fail(String(error?.message || "เกิดข้อผิดพลาด").slice(0, 300), 500);
    }
  },
};

export { handle as _handleForTests };
