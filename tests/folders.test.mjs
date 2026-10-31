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
        bind(...values) { if (values.length > 100) throw new Error("D1 parameter limit exceeded"); this.values = values; return this; },
        async all() { return { results: db.prepare(sql).all(...this.values) }; },
        async first() { return db.prepare(sql).get(...this.values) ?? null; },
        async run() { return { meta: db.prepare(sql).run(...this.values) }; },
      };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try { const result = []; for (const s of statements) result.push(await s.run()); db.exec('COMMIT'); return result; }
      catch(e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

test('แฟ้มส่วนตัว: migration, CRUD, ย้ายสื่อ และตรวจสิทธิ์ผ่าน authenticated API', async t => {
  const db = new DatabaseSync(':memory:');
  // Existing production-shaped table before additive migration.
  db.exec(`CREATE TABLE tm_media (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, kind TEXT NOT NULL,
    title TEXT NOT NULL, description TEXT, category TEXT NOT NULL, category_auto TEXT NOT NULL, file_name TEXT, ext TEXT,
    mime_type TEXT, file_size INTEGER, drive_file_id TEXT, drive_folder_id TEXT, preview_drive_id TEXT,
    url TEXT, link_provider TEXT, link_embed TEXT, link_thumb TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), deleted_at TEXT);
    INSERT INTO tm_media (owner_id, kind, title, category, category_auto, drive_file_id) VALUES (1,'file','Old lesson','image','image','retained-drive-id');
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, full_name TEXT, role TEXT, status TEXT, session_version INTEGER, deleted_at TEXT);
    INSERT INTO users VALUES (1,'one@example.test','Teacher one','teacher','active',1,NULL),(2,'two@example.test','Teacher two','teacher','active',1,NULL);`);
  const env = { DB: d1(db), JWT_SECRET: 'local-test-only-secret-for-teaching-media-folder-api' };
  await ensureSchema(env);
  const tokens = await Promise.all([1,2].map(sub => signJWT({sub, sv:1, app:'tmedia'}, env.JWT_SECRET)));
  async function request(path, method = 'GET', body, owner = 1) {
    const response = await worker.fetch(new Request(`https://media.example.test${path}`, {
      method, headers: { Cookie: `${AUTH_COOKIE_NAME}=${tokens[owner-1]}`, 'Content-Type':'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), env, {waitUntil() {}});
    return {status: response.status, ...(await response.json())};
  }
  let root, grade, unit;
  await t.test('migration preserves existing media and Drive reference', () => {
    const item = db.prepare('SELECT * FROM tm_media WHERE id=1').get();
    assert.equal(item.collection_id, null); assert.equal(item.favorite, 0); assert.equal(item.drive_file_id,'retained-drive-id');
  });
  await t.test('create subject/grade/unit folders, reject duplicate siblings', async () => {
    let r = await request('/api/folders','POST',{name:'ภาษาอังกฤษ'}); assert.equal(r.status,201); root=r.folder.id;
    r = await request('/api/folders','POST',{name:'ป.4',parent_id:root}); assert.equal(r.status,201); grade=r.folder.id;
    r = await request('/api/folders','POST',{name:'Wild Animals',parent_id:grade}); unit=r.folder.id;
    assert.equal((await request('/api/folders','POST',{name:'ภาษาอังกฤษ'})).status,409);
    assert.equal((await request('/api/folders','POST',{name:'   '})).status,400);
    assert.equal((await request('/api/folders','POST',{name:'Invalid',parent_id:-1})).status,400);
  });
  await t.test('prevent cycles and reject cross-owner folder access', async () => {
    assert.equal((await request(`/api/folders/${root}`,'PATCH',{parent_id:unit})).status,400);
    assert.equal((await request(`/api/folders/${root}`,'PATCH',{name:'Hacked'},2)).status,404);
    assert.equal((await request('/api/folders','POST',{name:'Other user child',parent_id:root},2)).status,404);
    assert.equal((await request('/api/folders','GET',undefined,2)).folders.length,0);
    assert.equal((await request(`/api/media?folder=${unit}`,'GET',undefined,2)).status,404);
  });
  await t.test('move existing files, browse per folder, preserve Drive storage', async () => {
    assert.equal((await request('/api/media/move','POST',{ids:[1],collection_id:unit})).status,200);
    const listing = await request(`/api/media?folder=${unit}`); assert.equal(listing.items.length,1); assert.equal(listing.items[0].collection_id,unit);
    assert.equal((await request('/api/media?folder=root')).items.length,0);
    assert.equal(db.prepare('SELECT drive_file_id FROM tm_media WHERE id=1').get().drive_file_id,'retained-drive-id');
    const foreign = await request('/api/folders','POST',{name:'Private'},2);
    assert.equal((await request('/api/media/move','POST',{ids:[1],collection_id:foreign.folder.id})).status,404);
    assert.equal((await request('/api/media/move','POST',{ids:[1],collection_id:null},2)).status,404);
    assert.equal((await request('/api/media/move','POST',{ids:[1,999],collection_id:null})).status,404);
    assert.equal(db.prepare('SELECT collection_id FROM tm_media WHERE id=1').get().collection_id,unit);
  });
  await t.test('persist link into current folder and favorites into API', async () => {
    const r = await request('/api/links','POST',{url:'https://example.test/lesson',title:'Animal lesson',collection_id:unit});
    assert.equal(r.status,200);
    const listed = await request(`/api/media?folder=${unit}`); assert.equal(listed.items.length,2);
    assert.equal((await request(`/api/media/${r.id}`,'PATCH',{favorite:true})).status,200);
    assert.equal((await request('/api/media?favorites=1')).items[0].id,r.id);
    assert.equal((await request(`/api/media/${r.id}`,'PATCH',{favorite:false},2)).status,404);
  });
  await t.test('rename and reparent folders, refuse deleting nonempty folder', async () => {
    assert.equal((await request(`/api/folders/${unit}`,'PATCH',{name:'Animals',parent_id:root})).status,200);
    assert.equal((await request('/api/folders')).folders.find(f=>f.id===unit).name,'Animals');
    assert.equal((await request(`/api/folders/${root}`,'DELETE')).status,409);
    assert.equal((await request(`/api/folders/${unit}`,'DELETE')).status,409);
    assert.equal((await request(`/api/folders/${grade}`,'DELETE')).status,200);
    assert.equal((await request('/api/folders')).folders.some(f=>f.id===grade),false);
    assert.equal((await request(`/api/folders/${unit}`,'DELETE',undefined,2)).status,404);
  });
  await t.test('reject foreign-folder uploads before any Drive request', async () => {
    const r = await request('/api/uploads/complete','POST',{driveFileId:'not-a-live-file',collection_id:unit},2);
    assert.equal(r.status,404);
  });
  await t.test('folder depth limit rejects a 33rd level', async () => {
    let parent = null;
    for (let i=0; i<32; i++) { const r = await request('/api/folders','POST',{name:`Depth ${i}`,parent_id:parent}); assert.equal(r.status,201); parent=r.folder.id; }
    assert.equal((await request('/api/folders','POST',{name:'Too deep',parent_id:parent})).status,400);
  });
  await t.test('large selections stay under D1 binding limits and move together', async () => {
    const ids=[];
    for (let i=0; i<120; i++) ids.push(Number(db.prepare("INSERT INTO tm_media (owner_id, kind, title, category, category_auto) VALUES (1,'link',?,'link','link')").run(`Bulk ${i}`).lastInsertRowid));
    const r=await request('/api/media/move','POST',{ids,collection_id:root});
    assert.equal(r.status,200); assert.equal(r.count,120);
    assert.equal((await request(`/api/media?folder=${root}`)).items.length,120);
  });
  await t.test('move back to root and delete only empty folder', async () => {
    const files = (await request(`/api/media?folder=${unit}`)).items.map(f=>f.id);
    assert.equal((await request('/api/media/move','POST',{ids:files,collection_id:null})).status,200);
    assert.equal((await request(`/api/folders/${unit}`,'DELETE')).status,200);
    assert.equal((await request('/api/media?folder=root')).items.length,2);
  });
  db.close();
});
