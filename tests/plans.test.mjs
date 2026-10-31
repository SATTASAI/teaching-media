// แผนการจัดการเรียนรู้: เลือกวิชาที่ครูสอน → สร้างโฟลเดอร์ใน Drive อัตโนมัติ → อัพโหลด / แก้ไข / ย้ายหน่วย / ลบ (เฉพาะเจ้าของ)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker, { ensureSchema } from '../src/index.js';
import { signJWT, AUTH_COOKIE_NAME } from '../src/crypto.js';

function d1(db) {
  return {
    prepare(sql) {
      return {
        values: [],
        bind(...values) { this.values = values; return this; },
        async all() { return { results: db.prepare(sql).all(...this.values) }; },
        async first() { return db.prepare(sql).get(...this.values) ?? null; },
        async run() { return { meta: db.prepare(sql).run(...this.values) }; },
      };
    },
    async batch(statements) { const out = []; for (const s of statements) out.push(await s.run()); return out; },
  };
}

// Google Drive จำลอง
function fakeDrive() {
  const files = new Map(); let n = 0;
  const id = () => `drivefile${String(++n).padStart(4, '0')}`;
  const res = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });
  async function fetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET';
    if (url.host === 'oauth2.googleapis.com') return res({ access_token: 'tok', expires_in: 3600 });
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q');
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)[1].replace(/\\'/g, "'");
      const parent = /'([^']+)' in parents/.exec(q)[1];
      return res({ files: [...files.values()].filter(f => f.folder && f.name === name && f.parents.includes(parent) && !f.trashed) });
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const b = JSON.parse(init.body); const f = { id: id(), name: b.name, parents: b.parents, folder: true }; files.set(f.id, f); return res({ id: f.id });
    }
    if (url.pathname === '/upload/drive/v3/files') {
      const b = JSON.parse(init.body); const f = { id: id(), name: b.name, parents: b.parents, mimeType: init.headers['X-Upload-Content-Type'], size: 1234 };
      files.set(f.id, f); return new Response(null, { status: 200, headers: { Location: `https://upload.example/${f.id}` } });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const f = files.get(decodeURIComponent(m[1]));
      if (!f) return new Response('{}', { status: 404 });
      if (method === 'PATCH') {
        const b = JSON.parse(init.body || '{}'); Object.assign(f, b);
        const add = url.searchParams.get('addParents'), rem = url.searchParams.get('removeParents');
        if (add) f.parents = [...f.parents.filter(p => p !== rem), add];
        return res({ id: f.id });
      }
      return res({ id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.size || 0), parents: f.parents, trashed: !!f.trashed });
    }
    throw new Error(`unexpected ${method} ${url}`);
  }
  return { files, fetch };
}

test('แผนการจัดการเรียนรู้: อัพโหลดเข้าโฟลเดอร์ ปี/ภาค/วิชา/หน่วย ในโฟลเดอร์ครู และจัดการได้เฉพาะเจ้าของ', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, full_name TEXT, role TEXT, status TEXT, session_version INTEGER, deleted_at TEXT);
    INSERT INTO users VALUES (1,'a@x.test','ครูเอ','teacher','active',1,NULL),(2,'b@x.test','ครูบี','teacher','active',1,NULL);
    CREATE TABLE academic_years (id INTEGER PRIMARY KEY, year_be INTEGER);
    CREATE TABLE academic_terms (id INTEGER PRIMARY KEY, academic_year_id INTEGER, term_number INTEGER, name TEXT, status TEXT);
    INSERT INTO academic_years VALUES (1, 2569); INSERT INTO academic_terms VALUES (10,1,1,'1','closed'),(11,1,2,'2','active');
    CREATE TABLE gr_subjects (id INTEGER PRIMARY KEY, academic_year_id INTEGER, name TEXT, code TEXT, grade_level TEXT, sort_order INTEGER);
    CREATE TABLE gr_courses (id INTEGER PRIMARY KEY, subject_id INTEGER, classroom TEXT);
    CREATE TABLE gr_course_teachers (course_id INTEGER, user_id INTEGER);
    INSERT INTO gr_subjects VALUES (1,1,'คณิตศาสตร์','ค14101','ป.4',1);
    INSERT INTO gr_courses VALUES (1,1,'1'),(2,1,'2'); INSERT INTO gr_course_teachers VALUES (1,1),(2,1);`);
  const fake = fakeDrive();
  const realFetch = globalThis.fetch; globalThis.fetch = fake.fetch;
  try {
    const env = { DB: d1(db), JWT_SECRET: 'local-test-only-secret-for-plans', GOOGLE_DRIVE_CLIENT_ID: 'c', GOOGLE_DRIVE_CLIENT_SECRET: 's', GOOGLE_DRIVE_REFRESH_TOKEN: 'r' };
    await ensureSchema(env);
    const tokens = await Promise.all([1, 2].map(sub => signJWT({ sub, sv: 1, app: 'tmedia' }, env.JWT_SECRET)));
    const call = async (path, method = 'GET', body, who = 1) => {
      const r = await worker.fetch(new Request(`https://tm.example.test${path}`, { method, headers: { Cookie: `${AUTH_COOKIE_NAME}=${tokens[who - 1]}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, { waitUntil() {} });
      return { status: r.status, ...(await r.json()) };
    };
    const mine = await call('/api/plans');
    assert.equal(mine.term.id, 11);
    assert.deepEqual(mine.subjects.map(s => s.label), ['คณิตศาสตร์ (ค14101) ป.4'], 'สองห้องรวมเป็นวิชาเดียว');
    const target = { term_id: 11, unit_no: 1, subject_name: 'คณิตศาสตร์', subject_code: 'ค14101', grade_level: 'ป.4' };
    assert.equal((await call('/api/plans/prepare', 'POST', { ...target, unit_no: 0 })).status, 400);
    assert.equal((await call('/api/plans/prepare', 'POST', target)).status, 200);
    const up = await call('/api/plans/uploads', 'POST', { ...target, name: 'แผนที่1.docx', size: 10, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const fileId = up.uploadUrl.split('/').pop();
    const done = await call('/api/plans/uploads/complete', 'POST', { ...target, driveFileId: fileId });
    assert.equal(done.status, 200);
    const pathOf = (id) => { const out = []; let f = fake.files.get(id); while (f) { out.unshift(f.name); f = fake.files.get(f.parents[0]); } return out.join(' / '); };
    assert.equal(pathOf(fileId), 'Teaching Media / ครูเอ / แผนการจัดการเรียนการสอน / ปีการศึกษา 2569 / ภาคเรียนที่ 2 / คณิตศาสตร์ (ค14101) ป.4 / หน่วยที่ 1 / แผนที่1.docx');
    // ครูคนอื่นแก้/ลบ/เห็นไม่ได้
    assert.equal((await call(`/api/plans/${done.id}`, 'PATCH', { title: 'x' }, 2)).status, 404);
    assert.equal((await call('/api/plans', 'GET', undefined, 2)).items.length, 0);
    assert.equal((await call('/api/plans/uploads/complete', 'POST', { ...target, driveFileId: fileId }, 2)).status, 404);
    // ย้ายไปหน่วยที่ 2 + เปลี่ยนชื่อ → ย้ายไฟล์ใน Drive ตาม
    assert.equal((await call(`/api/plans/${done.id}`, 'PATCH', { ...target, unit_no: 2, title: 'แผนหน่วย 2' })).status, 200);
    assert.match(pathOf(fileId), /หน่วยที่ 2 \/ แผนหน่วย 2\.docx$/);
    const listed = (await call('/api/plans')).items;
    assert.equal(listed[0].unit_no, 2); assert.equal(listed[0].file_name, 'แผนหน่วย 2.docx');
    // ลบ → ถังขยะ Drive
    assert.equal((await call('/api/plans/delete', 'POST', { ids: [done.id] }, 2)).count, 0);
    assert.equal((await call('/api/plans/delete', 'POST', { ids: [done.id] })).count, 1);
    assert.equal(fake.files.get(fileId).trashed, true);
    assert.equal((await call('/api/plans')).items.length, 0);
  } finally { globalThis.fetch = realFetch; }
});
