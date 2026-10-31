// แผนการจัดการเรียนรู้ — ครูอัพโหลดผ่านหน้าเดียวกับอัพโหลดสื่อ เก็บในโฟลเดอร์ของครูใน Drive:
//   Teaching Media / <ชื่อครู> / แผนการจัดการเรียนการสอน / ปีการศึกษา <ปี> / ภาคเรียนที่ <n> / <วิชา ชั้น> / หน่วยที่ <n>
// ครูจัดการ (แก้ชื่อ ย้ายวิชา/หน่วย ลบ) ได้อิสระ · ผู้บริหาร หัวหน้าฝ่ายวิชาการ superadmin ดูความคืบหน้าได้จาก system (อ่านอย่างเดียว)
import * as drive from "./drive.js";
import { categorizeFile, extOf } from "./categorize.js";

export const PLAN_ROOT_NAME = "แผนการจัดการเรียนการสอน";
export const PLAN_MAX_BATCH = 30;
const MAX_UNIT = 60;

export class PlanError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

export async function ensurePlanSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS tm_lesson_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      academic_term_id INTEGER NOT NULL,
      year_be TEXT NOT NULL,
      term_number INTEGER NOT NULL,
      subject_name TEXT NOT NULL,
      subject_code TEXT,
      grade_level TEXT,
      unit_no INTEGER NOT NULL,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      ext TEXT,
      mime_type TEXT,
      file_size INTEGER,
      category TEXT NOT NULL,
      drive_file_id TEXT NOT NULL UNIQUE,
      drive_folder_id TEXT NOT NULL,
      preview_drive_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_tm_plans_term ON tm_lesson_plans(academic_term_id, owner_id)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS tm_plan_folders (owner_id INTEGER NOT NULL, path TEXT NOT NULL, folder_id TEXT NOT NULL, PRIMARY KEY (owner_id, path))"),
  ]);
}

// ---------- ภาคเรียน / วิชาที่ครูสอน (ข้อมูลกลางจากฝ่ายวัดผลใน D1 เดียวกัน) ----------
async function tableExists(env, name) {
  return !!(await env.DB.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?").bind(name).first());
}

export async function listTerms(env) {
  if (!(await tableExists(env, "academic_terms"))) return [];
  const { results } = await env.DB.prepare(`SELECT t.id, t.term_number, t.status, y.year_be FROM academic_terms t
    JOIN academic_years y ON y.id = t.academic_year_id ORDER BY y.year_be DESC, t.term_number DESC`).all();
  return results || [];
}

const norm = (v) => String(v ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
export const subjectLabel = (s) => drive.cleanName(`${s.subject_name}${s.subject_code ? ` (${s.subject_code})` : ""}${s.grade_level ? ` ${s.grade_level}` : ""}`);
const subjectKey = (s) => `${norm(s.subject_code) || norm(s.subject_name)}|${norm(s.grade_level)}`;

// วิชาที่ครูสอนในปีของภาคเรียน รวมห้องเดียวกันชั้นเดียวกันเป็นวิชาเดียว (แผนฯ ใช้ร่วมทุกห้องในชั้น)
export async function teacherSubjects(env, userId, term) {
  if (!term) return [];
  for (const t of ["gr_subjects", "gr_courses", "gr_course_teachers"]) if (!(await tableExists(env, t))) return [];
  const yearId = (await env.DB.prepare("SELECT academic_year_id FROM academic_terms WHERE id = ?").bind(term.id).first())?.academic_year_id;
  if (!yearId) return [];
  const { results } = await env.DB.prepare(`SELECT DISTINCT s.name AS subject_name, s.code AS subject_code, s.grade_level, s.sort_order
    FROM gr_course_teachers ct JOIN gr_courses c ON c.id = ct.course_id JOIN gr_subjects s ON s.id = c.subject_id AND s.academic_year_id = ?
    WHERE ct.user_id = ? ORDER BY s.grade_level, s.sort_order, s.code`).bind(yearId, userId).all();
  const seen = new Map();
  for (const r of results || []) {
    const s = { subject_name: norm(r.subject_name), subject_code: norm(r.subject_code) || null, grade_level: norm(r.grade_level) || null };
    if (!seen.has(subjectKey(s))) seen.set(subjectKey(s), { ...s, label: subjectLabel(s) });
  }
  return [...seen.values()];
}

async function resolveTerm(env, termId) {
  const terms = await listTerms(env);
  const term = termId ? terms.find((t) => t.id === Number(termId)) : (terms.find((t) => t.status === "active") || terms[0]);
  return { term: term || null, terms };
}

// รับค่าที่ครูกรอก: ภาคเรียน + วิชา (จากรายวิชาที่สอน หรือพิมพ์เอง) + หน่วยที่
async function readTarget(env, user, body) {
  const { term } = await resolveTerm(env, body.term_id);
  if (!term || term.id !== Number(body.term_id)) throw new PlanError("กรุณาเลือกปีการศึกษา/ภาคเรียน");
  const unit = Number(body.unit_no);
  if (!Number.isInteger(unit) || unit < 1 || unit > MAX_UNIT) throw new PlanError(`หน่วยที่ต้องเป็นตัวเลข 1–${MAX_UNIT}`);
  const subject = { subject_name: norm(body.subject_name).slice(0, 120), subject_code: norm(body.subject_code).slice(0, 30) || null, grade_level: norm(body.grade_level).slice(0, 30) || null };
  if (!subject.subject_name) throw new PlanError("กรุณาเลือกรายวิชา");
  return { term, unit, subject };
}

// ---------- โฟลเดอร์ใน Drive (จำ id ไว้ ไม่ต้องค้นซ้ำทุกไฟล์) ----------
function folderNames(target) {
  return [PLAN_ROOT_NAME, `ปีการศึกษา ${target.term.year_be}`, `ภาคเรียนที่ ${target.term.term_number}`, subjectLabel(target.subject), `หน่วยที่ ${target.unit}`];
}

export async function planFolder(env, user, target, teacherFolder, { verify = true } = {}) {
  const names = folderNames(target);
  const path = names.join("/");
  const cached = await env.DB.prepare("SELECT folder_id FROM tm_plan_folders WHERE owner_id = ? AND path = ?").bind(user.id, path).first();
  if (cached) {
    if (!verify) return cached.folder_id;
    const meta = await drive.getMeta(env, cached.folder_id, "id,trashed");
    if (meta && !meta.trashed) return cached.folder_id;
  }
  let id = await teacherFolder(env, user);
  for (const n of names) id = await drive.findOrCreateFolder(env, n, id);
  await env.DB.prepare("INSERT INTO tm_plan_folders (owner_id, path, folder_id) VALUES (?, ?, ?) ON CONFLICT(owner_id, path) DO UPDATE SET folder_id = excluded.folder_id")
    .bind(user.id, path, id).run();
  return id;
}

// ---------- API ของครู ----------
const PLAN_COLS = "id, academic_term_id, year_be, term_number, subject_name, subject_code, grade_level, unit_no, title, file_name, ext, mime_type, file_size, category, created_at, updated_at";

async function mine(env, user, url) {
  const { term, terms } = await resolveTerm(env, url.searchParams.get("term_id"));
  const subjects = await teacherSubjects(env, user.id, term);
  const items = term ? ((await env.DB.prepare(`SELECT ${PLAN_COLS} FROM tm_lesson_plans WHERE owner_id = ? AND academic_term_id = ?
    ORDER BY grade_level, subject_name, unit_no, title COLLATE NOCASE`).bind(user.id, term.id).all()).results || []) : [];
  return { term, terms, subjects, items, max_batch: PLAN_MAX_BATCH };
}

export async function ownedPlan(env, user, id) {
  return env.DB.prepare("SELECT * FROM tm_lesson_plans WHERE id = ? AND owner_id = ?").bind(id, user.id).first();
}

async function prepare(env, user, body, teacherFolder) {
  const target = await readTarget(env, user, body);
  await planFolder(env, user, target, teacherFolder, { verify: true });
  return { ok: true };
}

async function startUpload(request, env, user, body, teacherFolder) {
  const target = await readTarget(env, user, body);
  const name = drive.cleanName(body.name);
  if (!name) throw new PlanError("ไม่พบชื่อไฟล์");
  const size = Number(body.size);
  const params = { name, mimeType: String(body.mimeType || "") || "application/octet-stream", size: Number.isFinite(size) && size >= 0 ? size : null, origin: new URL(request.url).origin };
  try {
    return { uploadUrl: await drive.createUploadSession(env, { ...params, parent: await planFolder(env, user, target, teacherFolder, { verify: false }) }) };
  } catch {
    // โฟลเดอร์ที่จำไว้อาจถูกลบใน Drive → สร้างใหม่แล้วลองอีกครั้ง
    return { uploadUrl: await drive.createUploadSession(env, { ...params, parent: await planFolder(env, user, target, teacherFolder, { verify: true }) }) };
  }
}

async function completeUpload(env, user, body, teacherFolder) {
  const target = await readTarget(env, user, body);
  const fileId = String(body.driveFileId || "");
  if (!/^[\w-]{10,}$/.test(fileId)) throw new PlanError("รหัสไฟล์ไม่ถูกต้อง");
  const exists = await env.DB.prepare("SELECT id, owner_id FROM tm_lesson_plans WHERE drive_file_id = ?").bind(fileId).first();
  if (exists) { if (exists.owner_id !== user.id) throw new PlanError("ไม่พบไฟล์", 404); return { id: exists.id }; }
  const folder = await planFolder(env, user, target, teacherFolder, { verify: false });
  const meta = await drive.getMeta(env, fileId);
  if (!meta || meta.trashed || !(meta.parents || []).includes(folder)) throw new PlanError("ไม่พบไฟล์ในโฟลเดอร์แผนฯ ของคุณ", 404);
  const category = categorizeFile(meta.name, meta.mimeType);
  const title = meta.name.replace(/\.[^.]{1,8}$/, "") || meta.name;
  const s = target.subject;
  const row = await env.DB.prepare(`INSERT INTO tm_lesson_plans (owner_id, academic_term_id, year_be, term_number, subject_name, subject_code, grade_level, unit_no,
      title, file_name, ext, mime_type, file_size, category, drive_file_id, drive_folder_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(user.id, target.term.id, String(target.term.year_be), target.term.term_number, s.subject_name, s.subject_code, s.grade_level, target.unit,
      title, meta.name, extOf(meta.name), meta.mimeType || null, meta.size != null ? Number(meta.size) : null, category, fileId, folder).first();
  return { id: row.id };
}

// แก้ไข: เปลี่ยนชื่อ และ/หรือ ย้ายไปวิชา/หน่วย/ภาคเรียนอื่น (ย้ายไฟล์ใน Drive ตาม)
async function updatePlan(env, user, id, body, teacherFolder) {
  const row = await ownedPlan(env, user, id);
  if (!row) throw new PlanError("ไม่พบแผนฯ", 404);
  const sets = [], binds = [];
  const patch = {};
  if (body.title != null) {
    const title = drive.cleanName(body.title).slice(0, 200);
    if (!title) throw new PlanError("กรุณาตั้งชื่อไฟล์");
    const fileName = title + (row.ext ? `.${row.ext}` : "");
    patch.name = fileName;
    sets.push("title = ?", "file_name = ?"); binds.push(title, fileName);
  }
  let query = "";
  if (body.unit_no != null || body.subject_name != null || body.term_id != null) {
    const target = await readTarget(env, user, {
      term_id: body.term_id ?? row.academic_term_id, unit_no: body.unit_no ?? row.unit_no,
      subject_name: body.subject_name ?? row.subject_name, subject_code: body.subject_name != null ? body.subject_code : row.subject_code,
      grade_level: body.subject_name != null ? body.grade_level : row.grade_level,
    });
    const folder = await planFolder(env, user, target, teacherFolder, { verify: true });
    if (folder !== row.drive_folder_id) query = `&addParents=${encodeURIComponent(folder)}&removeParents=${encodeURIComponent(row.drive_folder_id)}`;
    sets.push("academic_term_id = ?", "year_be = ?", "term_number = ?", "subject_name = ?", "subject_code = ?", "grade_level = ?", "unit_no = ?", "drive_folder_id = ?");
    binds.push(target.term.id, String(target.term.year_be), target.term.term_number, target.subject.subject_name, target.subject.subject_code, target.subject.grade_level, target.unit, folder);
  }
  if (!sets.length) return { ok: true };
  if (patch.name || query) await drive.patchFile(env, row.drive_file_id, patch, query);
  await env.DB.prepare(`UPDATE tm_lesson_plans SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ? AND owner_id = ?`).bind(...binds, id, user.id).run();
  return { ok: true };
}

// ลบ = ย้ายไฟล์ไปถังขยะ Drive (กู้ใน Drive ได้ 30 วัน) แล้วลบรายการ
async function deletePlans(env, user, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 200);
  if (!list.length) throw new PlanError("ยังไม่ได้เลือกรายการ");
  let done = 0;
  for (const id of list) {
    const row = await ownedPlan(env, user, id);
    if (!row) continue;
    const res = await drive.driveFetch(env, `/files/${encodeURIComponent(row.drive_file_id)}?supportsAllDrives=true`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }),
    }, { raw: true }).catch(() => null);
    if (!res || (!res.ok && res.status !== 404)) continue;
    if (row.preview_drive_id) await drive.deleteForever(env, row.preview_drive_id).catch(() => {});
    await env.DB.prepare("DELETE FROM tm_lesson_plans WHERE id = ?").bind(row.id).run();
    done++;
  }
  if (done < list.length) return { ok: false, count: done, error: `ลบได้ ${done} จาก ${list.length} ไฟล์ · ติดต่อ Google Drive ไม่สำเร็จ กรุณาลองใหม่` };
  return { ok: true, count: done };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function handlePlansApi(request, env, url, path, method, user, { teacherFolder }) {
  if (!path.startsWith("/api/plans")) return null;
  try {
    if (path === "/api/plans" && method === "GET") return json(await mine(env, user, url));
    const body = method === "GET" ? {} : await request.json().catch(() => ({}));
    if (path === "/api/plans/prepare" && method === "POST") return json(await prepare(env, user, body, teacherFolder));
    if (path === "/api/plans/uploads" && method === "POST") return json(await startUpload(request, env, user, body, teacherFolder));
    if (path === "/api/plans/uploads/complete" && method === "POST") return json(await completeUpload(env, user, body, teacherFolder));
    if (path === "/api/plans/delete" && method === "POST") { const r = await deletePlans(env, user, body.ids); return json(r, r.ok ? 200 : 502); }
    const m = path.match(/^\/api\/plans\/(\d+)$/);
    if (m && method === "PATCH") return json(await updatePlan(env, user, Number(m[1]), body, teacherFolder));
    return json({ error: "ไม่พบหน้านี้" }, 404);
  } catch (e) {
    if (e instanceof PlanError) return json({ error: e.message }, e.status);
    throw e;
  }
}
