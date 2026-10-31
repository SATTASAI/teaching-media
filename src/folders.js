// Logical folders belong to a teacher; Drive files stay in that teacher's private root.
export class FolderError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const folderId = (value) => {
  if (value == null || value === '' || value === 'root') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new FolderError('รหัสแฟ้มไม่ถูกต้อง');
  return n;
};
export async function ownFolder(env, user, value) {
  const id = folderId(value);
  if (id === null) return null;
  const f = await env.DB.prepare('SELECT * FROM tm_collections WHERE id = ? AND owner_id = ?').bind(id, user.id).first();
  if (!f) throw new FolderError('ไม่พบแฟ้มงาน', 404);
  return f;
}
export async function listFolders(env, user) {
  return (await env.DB.prepare(`SELECT f.id, f.name, f.parent_id, f.created_at,
    (SELECT COUNT(*) FROM tm_media m WHERE m.collection_id = f.id AND m.owner_id = f.owner_id AND m.deleted_at IS NULL) AS media_count
    FROM tm_collections f WHERE f.owner_id = ? ORDER BY f.name COLLATE NOCASE, f.id`).bind(user.id).all()).results || [];
}
export async function saveFolder(env, user, body, id = null) {
  const existing = id === null ? null : await ownFolder(env, user, id);
  const name = String(body.name ?? existing?.name ?? '').trim();
  if (!name || name.length > 120) throw new FolderError('กรุณาตั้งชื่อแฟ้มไม่เกิน 120 ตัวอักษร');
  const parent = Object.hasOwn(body, 'parent_id') ? folderId(body.parent_id) : (existing?.parent_id ?? null);
  await ownFolder(env, user, parent);
  let cursor = parent, depth = 0;
  while (cursor !== null) {
    if (cursor === existing?.id) throw new FolderError('ย้ายแฟ้มเข้าแฟ้มตัวเองหรือแฟ้มย่อยไม่ได้');
    if (++depth > 32) throw new FolderError('สร้างแฟ้มซ้อนได้ไม่เกิน 32 ชั้น');
    cursor = (await ownFolder(env, user, cursor)).parent_id;
  }
  if (!existing && depth + 1 > 32) throw new FolderError('สร้างแฟ้มซ้อนได้ไม่เกิน 32 ชั้น');
  if (existing && Object.hasOwn(body, 'parent_id')) {
    const descendants = (await env.DB.prepare(`WITH RECURSIVE subtree(id, depth) AS (
      SELECT id, 1 FROM tm_collections WHERE parent_id = ? AND owner_id = ?
      UNION ALL SELECT c.id, s.depth + 1 FROM tm_collections c JOIN subtree s ON c.parent_id = s.id WHERE c.owner_id = ?)
      SELECT COALESCE(MAX(depth), 0) AS depth FROM subtree`).bind(existing.id, user.id, user.id).first()).depth;
    if (depth + 1 + descendants > 32) throw new FolderError('สร้างแฟ้มซ้อนได้ไม่เกิน 32 ชั้น');
  }
  const duplicate = await env.DB.prepare('SELECT id FROM tm_collections WHERE owner_id = ? AND parent_id IS ? AND name = ? COLLATE NOCASE AND id != ?').bind(user.id, parent, name, existing?.id ?? 0).first();
  if (duplicate) throw new FolderError('มีแฟ้มชื่อนี้อยู่แล้ว', 409);
  try {
    if (existing) {
      await env.DB.prepare('UPDATE tm_collections SET name = ?, parent_id = ? WHERE id = ? AND owner_id = ?').bind(name, parent, existing.id, user.id).run();
      return { ...existing, name, parent_id: parent };
    }
    return await env.DB.prepare('INSERT INTO tm_collections (owner_id, parent_id, name) VALUES (?, ?, ?) RETURNING id, name, parent_id, created_at').bind(user.id, parent, name).first();
  } catch (e) {
    if (String(e.message).includes('UNIQUE constraint')) throw new FolderError('มีแฟ้มชื่อนี้อยู่แล้ว', 409);
    throw e;
  }
}
export async function deleteFolder(env, user, id) {
  const f = await ownFolder(env, user, id);
  if (!f) throw new FolderError('ไม่พบแฟ้มงาน', 404);
  const child = await env.DB.prepare('SELECT id FROM tm_collections WHERE parent_id = ? AND owner_id = ? LIMIT 1').bind(f.id, user.id).first();
  const file = await env.DB.prepare('SELECT id FROM tm_media WHERE collection_id = ? AND owner_id = ? AND deleted_at IS NULL LIMIT 1').bind(f.id, user.id).first();
  if (child || file) throw new FolderError('ย้ายสื่อและแฟ้มย่อยออกก่อนลบแฟ้ม', 409);
  await env.DB.batch([
    env.DB.prepare('UPDATE tm_media SET collection_id = NULL WHERE collection_id = ? AND owner_id = ?').bind(f.id, user.id),
    env.DB.prepare('DELETE FROM tm_collections WHERE id = ? AND owner_id = ?').bind(f.id, user.id),
  ]);
}
export async function moveMedia(env, user, ids, destination) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(n => !Number.isSafeInteger(n) || n < 1)) throw new FolderError('กรุณาเลือกไฟล์ไม่เกิน 500 รายการ');
  const target = folderId(destination);
  await ownFolder(env, user, target);
  const unique = [...new Set(ids)];
  const chunks = [];
  for (let i = 0; i < unique.length; i += 80) chunks.push(unique.slice(i, i + 80));
  // Keep each D1 statement below its binding limit; validate every chunk before moving anything.
  for (const chunk of chunks) {
    const marks = chunk.map(() => '?').join(',');
    const { n } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM tm_media WHERE owner_id = ? AND deleted_at IS NULL AND id IN (${marks})`).bind(user.id, ...chunk).first();
    if (n !== chunk.length) throw new FolderError('ไม่พบสื่อที่เลือกหรือไม่มีสิทธิ์เข้าถึง', 404);
  }
  await env.DB.batch(chunks.map(chunk => env.DB.prepare(`UPDATE tm_media SET collection_id = ?, updated_at = datetime('now') WHERE owner_id = ? AND deleted_at IS NULL AND id IN (${chunk.map(() => '?').join(',')})`).bind(target, user.id, ...chunk)));
  return { count: unique.length };
}
