// จัดกลุ่มประเภทสื่ออัตโนมัติ จากชนิดไฟล์/นามสกุล หรือจากโดเมนของลิงก์

export const CATEGORIES = [
  { key: "image", label: "รูปภาพ" },
  { key: "video", label: "วิดีโอ" },
  { key: "audio", label: "เสียง" },
  { key: "pdf", label: "PDF" },
  { key: "document", label: "เอกสาร" },
  { key: "spreadsheet", label: "ตารางคำนวณ" },
  { key: "presentation", label: "งานนำเสนอ" },
  { key: "link", label: "ลิงก์เว็บไซต์" },
  { key: "archive", label: "ไฟล์บีบอัด" },
  { key: "other", label: "อื่น ๆ" },
];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);

const EXT = {
  image: "jpg jpeg png gif webp bmp svg heic heif tif tiff ico avif",
  video: "mp4 mov m4v webm mkv avi wmv flv 3gp mpg mpeg",
  audio: "mp3 wav m4a aac ogg oga flac wma opus amr",
  pdf: "pdf",
  document: "doc docx odt rtf txt md pages epub",
  spreadsheet: "xls xlsx xlsm ods csv tsv numbers",
  presentation: "ppt pptx pps ppsx odp key",
  archive: "zip rar 7z tar gz tgz bz2 xz",
};
const EXT_MAP = {};
for (const [cat, list] of Object.entries(EXT)) for (const e of list.split(" ")) EXT_MAP[e] = cat;

export function extOf(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : "";
}

export function categorizeFile(name, mime) {
  const t = String(mime || "").toLowerCase();
  const byExt = EXT_MAP[extOf(name)];
  if (byExt) return byExt;
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t === "application/pdf") return "pdf";
  if (/wordprocessing|msword|opendocument\.text|rtf|^text\//.test(t)) return "document";
  if (/spreadsheet|excel|csv/.test(t)) return "spreadsheet";
  if (/presentation|powerpoint/.test(t)) return "presentation";
  if (/zip|rar|7z|tar|gzip|compressed/.test(t)) return "archive";
  return "other";
}

// ข้อมูลลิงก์: ผู้ให้บริการ + ลิงก์สำหรับฝัง (ถ้าฝังได้) + หมวด
export function analyzeLink(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\.|^m\./, "").toLowerCase();
  const out = { url: u.toString(), host, provider: "web", category: "link", embed: null, thumb: null };

  let yt = null;
  if (host === "youtu.be") yt = u.pathname.slice(1).split("/")[0];
  else if (host.endsWith("youtube.com")) {
    yt = u.searchParams.get("v") || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{6,})/) || [])[1] || null;
  }
  if (yt && /^[\w-]{6,}$/.test(yt)) {
    return { ...out, provider: "youtube", category: "video", embed: `https://www.youtube.com/embed/${yt}`, thumb: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` };
  }
  const vimeo = host === "vimeo.com" && u.pathname.match(/^\/(\d+)/);
  if (vimeo) return { ...out, provider: "vimeo", category: "video", embed: `https://player.vimeo.com/video/${vimeo[1]}` };

  if (host === "docs.google.com") {
    const g = u.pathname.match(/^\/(document|spreadsheets|presentation|forms)\/d\/([\w-]+)/);
    if (g) {
      const cat = { document: "document", spreadsheets: "spreadsheet", presentation: "presentation", forms: "link" }[g[1]];
      const embed = g[1] === "forms" ? `https://docs.google.com/forms/d/${g[2]}/viewform?embedded=true` : `https://docs.google.com/${g[1]}/d/${g[2]}/preview`;
      return { ...out, provider: "google", category: cat, embed };
    }
  }
  if (host === "drive.google.com") {
    const id = (u.pathname.match(/\/file\/d\/([\w-]+)/) || [])[1] || u.searchParams.get("id");
    if (id) return { ...out, provider: "gdrive", category: "other", embed: `https://drive.google.com/file/d/${id}/preview` };
  }
  if (host.endsWith("canva.com") && /\/design\//.test(u.pathname)) {
    const base = u.origin + u.pathname.replace(/\/(edit|view|watch)?\/?$/, "");
    return { ...out, provider: "canva", category: "presentation", embed: `${base}/view?embed` };
  }
  const ext = extOf(u.pathname);
  const byExt = EXT_MAP[ext];
  if (byExt) return { ...out, category: byExt, direct: true };
  return out;
}
