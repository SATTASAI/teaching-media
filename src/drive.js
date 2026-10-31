// Google Drive: บัญชีเดียวกับระบบ system (OAuth refresh token)
// โครงสร้าง: Teaching Media / <ชื่อครู> / ไฟล์สื่อ   และ Teaching Media / _ตัวอย่างไฟล์ (ระบบ) / PDF ที่แปลงไว้แสดงตัวอย่าง

const API = "https://www.googleapis.com/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";

export function driveConfigError(env) {
  const missing = ["GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET", "GOOGLE_DRIVE_REFRESH_TOKEN"].filter((k) => !env[k]);
  return missing.length ? `ยังไม่ได้ตั้งค่า Google Drive: ${missing.join(", ")}` : null;
}

let cachedToken = null;
export async function accessToken(env) {
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.token;
  const err = driveConfigError(env);
  if (err) throw new Error(err);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: String(env.GOOGLE_DRIVE_CLIENT_ID),
      client_secret: String(env.GOOGLE_DRIVE_CLIENT_SECRET),
      refresh_token: String(env.GOOGLE_DRIVE_REFRESH_TOKEN),
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`เชื่อมต่อ Google Drive ไม่สำเร็จ (${res.status})${data?.error === "invalid_grant" ? " · โทเคนหมดอายุ ต้องเชื่อมต่อใหม่" : ""}`);
  }
  cachedToken = { token: data.access_token, exp: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

export async function driveFetch(env, path, options = {}, { raw = false } = {}) {
  const token = await accessToken(env);
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  const url = path.startsWith("http") ? path : path.startsWith("/upload/") ? `https://www.googleapis.com${path}` : `${API}${path}`;
  const res = await fetch(url, { ...options, headers });
  if (raw) return res;
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google Drive ตอบกลับ ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return res;
}

export const escapeQuery = (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
export const cleanName = (v) => String(v || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

export async function findFolder(env, name, parent) {
  const q = `name = '${escapeQuery(name)}' and mimeType = '${FOLDER}' and trashed = false and '${escapeQuery(parent)}' in parents`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const data = await (await driveFetch(env, `/files?${params}`)).json();
  return data.files?.[0]?.id || null;
}

export async function createFolder(env, name, parent) {
  const res = await driveFetch(env, "/files?fields=id&supportsAllDrives=true", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
  });
  return (await res.json()).id;
}

export async function findOrCreateFolder(env, name, parent) {
  return (await findFolder(env, name, parent)) || createFolder(env, name, parent);
}

export async function getMeta(env, fileId, fields = "id,name,mimeType,size,parents,trashed,thumbnailLink") {
  const res = await driveFetch(env, `/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`, {}, { raw: true });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Google Drive ตอบกลับ ${res.status}`);
  return res.json();
}

export async function patchFile(env, fileId, body, query = "") {
  await driveFetch(env, `/files/${encodeURIComponent(fileId)}?supportsAllDrives=true${query}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ย้ายไปถังขยะ Drive (กู้คืนได้ 30 วัน)
export const trashFile = (env, id) => id ? patchFile(env, id, { trashed: true }) : null;

export async function deleteForever(env, id) {
  if (!id) return;
  await driveFetch(env, `/files/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: "DELETE" }, { raw: true });
}

// สร้าง resumable upload session ให้เบราว์เซอร์ส่งไฟล์ตรงเข้า Drive (ไม่จำกัดขนาด ไม่ผ่าน Worker)
// ต้องส่ง Origin ของเว็บไปด้วย เพื่อให้ Google อนุญาต CORS ตอนเบราว์เซอร์ PUT ไฟล์
export async function createUploadSession(env, { name, mimeType, size, parent, origin }) {
  const headers = { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mimeType || "application/octet-stream" };
  if (size != null) headers["X-Upload-Content-Length"] = String(size);
  if (origin) headers.Origin = origin;
  const res = await driveFetch(env, "/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size", {
    method: "POST",
    headers,
    body: JSON.stringify({ name, parents: [parent] }),
  });
  const location = res.headers.get("Location");
  if (!location) throw new Error("Google Drive ไม่ได้ส่งที่อยู่สำหรับอัพโหลด");
  return location;
}

export async function uploadSmall(env, parent, name, mimeType, bytes) {
  const boundary = `tm_${crypto.randomUUID()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, mimeType, parents: [parent] })}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, bytes, `\r\n--${boundary}--`,
  ]);
  const res = await driveFetch(env, "/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id", {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  });
  return (await res.json()).id;
}

// สตรีมไฟล์ (รองรับ Range สำหรับวิดีโอ/เสียง)
export function fetchMedia(env, fileId, range) {
  const headers = range ? { Range: range } : {};
  return driveFetch(env, `/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, { headers }, { raw: true });
}

export async function fetchThumbnail(env, fileId, size) {
  const meta = await getMeta(env, fileId, "thumbnailLink");
  if (!meta?.thumbnailLink) return null;
  const url = meta.thumbnailLink.replace(/=s\d+(-c)?$/, "") + `=s${size}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken(env)}` } });
  return res.ok ? res : null;
}

// แปลงไฟล์ Office เป็น PDF สำหรับแสดงตัวอย่าง: คัดลอกเป็นไฟล์ Google → ส่งออก PDF → เก็บ PDF → ลบสำเนา
const GOOGLE_TYPES = { document: "application/vnd.google-apps.document", spreadsheet: "application/vnd.google-apps.spreadsheet", presentation: "application/vnd.google-apps.presentation" };
export async function convertToPdf(env, fileId, category, name, previewFolder) {
  const target = GOOGLE_TYPES[category];
  if (!target) return null;
  const copy = await (await driveFetch(env, `/files/${encodeURIComponent(fileId)}/copy?supportsAllDrives=true&fields=id`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `_preview_${name}`, mimeType: target, parents: [previewFolder] }),
  })).json();
  try {
    const pdf = await (await driveFetch(env, `/files/${copy.id}/export?mimeType=application/pdf`)).arrayBuffer();
    return await uploadSmall(env, previewFolder, `${name}.pdf`, "application/pdf", pdf);
  } finally {
    await deleteForever(env, copy.id);
  }
}
