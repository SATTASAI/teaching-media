// พื้นที่แสดงสื่อทั้งหมด (อยู่ใน iframe ของหน้าหลัก) — จัดเรียง, มุมมองตาราง/รายการ, ตัวอย่างไฟล์ทุกชนิด, จัดการสื่อ
(() => {
  const { api, icon, esc, size, date, pref, toast, CAT_COLORS, CAT_LABELS, SORTS } = TM;
  const $ = (id) => document.getElementById(id);
  const getHost = () => window.parent !== window ? window.parent.TMApp : null;
  const TEXT_EXT = new Set(["txt", "csv", "tsv", "md", "json", "xml", "html", "htm", "css", "js", "py", "java", "c", "cpp", "srt", "vtt", "log"]);
  const OFFICE = new Set(["document", "spreadsheet", "presentation"]);
  const st = { items: [], category: "all", trash: false, sort: "newest", q: "", view: pref.get("view", "list"), selecting: false, selected: new Set(), openId: null, folders: [], folderId: null, section: "home", full: false };

  const reload = () => (getHost() ? getHost().reload() : standalone());
  async function standalone() {
    const p = new URLSearchParams({ sort: st.sort });
    if (st.trash) p.set("trash", "1");
    const d = await api(`/api/media?${p}`).catch(() => ({ items: [] }));
    render({ items: d.items, category: "all", trash: st.trash, sort: st.sort });
  }

  // ---------- ภาพย่อ ----------
  function thumb(it) {
    const fallback = `<div class="th-ic" style="--c:${CAT_COLORS[it.category]}">${icon(it.category, 34)}<small>${esc((it.ext || it.link_provider || "").toUpperCase())}</small></div>`;
    let src = null;
    if (it.kind === "link") src = it.link_thumb;
    else if (["image", "video", "pdf", "document", "spreadsheet", "presentation"].includes(it.category_auto)) src = `/thumb/${it.id}?v=${encodeURIComponent(it.updated_at)}`;
    if (!src) return fallback;
    return `<img loading="lazy" src="${esc(src)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{innerHTML:this.dataset.fb}).firstChild)" data-fb="${esc(fallback)}">${it.category === "video" ? `<span class="play">${icon("video", 16)}</span>` : ""}`;
  }

  function card(it) {
    const sel = st.selected.has(it.id);
    const meta = it.kind === "link" ? esc(it.link_provider === "web" ? new URL(it.url).hostname : it.link_provider) : size(it.file_size);
    return `<article tabindex="0" role="button" aria-label="${esc(it.title)}" class="card${sel ? " sel" : ""}${it.id === st.openId ? " active" : ""}" data-id="${it.id}"${st.trash ? "" : ' draggable="true"'}>
      <div class="th">${thumb(it)}${st.selecting ? `<span class="tick">${sel ? icon("check", 14) : ""}</span>` : ""}</div>
      <div class="card-b"><b title="${esc(it.title)}">${esc(it.title)}</b>
        <div class="card-m"><span class="chip" style="background:${CAT_COLORS[it.category]}">${esc(CAT_LABELS[it.category])}</span><span>${meta}</span></div>
        <small class="muted">${date(st.trash ? it.deleted_at : it.created_at)}</small></div></article>`;
  }

  function row(it) {
    const sel = st.selected.has(it.id);
    return `<div class="row${sel ? " sel" : ""}${it.id === st.openId ? " active" : ""}" data-id="${it.id}"${st.trash ? "" : ' draggable="true"'} tabindex="0" role="button" aria-label="${esc(it.title)}">
      <input type="checkbox" class="file-check" data-check="${it.id}" aria-label="เลือก ${esc(it.title)}"${sel ? " checked" : ""}>
      <span class="row-thumb">${thumb(it)}</span><b title="${esc(it.title)}">${esc(it.title)}</b>
      <span class="muted row-type">${esc((it.ext || CAT_LABELS[it.category]).toUpperCase())}</span>
      <span class="muted row-size">${it.kind === "link" ? "ลิงก์" : size(it.file_size)}</span>
      <span class="muted row-date">${date(st.trash ? it.deleted_at : it.updated_at)}</span></div>`;
  }

  function groupLabel(it) {
    if (st.sort === "type") return CAT_LABELS[it.category];
    if (["newest", "oldest", "updated"].includes(st.sort)) {
      const d = new Date(String(st.sort === "updated" ? it.updated_at : it.created_at).replace(" ", "T") + "Z");
      return d.toLocaleDateString("th-TH", { month: "long", year: "numeric" });
    }
    return null;
  }

  function renderFolders() {
    const show = ["home", "folder", "manage"].includes(st.section) && !st.q;
    const children = show ? st.folders.filter(f => f.parent_id === (st.folderId ?? null)) : [];
    $("folderGrid").hidden = !show;
    $("folderGrid").innerHTML = children.map(f => `<article class="folder-card">
      <button class="folder-open" data-folder="${f.id}">${icon("folder", 34)}<span><b>${esc(f.name)}</b><small>${f.media_count} สื่อ · ${st.folders.filter(c => c.parent_id === f.id).length} แฟ้มย่อย</small></span></button>
      <div class="folder-card-actions"><button class="btn btn-icon" data-folder-edit="${f.id}" aria-label="จัดการแฟ้ม ${esc(f.name)}" title="เปลี่ยนชื่อหรือย้ายแฟ้ม">${icon("edit", 14)}</button><button class="btn btn-icon" data-folder-delete="${f.id}" aria-label="ลบแฟ้ม ${esc(f.name)}">${icon("trash", 14)}</button></div></article>`).join("");
    if (st.section === "manage" && !children.length) $("folderGrid").innerHTML = `<div class="folder-onboarding">${icon("folder", 44)}<h2>เริ่มจัดสื่อเป็นแฟ้มงาน</h2><p>สร้างแฟ้มรายวิชา แล้วเพิ่มแฟ้มย่อยตามระดับชั้นหรือหน่วยการเรียนรู้</p><button class="btn btn-primary" data-new-folder>${icon("plus", 16)} สร้างแฟ้มแรก</button></div>`;
    const current = st.folders.find(f => f.id === st.folderId);
    $("folderContext").hidden = !current;
    $("folderContext").innerHTML = current ? `<details class="folder-menu"><summary aria-label="จัดการแฟ้มนี้" title="จัดการแฟ้มนี้">${icon("menu", 17)}</summary><div><button class="btn btn-sm" data-folder-edit="${current.id}">${icon("edit", 14)} เปลี่ยนชื่อ / ย้ายแฟ้ม</button><button class="btn btn-sm" data-folder-delete="${current.id}">${icon("trash", 14)} ลบแฟ้มว่าง</button></div></details>` : "";
    const path = []; let cursor = current;
    while (cursor && path.length < 33) { path.unshift(cursor); cursor = st.folders.find(f => f.id === cursor.parent_id); }
    $("crumbPath").innerHTML = path.length ? path.map(f => `<span aria-hidden="true">›</span><button data-folder="${f.id}">${esc(f.name)}</button>`).join("") : `<span aria-hidden="true">›</span><b>${esc(st.section === "manage" ? "จัดการแฟ้มงาน" : st.section === "favorites" ? "รายการโปรด" : st.section === "recent" ? "สื่อที่เพิ่มล่าสุด" : st.trash ? "ถังขยะ" : "หน้าแรก")}</b>`;
  }
  function renderMain() {
    renderFolders();
    document.body.classList.toggle("managing-folders", st.section === "manage");
    $("quickUpload").hidden = st.section === "manage";
    $("quickPlanUpload").hidden = st.section !== "home" || st.trash;
    $("quickCreateFolder").classList.toggle("btn-primary", st.section === "manage");
    const folder = st.folders.find(f => f.id === st.folderId);
    const sectionTitle = st.section === "manage" ? "จัดการแฟ้มงาน" : st.section === "favorites" ? "รายการโปรด" : st.section === "recent" ? "สื่อที่เพิ่มล่าสุด" : null;
    const title = folder?.name || sectionTitle || (st.trash ? "ถังขยะ" : st.category === "all" ? "สื่อทั้งหมด" : CAT_LABELS[st.category]);
    $("vTitle").textContent = st.q ? `${title} · ค้นหา “${st.q}”` : title;
    $("typeFilter").value = st.category;
    $("librarySearch").value = st.q || "";
    $("inlineDrop").hidden = st.trash || st.section === "manage";
    $("vCount").textContent = st.section === "manage" ? `${st.folders.length} แฟ้มงาน · สร้างและจัดระเบียบแฟ้มของคุณ` : `${st.items.length} รายการ`;
    $("emptyTrashBtn").hidden = !st.trash || !st.items.length;
    $("viewSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.view === st.view));
    if (st.section === "manage") { $("vMain").innerHTML = ""; return; }
    if (!st.items.length) {
      $("vMain").innerHTML = st.trash
        ? `<div class="empty">${icon("trash", 46)}<p>ถังขยะว่าง</p></div>`
        : `<div class="empty">${icon("layers", 46)}<p>${st.q ? "ไม่พบสื่อที่ค้นหา" : "ยังไม่มีสื่อ เริ่มอัพโหลดสื่อการสอนของคุณได้เลย"}</p>
           ${st.q ? "" : `<div style="display:flex;gap:8px;justify-content:center"><button class="btn btn-primary" data-act="upload">${icon("upload", 16)} อัพโหลดไฟล์</button><button class="btn" data-act="link">${icon("link", 16)} วางลิงก์</button></div>`}</div>`;
      return;
    }
    const groups = [];
    for (const it of st.items) {
      const g = groupLabel(it);
      if (!groups.length || groups[groups.length - 1].label !== g) groups.push({ label: g, items: [] });
      groups[groups.length - 1].items.push(it);
    }
    if (st.view === "list") {
      $("vMain").innerHTML = `<div class="row-heading"><span>ชื่อไฟล์</span><span>ประเภท</span><span>ขนาด</span><span>แก้ไขล่าสุด</span></div><div class="rows">${st.items.map(row).join("")}</div>`;
      return;
    }
    $("vMain").innerHTML = groups.map((g) => `${g.label ? `<h2 class="g-head">${esc(g.label)} <span class="muted">${g.items.length}</span></h2>` : ""}
      <div class="${st.view === "grid" ? "grid" : "rows"}">${g.items.map(st.view === "grid" ? card : row).join("")}</div>`).join("");
  }

  function renderBulk() {
    $("bulkBar").hidden = !st.selecting;
    $("selectBtn").innerHTML = `${icon("select", 15)} ${st.selecting ? "เลิกเลือก" : "เลือกหลายรายการ"}`;
    $("bulkCount").textContent = `เลือก ${st.selected.size} รายการ`;
    const cats = `<select class="input input-sm" id="bulkCat"><option value="">ย้ายไปหมวด…</option><option value="auto">ให้ระบบจัดอัตโนมัติ</option>${Object.entries(CAT_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>`;
    $("bulkActions").innerHTML = st.trash
      ? `<button class="btn btn-sm" data-bulk="restore">${icon("restore", 14)} กู้คืน</button><button class="btn btn-sm btn-danger" data-bulk="delete">${icon("x", 14)} ลบถาวร</button>`
      : `<button class="btn btn-sm" data-move-selected>${icon("folder", 14)} ย้ายไปแฟ้ม</button>${cats}<button class="btn btn-sm btn-danger" data-bulk="trash">${icon("trash", 14)} ย้ายไปถังขยะ</button>`;
  }

  function render(data) {
    const contextChanged = st.folderId !== data.folderId || st.section !== data.section;
    Object.assign(st, data);
    if (contextChanged && st.openId) closePreview();
    st.selected = new Set([...st.selected].filter((id) => st.items.some((i) => i.id === id)));
    $("sortSel").value = st.sort;
    renderMain(); renderBulk();
    if (st.openId && !$("pv").hidden) {
      const it = st.items.find((i) => i.id === st.openId);
      if (it) showPreview(it, false); else closePreview();
    }
  }

  // ---------- ตัวอย่างไฟล์ ----------
  function previewBody(it) {
    const f = `/file/${it.id}`;
    if (it.kind === "link") {
      if (it.link_embed) return `<iframe src="${esc(it.link_embed)}" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
      if (it.category === "image") return `<img class="pv-img" src="${esc(it.url)}" alt="">`;
      if (it.category === "video") return `<video controls src="${esc(it.url)}"></video>`;
      if (it.category === "audio") return `<div class="pv-center"><audio controls src="${esc(it.url)}"></audio></div>`;
      return `<div class="pv-center pv-link">${icon("link", 48)}<b>${esc(it.title)}</b><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.url)}</a>
        <a class="btn btn-primary" href="${esc(it.url)}" target="_blank" rel="noopener">${icon("external", 16)} เปิดเว็บไซต์</a>
        <details><summary class="muted">ลองแสดงหน้าเว็บในนี้</summary><iframe class="pv-web" src="${esc(it.url)}" sandbox="allow-scripts allow-same-origin allow-popups allow-forms"></iframe></details></div>`;
    }
    const c = it.category_auto;
    if (c === "image") return `<img class="pv-img" src="${f}" alt="">`;
    if (c === "video") return `<video controls preload="metadata" src="${f}"></video>`;
    if (c === "audio") return `<div class="pv-center">${icon("audio", 56)}<audio controls preload="metadata" src="${f}"></audio></div>`;
    if (c === "pdf") return `<iframe src="${f}"></iframe>`;
    if (TEXT_EXT.has(it.ext)) return `<pre class="pv-text" data-text="${it.id}">กำลังโหลด…</pre>`;
    if (OFFICE.has(c)) return `<div class="pv-loading" data-office="${it.id}">${icon("layers", 40)}<p>กำลังเตรียมตัวอย่างไฟล์ (ครั้งแรกอาจใช้เวลาสักครู่)…</p></div><iframe class="pv-office" hidden></iframe>`;
    return `<div class="pv-center"><div class="pv-thumb">${thumb(it)}</div><p class="muted">ไฟล์ชนิดนี้ (${esc((it.ext || "ไม่ทราบชนิด").toUpperCase())}) แสดงตัวอย่างในเบราว์เซอร์ไม่ได้</p>
      <a class="btn btn-primary" href="${f}?download=1">${icon("download", 16)} ดาวน์โหลดไฟล์</a></div>`;
  }

  function showPreview(it, rebuild = true) {
    if (it.id !== st.openId) st.full = false;
    st.openId = it.id;
    getHost()?.setActive(it.id);
    $("pv").hidden = false;
    $("pv").classList.toggle("fullscreen", st.full);
    document.body.classList.add("preview-open");
    $("pvTitle").textContent = it.title;
    $("pvMeta").textContent = [CAT_LABELS[it.category], it.kind === "file" ? `${it.file_name} · ${size(it.file_size)}` : it.url, date(it.created_at)].filter(Boolean).join(" · ");
    const dl = it.kind === "file" ? `<a class="btn btn-sm" href="/file/${it.id}?download=1">${icon("download", 15)} ดาวน์โหลด</a>` : `<a class="btn btn-sm" href="${esc(it.url)}" target="_blank" rel="noopener">${icon("external", 15)} เปิดลิงก์</a>`;
    const newTab = it.kind === "file" && ["image", "video", "audio", "pdf"].includes(it.category_auto) ? `<a class="btn btn-sm" href="/file/${it.id}" target="_blank">${icon("external", 15)} เปิดแท็บใหม่</a>` : "";
    $("pvActions").innerHTML = st.trash
      ? `<button class="btn btn-sm" data-pv="restore">${icon("restore", 15)} กู้คืน</button><button class="btn btn-sm btn-danger" data-pv="delete">${icon("x", 15)} ลบถาวร</button>`
      : `<button class="btn btn-sm btn-primary" data-pv="expand">${icon("external", 15)} ดูตัวอย่าง</button>${dl}<details class="pv-more"><summary aria-label="จัดการสื่อ">${icon("menu", 15)}</summary><div>${newTab}<button class="btn btn-sm" data-pv="move">${icon("folder", 15)} ย้ายแฟ้ม</button><button class="btn btn-sm" data-pv="favorite">${icon("star", 15)} ${it.favorite ? "เลิกโปรด" : "รายการโปรด"}</button><button class="btn btn-sm" data-pv="edit">${icon("edit", 15)} แก้ไข</button><button class="btn btn-sm btn-danger" data-pv="trash">${icon("trash", 15)} ลบ</button></div></details>`;
    const detailRows = [["ชื่อไฟล์", it.file_name || it.title], ["ประเภท", CAT_LABELS[it.category]], ["ขนาด", it.kind === "file" ? size(it.file_size) : "ลิงก์เว็บไซต์"], ["แก้ไขล่าสุด", date(it.updated_at)]];
    $("pvDetails").innerHTML = detailRows.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join("");
    $("pvDesc").hidden = !it.description;
    $("pvDesc").textContent = it.description || "";
    $("pvBack").innerHTML = icon("x");
    $("pvBack").setAttribute("aria-label", "ปิดตัวอย่าง");
    if (!rebuild) return;
    const thumbnailPreview = !st.full && it.kind === "file" && ["pdf", "document", "presentation", "spreadsheet"].includes(it.category_auto);
    $("pvBody").innerHTML = thumbnailPreview ? `<div class="pv-page-thumb">${thumb(it)}</div>` : previewBody(it);
    const pre = $("pvBody").querySelector("[data-text]");
    if (pre) fetch(`/file/${it.id}?text=1`).then((r) => r.text()).then((t) => (pre.textContent = t || "(ไฟล์ว่าง)")).catch(() => (pre.textContent = "โหลดไฟล์ไม่สำเร็จ"));
    const office = $("pvBody").querySelector(".pv-office");
    if (office) {
      // ตรวจก่อนว่าแปลงเป็น PDF ได้ไหม แล้วค่อยแสดง
      fetch(`/preview/${it.id}`, { method: "GET" }).then(async (r) => {
        const box = $("pvBody").querySelector("[data-office]");
        if (r.ok) { r.body?.cancel(); box?.remove(); office.src = `/preview/${it.id}`; office.hidden = false; }
        else if (box) box.innerHTML = `${icon("other", 40)}<p>${esc(await r.text())}</p><a class="btn btn-primary" href="/file/${it.id}?download=1">${icon("download", 16)} ดาวน์โหลดไฟล์</a>`;
      });
    }
    renderMain();
  }
  function closePreview() {
    $("pv").hidden = true; st.full = false; $("pv").classList.remove("fullscreen"); document.body.classList.remove("preview-open"); $("pvBody").innerHTML = ""; st.openId = null;
    getHost()?.setActive(null); renderMain();
  }

  // ---------- แก้ไข / ลบ ----------
  function openEdit(it) {
    const f = $("editForm");
    f.title.value = it.title; f.description.value = it.description || "";
    $("editUrlField").hidden = it.kind !== "link"; f.url.value = it.url || ""; f.url.required = it.kind === "link";
    $("editCat").innerHTML = `<option value="auto">ให้ระบบจัดอัตโนมัติ (${esc(CAT_LABELS[it.category_auto])})</option>` +
      Object.entries(CAT_LABELS).map(([k, v]) => `<option value="${k}"${k === it.category && it.category !== it.category_auto ? " selected" : ""}>${v}</option>`).join("");
    f.dataset.id = it.id;
    $("editModal").classList.add("open");
  }

  async function bulk(action, ids, extra = {}) {
    if (action === "delete" && !confirm(`ลบถาวร ${ids.length} รายการ? ไฟล์จะถูกย้ายไปถังขยะของ Google Drive`)) return false;
    try {
      await api("/api/media/bulk", { method: "POST", body: { action, ids, ...extra } });
      toast({ trash: "ย้ายไปถังขยะแล้ว", restore: "กู้คืนแล้ว", delete: "ลบถาวรแล้ว", category: "เปลี่ยนหมวดแล้ว" }[action]);
      reload(); return true;
    } catch (e) { toast(e.message, true); return false; }
  }

  // ---------- เหตุการณ์ ----------
  $("headingIcon").innerHTML = icon("folder", 34);
  $("quickUpload").innerHTML = `${icon("upload", 17)} อัปโหลดสื่อ`;
  $("quickCreateFolder").innerHTML = `${icon("folder", 17)} สร้างโฟลเดอร์`;
  $("quickUpload").onclick = () => getHost()?.openUpload();
  $("quickPlanUpload").innerHTML = `${icon("book", 17)} อัพโหลดแผนการจัดการเรียนรู้`;
  $("quickPlanUpload").onclick = () => getHost()?.openPlanUpload();
  $("quickCreateFolder").onclick = () => getHost()?.createFolder();
  $("crumbHome").onclick = () => getHost()?.home();
  $("typeFilter").innerHTML = `<option value="all">ทุกประเภทไฟล์</option>` + Object.entries(CAT_LABELS).map(([key, label]) => `<option value="${key}">${label}</option>`).join("");
  $("typeFilter").onchange = e => getHost()?.setCategory(e.target.value);
  document.addEventListener("click", e => {
    const folder = e.target.closest("[data-folder]"); if (folder) return getHost()?.openFolder(folder.dataset.folder);
    const edit = e.target.closest("[data-folder-edit]"); if (edit) return getHost()?.editFolder(edit.dataset.folderEdit);
    const del = e.target.closest("[data-folder-delete]"); if (del) return getHost()?.deleteFolder(del.dataset.folderDelete);
    if (e.target.closest("[data-new-folder]")) getHost()?.createFolder();
  });
  $("librarySearchIcon").innerHTML = icon("search", 18);
  let searchTimer;
  $("librarySearch").oninput = (e) => { const q = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => getHost()?.setQuery(q.trim()), 300); };
  const inlineDrop = $("inlineDrop");
  $("inlineDropIcon").innerHTML = icon("upload", 38);
  inlineDrop.onclick = () => getHost()?.openUpload();
  inlineDrop.onkeydown = (e) => { if (["Enter", " "].includes(e.key)) { e.preventDefault(); getHost()?.openUpload(); } };
  inlineDrop.ondragover = (e) => { if (dragIds) return; e.preventDefault(); inlineDrop.classList.add("over"); };
  inlineDrop.ondragleave = () => inlineDrop.classList.remove("over");
  inlineDrop.ondrop = (e) => { e.preventDefault(); inlineDrop.classList.remove("over"); if (e.dataTransfer.files.length) getHost()?.uploadFiles(e.dataTransfer.files); };
  $("vMain").onkeydown = (e) => { if (["Enter", " "].includes(e.key) && e.target.matches("[data-id]")) { e.preventDefault(); e.target.click(); } };

  $("sortSel").innerHTML = SORTS.map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  $("sortSel").onchange = (e) => (getHost() ? getHost().setSort(e.target.value) : ((st.sort = e.target.value), standalone()));
  const seg = $("viewSeg").querySelectorAll("button");
  seg[0].innerHTML = icon("grid", 15); seg[1].innerHTML = icon("list", 15);
  $("viewSeg").onclick = (e) => { const b = e.target.closest("[data-view]"); if (!b) return; st.view = b.dataset.view; pref.set("view", st.view); renderMain(); };
  $("selectBtn").onclick = () => { st.selecting = !st.selecting; st.selected.clear(); renderBulk(); renderMain(); };
  $("bulkCancel").onclick = () => $("selectBtn").click();
  $("bulkAll").onclick = () => { st.selected = new Set(st.items.map((i) => i.id)); renderBulk(); renderMain(); };
  $("emptyTrashBtn").innerHTML = `${icon("trash", 14)} ล้างถังขยะ`;
  $("emptyTrashBtn").onclick = async () => {
    if (!confirm("ลบทุกรายการในถังขยะถาวร?")) return;
    try { const r = await api("/api/trash/empty", { method: "POST" }); toast(`ลบถาวร ${r.count} รายการ`); reload(); } catch (e) { toast(e.message, true); }
  };
  $("bulkBar").addEventListener("click", async (e) => {
    if (e.target.closest("[data-move-selected]")) { if (!st.selected.size) return toast("ยังไม่ได้เลือกรายการ", true); return getHost()?.openMove([...st.selected]); }
    const b = e.target.closest("[data-bulk]"); if (!b) return;
    if (!st.selected.size) return toast("ยังไม่ได้เลือกรายการ", true);
    if (await bulk(b.dataset.bulk, [...st.selected])) { st.selected.clear(); renderBulk(); }
  });
  $("bulkBar").addEventListener("change", async (e) => {
    if (e.target.id !== "bulkCat" || !e.target.value) return;
    if (!st.selected.size) { e.target.value = ""; return toast("ยังไม่ได้เลือกรายการ", true); }
    await bulk("category", [...st.selected], { category: e.target.value });
  });
  $("vMain").addEventListener("click", (e) => {
    if (e.target.matches("[data-check]")) { const id = Number(e.target.dataset.check); st.selecting = true; st.selected.has(id) ? st.selected.delete(id) : st.selected.add(id); renderBulk(); renderMain(); return; }
    const act = e.target.closest("[data-act]");
    if (act) return act.dataset.act === "upload" ? getHost()?.openUpload() : getHost()?.openLink();
    const el = e.target.closest("[data-id]"); if (!el) return;
    const id = Number(el.dataset.id);
    if (st.selecting) { st.selected.has(id) ? st.selected.delete(id) : st.selected.add(id); renderBulk(); renderMain(); return; }
    open(id);
  });
  $("pvBack").onclick = closePreview;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if ($("editModal").classList.contains("open")) $("editModal").classList.remove("open"); else if (!$("pv").hidden) closePreview(); }
    if (!$("pv").hidden && ["ArrowLeft", "ArrowRight"].includes(e.key) && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      const i = st.items.findIndex((x) => x.id === st.openId);
      const next = st.items[i + (e.key === "ArrowRight" ? 1 : -1)];
      if (next) showPreview(next);
    }
  });
  $("pvActions").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-pv]"); if (!b) return;
    const it = st.items.find((i) => i.id === st.openId); if (!it) return;
    if (b.dataset.pv === "expand") { st.full = true; return showPreview(it); }
    if (b.dataset.pv === "move") return getHost()?.openMove([it.id]);
    if (b.dataset.pv === "favorite") return getHost()?.favorite(it.id, !it.favorite);
    if (b.dataset.pv === "edit") return openEdit(it);
    if (await bulk(b.dataset.pv, [it.id])) closePreview();
  });
  $("editModal").addEventListener("click", (e) => { if (e.target === $("editModal") || e.target.closest("[data-close]")) $("editModal").classList.remove("open"); });
  $("editForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, body = { title: f.title.value, description: f.description.value, category: f.category.value };
    if (!$("editUrlField").hidden) body.url = f.url.value;
    try {
      await api(`/api/media/${f.dataset.id}`, { method: "PATCH", body });
      $("editModal").classList.remove("open"); toast("บันทึกแล้ว");
      if (!$("pv").hidden) $("pvBody").innerHTML = ""; // ให้สร้างตัวอย่างใหม่ (เช่น เปลี่ยนลิงก์)
      reload();
      const id = Number(f.dataset.id);
      setTimeout(() => { const it = st.items.find((i) => i.id === id); if (it && !$("pv").hidden) showPreview(it); }, 600);
    } catch (err) { toast(err.message, true); }
  });

  async function open(id) {
    let it = st.items.find((i) => i.id === id);
    if (!it) { try { it = (await api(`/api/media/${id}`)).item; } catch (e) { return toast(e.message, true); } }
    showPreview(it);
  }

  // ---------- ลากสื่อไปวางในแฟ้ม (การ์ดแฟ้ม, เส้นทางด้านบน, "แฟ้มสื่อของฉัน" = แฟ้มหลัก) ----------
  let dragIds = null;
  const dropTarget = (el) => el?.closest(".folder-card, #crumbPath [data-folder], #crumbHome");
  const targetFolder = (t) => t.id === "crumbHome" ? null : Number(t.dataset.folder || t.querySelector("[data-folder]")?.dataset.folder);
  const clearOver = () => document.querySelectorAll(".drop-over").forEach((x) => x.classList.remove("drop-over"));
  document.addEventListener("dragstart", (e) => {
    const el = e.target.closest?.("[data-id][draggable]"); if (!el) return;
    const id = Number(el.dataset.id);
    dragIds = st.selected.has(id) ? [...st.selected] : [id];
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", `tm-media:${dragIds.join(",")}`);
    const tag = document.createElement("div"); tag.className = "drag-tag"; tag.textContent = dragIds.length > 1 ? `ย้าย ${dragIds.length} รายการ` : el.getAttribute("aria-label") || "ย้ายสื่อ";
    document.body.appendChild(tag); e.dataTransfer.setDragImage(tag, 12, 12); setTimeout(() => tag.remove(), 0);
    document.body.classList.add("dragging-media");
  });
  document.addEventListener("dragend", () => { dragIds = null; clearOver(); document.body.classList.remove("dragging-media"); });
  document.addEventListener("dragover", (e) => {
    if (!dragIds) return;
    const t = dropTarget(e.target); if (!t) return;
    const dest = targetFolder(t);
    if (dest === (st.folderId ?? null)) return; // แฟ้มเดิม
    e.preventDefault(); e.dataTransfer.dropEffect = "move";
    if (!t.classList.contains("drop-over")) { clearOver(); t.classList.add("drop-over"); }
  });
  document.addEventListener("dragleave", (e) => { const t = dropTarget(e.target); if (t && !t.contains(e.relatedTarget)) t.classList.remove("drop-over"); });
  document.addEventListener("drop", async (e) => {
    if (!dragIds) return;
    const t = dropTarget(e.target); if (!t) return;
    e.preventDefault(); e.stopPropagation(); clearOver();
    const ids = dragIds, dest = targetFolder(t); dragIds = null;
    try {
      const r = await api("/api/media/move", { method: "POST", body: { ids, collection_id: dest } });
      const name = dest == null ? "แฟ้มสื่อของฉัน" : st.folders.find((f) => f.id === dest)?.name || "แฟ้ม";
      toast(`ย้าย ${r.count} รายการไป “${name}” แล้ว`);
      st.selected.clear(); renderBulk(); reload();
    } catch (err) { toast(err.message, true); }
  });

  window.Viewer = { render, open };
  renderBulk();
  if (window.parent !== window) getHost()?.ready(); else standalone();
})();
