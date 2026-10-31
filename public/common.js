// ใช้ร่วมกันทุกหน้า: เรียก API, ไอคอน, จัดรูปแบบข้อมูล
window.TM = (() => {
  async function api(path, options = {}) {
    const init = { credentials: "same-origin", ...options, headers: { ...(options.body && !(options.body instanceof Blob) ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } };
    if (init.body && typeof init.body === "object" && !(init.body instanceof Blob)) init.body = JSON.stringify(init.body);
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `เกิดข้อผิดพลาด (${res.status})`); e.status = res.status; throw e; }
    return data;
  }

  const P = {
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',

    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    video: '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
    audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h2a1.5 1.5 0 0 1 0 3H8v-5"/>',
    document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/>',
    spreadsheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/>',
    presentation: '<rect x="2" y="3" width="20" height="13" rx="2"/><line x1="12" y1="16" x2="12" y2="21"/><line x1="8" y1="21" x2="16" y2="21"/><polyline points="7 11 10 8 13 11 17 7"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    archive: '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>',
    other: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
    all: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    back: '<polyline points="15 18 9 12 15 6"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    restore: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    select: '<rect x="3" y="3" width="18" height="18" rx="3"/><polyline points="8 12 11 15 16 9"/>',
  };
  const icon = (name, size = 18) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || P.other}</svg>`;

  const CAT_COLORS = { image: "#E0598B", video: "#E5484D", audio: "#8E4EC6", pdf: "#D9480F", document: "#3E63DD", spreadsheet: "#2B9A66", presentation: "#E38A10", link: "#0B8BB3", archive: "#7C6F5B", other: "#68707E" };
  const CAT_LABELS = { image: "รูปภาพ", video: "วิดีโอ", audio: "เสียง", pdf: "PDF", document: "เอกสาร", spreadsheet: "ตารางคำนวณ", presentation: "งานนำเสนอ", link: "ลิงก์เว็บไซต์", archive: "ไฟล์บีบอัด", other: "อื่น ๆ" };
  const SORTS = [["newest", "ใหม่ล่าสุด"], ["oldest", "เก่าที่สุด"], ["updated", "แก้ไขล่าสุด"], ["name", "ชื่อ ก → ฮ"], ["name_desc", "ชื่อ ฮ → ก"], ["type", "ตามประเภท"], ["size", "ขนาดใหญ่ → เล็ก"]];

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function size(n) {
    if (n == null) return "";
    const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; n = Number(n);
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
  }
  function date(s) {
    if (!s) return "";
    const d = new Date(String(s).replace(" ", "T") + "Z");
    return d.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" }) + " " + d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
  }
  const pref = {
    get: (k, d) => { try { return localStorage.getItem(`tm.${k}`) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(`tm.${k}`, v); } catch {} },
  };
  function toast(msg, isError) {
    let t = document.getElementById("toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
    t.textContent = msg; t.className = `toast show${isError ? " error" : ""}`;
    clearTimeout(t._h); t._h = setTimeout(() => (t.className = "toast"), 3200);
  }
  return { api, icon, esc, size, date, pref, toast, CAT_COLORS, CAT_LABELS, SORTS };
})();
