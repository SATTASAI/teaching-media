// หน้าหลัก: แฟ้มประเภทสื่อ + ค้นหาและอัปโหลด พื้นที่ทำงานและตัวอย่างอยู่ใน viewer
(() => {
  const { api, icon, esc, toast, pref, CAT_COLORS, CAT_LABELS } = TM;
  const $ = (id) => document.getElementById(id);
  const state = { user: null, category: pref.get("category", "all"), trash: false, q: "", sort: pref.get("sort", "newest"), items: [], counts: [], trashCount: 0, activeId: null, folders: [], folderId: null, section: "home" };
  function currentRoute() {
    const parts = location.hash.replace(/^#\/?/, "").split("/");
    if (parts[0] === "folders" && /^\d+$/.test(parts[1] || "")) return { section: "folder", id: Number(parts[1]) };
    return { section: ["home", "manage", "recent", "favorites", "trash"].includes(parts[0]) ? parts[0] : "home", id: null };
  }
  const route = currentRoute(); state.section = route.section; state.folderId = route.id; state.trash = route.section === "trash";
  const viewer = () => $("viewer").contentWindow?.Viewer;

  function setIcons() {
    for (const id of ["headerLogo", "loginLogo"]) $(id).innerHTML = icon("book", 28);
    $("sideCreateFolder").innerHTML = icon("plus", 16);
    $("storageIcon").innerHTML = icon("archive", 24);
    $("accountAvatar").innerHTML = icon("document", 18);
    $("uploadBtn").innerHTML = `${icon("upload", 16)} อัปโหลดสื่อ`;
    $("linkBtn").innerHTML = `${icon("link", 16)} วางลิงก์`;
    $("logoutBtn").innerHTML = icon("logout", 15);
    $("drawerBtn").innerHTML = icon("menu");
    $("searchIcon").innerHTML = icon("search", 15);
    $("dropIcon").innerHTML = icon("upload", 34);
  }

  const folderPath = (id) => {
    const parts = []; let f = state.folders.find(x => x.id === id), seen = new Set();
    while (f && !seen.has(f.id)) { seen.add(f.id); parts.unshift(f.name); f = state.folders.find(x => x.id === f.parent_id); }
    return parts.join(" / ");
  };
  function folderOptions(exclude = null) {
    const descendants = new Set(exclude ? [exclude] : []);
    for (let i = 0; i < 33; i++) state.folders.forEach(f => { if (descendants.has(f.parent_id)) descendants.add(f.id); });
    return `<option value="">แฟ้มหลัก</option>` + state.folders.filter(f => !descendants.has(f.id)).map(f => `<option value="${f.id}">${esc(folderPath(f.id))}</option>`).join("");
  }
  function renderNav() {
    const navs = [["home", "หน้าแรก", "all"], ["recent", "สื่อที่เพิ่มล่าสุด", "restore"], ["favorites", "รายการโปรด", "star"], ["manage", "จัดการแฟ้มงาน", "folder"], ["trash", "ถังขยะ", "trash"]];
    $("mainNav").innerHTML = navs.map(([key, label, ic]) => `<button class="nav-item${state.section === key ? " active" : ""}" data-section="${key}"${state.section === key ? ' aria-current="page"' : ''}>${icon(ic, 20)}${label}</button>`).join("");
    const ancestors = new Set(); let f = state.folders.find(f => f.id === state.folderId);
    while (f && !ancestors.has(f.id)) { ancestors.add(f.id); f = state.folders.find(x => x.id === f.parent_id); }
    const branch = (parent = null, depth = 0) => depth > 32 ? "" : state.folders.filter(f => f.parent_id === parent).map(f => {
      const kids = state.folders.some(x => x.parent_id === f.id);
      return `<div class="tree-node"><div class="tree-row"><button class="tree-folder${state.folderId === f.id ? " active" : ""}" data-folder="${f.id}" title="${esc(f.name)}">${icon("folder", 19)}<span>${esc(f.name)}</span></button>${kids ? `<button class="tree-toggle" data-expand="${f.id}" aria-label="ยุบหรือขยาย ${esc(f.name)}" aria-expanded="${ancestors.has(f.id)}">${icon("back", 13)}</button>` : ""}</div>${kids ? `<div class="tree-children" data-children="${f.id}"${ancestors.has(f.id) ? "" : " hidden"}>${branch(f.id, depth + 1)}</div>` : ""}</div>`;
    }).join("");
    $("folderTree").innerHTML = state.folders.length ? branch() : `<p class="tree-empty">ยังไม่มีแฟ้มงาน<br>กด + เพื่อสร้างแฟ้มแรก</p>`;
  }

  function pushToViewer() {
    viewer()?.render({ items: state.items, category: state.category, trash: state.trash, sort: state.sort, q: state.q, activeId: state.activeId, folders: state.folders, folderId: state.folderId, section: state.section });
  }

  let loadVersion = 0;
  async function load() {
    const version = ++loadVersion;
    const p = new URLSearchParams({ sort: state.sort });
    if (state.trash) p.set("trash", "1");
    else if (state.category !== "all") p.set("category", state.category);
    if (state.folderId !== null && state.section === "folder") p.set("folder", state.folderId);
    if (state.section === "favorites") p.set("favorites", "1");
    if (state.section === "recent") p.set("sort", "newest");
    if (state.q) p.set("q", state.q);
    try {
      const [data, folderData] = await Promise.all([api(`/api/media?${p}`), api("/api/folders")]);
      if (version !== loadVersion) return;
      Object.assign(state, { items: state.section === "manage" ? [] : data.items, counts: data.counts, trashCount: data.trash_count, folders: folderData.folders });
      if (state.folderId && !state.folders.some(f => f.id === state.folderId)) { state.folderId = null; state.section = "manage"; location.hash = "#/manage"; return load(); }

    } catch (e) {
      if (version !== loadVersion) return;
      if (e.status === 401) return showLogin();
      toast(e.message, true);
    }
    renderNav(); pushToViewer();
  }

  // ให้ viewer เรียกกลับ
  window.TMApp = {
    reload: load,
    setSort(sort) { state.sort = sort; pref.set("sort", sort); load(); },
    setActive(id) { state.activeId = id; },
    setQuery(q) { state.q = q; $("search").value = q; load(); },
    uploadFiles(files) { openModal("uploadModal"); uploadFiles(files); },
    openUpload: () => openModal("uploadModal"),
    openLink: () => openModal("linkModal"),
    ready: pushToViewer,
    openFolder(id) { navigate("folder", Number(id)); },
    home() { navigate("home"); },
    setCategory(category) { state.category = category; load(); },
    createFolder() { editFolder(null); },
    editFolder(id) { editFolder(Number(id)); },
    deleteFolder(id) { removeFolder(Number(id)); },
    openMove(ids) { openMove(ids); },
    async favorite(id, value) { try { await api(`/api/media/${id}`, { method: "PATCH", body: { favorite: value } }); await load(); } catch(e) { toast(e.message, true); } },
  };

  function navigate(section, id = null) {
    const hash = section === "folder" ? `#/folders/${id}` : `#/${section}`;
    if (location.hash !== hash) { location.hash = hash; return; }
    state.section = section; state.folderId = id; state.trash = section === "trash"; state.activeId = null;
    if (section === "recent") state.sort = "newest";
    state.q = ""; state.category = "all"; $("search").value = "";
    $("appView").classList.remove("drawer"); $("drawerBtn").setAttribute("aria-expanded", "false"); load();
  }
  function editFolder(id) {
    const folder = state.folders.find(f => f.id === id), form = $("folderForm");
    form.dataset.folderId = folder?.id || "";
    $("folderModalTitle").textContent = folder ? "จัดการแฟ้มงาน" : "สร้างโฟลเดอร์";
    $("saveFolderBtn").textContent = folder ? "บันทึกการแก้ไข" : "สร้างแฟ้ม";
    form.elements.folderName.value = folder?.name || "";
    $("folderParent").innerHTML = folderOptions(folder?.id);
    $("folderParent").value = folder ? folder.parent_id ?? "" : state.folderId ?? "";
    $("folderError").textContent = ""; openModal("folderModal");
  }
  async function removeFolder(id) {
    const f = state.folders.find(f => f.id === id); if (!f || !confirm(`ลบแฟ้ม “${f.name}”? ลบได้เฉพาะแฟ้มว่าง`)) return;
    try { await api(`/api/folders/${id}`, {method:"DELETE"}); if (state.folderId === id) {state.folderId = f.parent_id; state.section = f.parent_id ? "folder" : "manage";} toast("ลบแฟ้มแล้ว"); load(); }
    catch(e) { toast(e.message, true); }
  }
  let movingIds = [];
  function openMove(ids) {
    movingIds = ids;
    $("moveDestination").innerHTML = folderOptions(); $("moveDestination").value = state.folderId ?? "";
    $("moveSummary").textContent = `เลือก ${ids.length} รายการ · เลือกแฟ้มปลายทาง`;
    $("moveError").textContent = ""; openModal("moveModal");
  }

  // ---------- อัพโหลด (เบราว์เซอร์ส่งไฟล์ตรงเข้า Google Drive) ----------
  function putFile(uploadUrl, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("อ่านผลการอัพโหลดไม่ได้")); } }
        else reject(new Error(`อัพโหลดไม่สำเร็จ (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error("การเชื่อมต่อขัดข้อง"));
      xhr.send(file);
    });
  }

  let pending = 0;
  async function uploadOne(file, collectionId) {
    const el = document.createElement("div");
    el.className = "q-item";
    el.innerHTML = `<div class="q-row"><b>${esc(file.name)}</b><span class="st">${TM.size(file.size)} · รอ</span></div><div class="bar"><i></i></div>`;
    $("queue").prepend(el);
    const st = el.querySelector(".st"), bar = el.querySelector(".bar i");
    pending++;
    try {
      const { uploadUrl } = await api("/api/uploads", { method: "POST", body: { name: file.name, size: file.size, mimeType: file.type } });
      const meta = await putFile(uploadUrl, file, (p) => { bar.style.width = `${Math.round(p * 100)}%`; st.textContent = `${Math.round(p * 100)}%`; });
      const done = await api("/api/uploads/complete", { method: "POST", body: { driveFileId: meta.id, collection_id: collectionId } });
      bar.style.width = "100%"; el.classList.add("done");
      st.innerHTML = `${icon("check", 13)} ${esc(CAT_LABELS[done.category] || "เสร็จ")}${done.moved_to_root ? " · แฟ้มถูกลบ จึงเก็บไว้ที่แฟ้มหลัก" : ""}`;
    } catch (e) {
      el.classList.add("err"); bar.style.width = "100%"; st.textContent = e.message;
    } finally {
      if (--pending === 0) load();
    }
  }
  const uploadFiles = (files) => { const folder = state.folderId; [...files].forEach(file => uploadOne(file, folder)); };

  // ---------- หน้าต่าง ----------
  function openModal(id) { const modal = $(id); modal.classList.add("open"); modal.querySelector("input:not([hidden]), [data-close], button")?.focus(); }
  function closeModal(el) { el.closest(".modal").classList.remove("open"); }

  async function showApp() {
    $("loginView").hidden = true; $("appView").hidden = false;
    $("who").textContent = state.user.full_name || state.user.email;
    state.category = "all";
    await load();
  }
  function showLogin() { $("appView").hidden = true; $("loginView").hidden = false; }

  function bind() {
    $("mainNav").onclick = e => { const b = e.target.closest("[data-section]"); if (b) navigate(b.dataset.section); };
    $("sideCreateFolder").onclick = () => editFolder(null);
    $("folderTree").onclick = e => {
      const toggle = e.target.closest("[data-expand]");
      if (toggle) { const child = document.querySelector(`[data-children="${toggle.dataset.expand}"]`); child.hidden = !child.hidden; toggle.setAttribute("aria-expanded", !child.hidden); return; }
      const b = e.target.closest("[data-folder]"); if (b) navigate("folder", Number(b.dataset.folder));
    };
    $("folderForm").onsubmit = async e => {
      e.preventDefault(); const form = e.target, submit = $("saveFolderBtn"); submit.disabled = true;
      try {
        const id = form.dataset.folderId;
        const response = await api(id ? `/api/folders/${id}` : "/api/folders", { method: id ? "PATCH" : "POST", body: { name: form.elements.folderName.value, parent_id: form.elements.parentFolder.value || null } });
        closeModal(form); toast(id ? "บันทึกแฟ้มแล้ว" : "สร้างแฟ้มแล้ว"); await load();
      } catch(err) { $("folderError").textContent = err.message; }
      finally { submit.disabled = false; }
    };
    $("moveForm").onsubmit = async e => {
      e.preventDefault(); const btn = e.target.querySelector('[type="submit"], .btn-primary'); btn.disabled = true;
      try { await api("/api/media/move", { method: "POST", body: { ids: movingIds, collection_id: $("moveDestination").value || null } }); closeModal(e.target); toast("ย้ายสื่อแล้ว"); await load(); }
      catch(err) { $("moveError").textContent = err.message; }
      finally { btn.disabled = false; }
    };
    let t;
    $("search").addEventListener("input", (e) => { clearTimeout(t); state.q = e.target.value.trim(); t = setTimeout(load, 300); });
    $("uploadBtn").onclick = () => openModal("uploadModal");
    $("linkBtn").onclick = () => openModal("linkModal");
    $("uploadLinkBtn").onclick = () => { $("uploadModal").classList.remove("open"); openModal("linkModal"); };
    $("drawerBtn").onclick = () => { const expanded = $("appView").classList.toggle("drawer"); $("drawerBtn").setAttribute("aria-expanded", expanded); };
    $("appView").addEventListener("click", (e) => { if (e.target === $("appView")) $("appView").classList.remove("drawer"); });
    $("logoutBtn").onclick = async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); location.reload(); };
    document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeModal(b)));
    document.querySelectorAll(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("open"); }));

    const drop = $("drop");
    drop.onclick = () => $("fileInput").click();
    drop.onkeydown = (e) => { if (["Enter", " "].includes(e.key)) { e.preventDefault(); $("fileInput").click(); } };
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelectorAll(".modal.open").forEach((m) => m.classList.remove("open")); });
    $("fileInput").onchange = (e) => { uploadFiles(e.target.files); e.target.value = ""; };
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); uploadFiles(e.dataTransfer.files); });

    $("linkForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target), btn = e.target.querySelector(".btn-primary");
      btn.disabled = true;
      try {
        const r = await api("/api/links", { method: "POST", body: { ...Object.fromEntries(f), collection_id: state.folderId } });
        toast(`บันทึกลิงก์แล้ว · ${CAT_LABELS[r.category]}`);
        e.target.reset(); closeModal(e.target); load();
      } catch (err) { toast(err.message, true); }
      btn.disabled = false;
    });

    $("loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      $("loginError").textContent = "";
      try {
        await api("/api/login", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
        state.user = (await api("/api/me")).user; showApp();
      } catch (err) { $("loginError").textContent = err.message; }
    });
  }

  setIcons(); bind();
  window.addEventListener("hashchange", () => { const route = currentRoute(); navigate(route.section, route.id); });
  api("/api/me").then((d) => { state.user = d.user; d.user ? showApp() : showLogin(); }).catch(showLogin);
})();
