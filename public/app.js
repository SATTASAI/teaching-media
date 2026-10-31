// หน้าหลัก: เมนูหลัก + รายการด้านซ้าย, พื้นที่ขวาเป็น iframe (viewer.html) แสดงสื่อทั้งหมด
(() => {
  const { api, icon, esc, toast, pref, CAT_COLORS, CAT_LABELS } = TM;
  const $ = (id) => document.getElementById(id);
  const state = { user: null, category: pref.get("category", "all"), trash: false, q: "", sort: pref.get("sort", "newest"), items: [], counts: [], trashCount: 0, activeId: null };
  const viewer = () => $("viewer").contentWindow?.Viewer;

  function setIcons() {
    for (const id of ["brandLogo", "loginLogo"]) $(id).innerHTML = icon("layers", 22);
    $("uploadBtn").innerHTML = `${icon("upload", 16)} อัพโหลด`;
    $("linkBtn").innerHTML = `${icon("link", 16)} วางลิงก์`;
    $("logoutBtn").innerHTML = icon("logout", 15);
    $("drawerBtn").innerHTML = icon("menu");
    $("searchIcon").innerHTML = icon("search", 15);
    $("dropIcon").innerHTML = icon("upload", 34);
  }

  function renderNav() {
    const total = state.counts.reduce((s, c) => s + c.n, 0);
    const byCat = Object.fromEntries(state.counts.map((c) => [c.category, c.n]));
    const row = (key, label, color, n, active) => `<button class="nav-item${active ? " active" : ""}" data-cat="${key}">
      <span class="dot" style="background:${color}">${icon(key === "all" ? "all" : key === "trash" ? "trash" : key, 15)}</span>${esc(label)}<span class="count">${n}</span></button>`;
    let html = row("all", "สื่อทั้งหมด", "linear-gradient(135deg,#4F5FE0,#7B4FE0)", total, !state.trash && state.category === "all");
    for (const key of Object.keys(CAT_LABELS)) {
      if (!byCat[key] && state.category !== key) continue; // แสดงเฉพาะหมวดที่มีสื่อ
      html += row(key, CAT_LABELS[key], CAT_COLORS[key], byCat[key] || 0, !state.trash && state.category === key);
    }
    html += row("trash", "ถังขยะ", "#8C93A6", state.trashCount, state.trash);
    $("catNav").innerHTML = html;
  }

  function renderList() {
    $("listTitle").textContent = state.trash ? "รายการในถังขยะ" : state.category === "all" ? "รายการสื่อ" : `รายการ · ${CAT_LABELS[state.category]}`;
    $("list").innerHTML = state.items.length
      ? state.items.map((it) => `<button class="list-item${it.id === state.activeId ? " active" : ""}" data-id="${it.id}" style="--c:${CAT_COLORS[it.category]}" title="${esc(it.title)}">${icon(it.category, 16)}<span>${esc(it.title)}</span></button>`).join("")
      : `<p class="muted" style="padding:8px">ไม่มีรายการ</p>`;
  }

  function pushToViewer() {
    viewer()?.render({ items: state.items, category: state.category, trash: state.trash, sort: state.sort, q: state.q, activeId: state.activeId });
  }

  async function load() {
    const p = new URLSearchParams({ sort: state.sort });
    if (state.trash) p.set("trash", "1");
    else if (state.category !== "all") p.set("category", state.category);
    if (state.q) p.set("q", state.q);
    try {
      const data = await api(`/api/media?${p}`);
      Object.assign(state, { items: data.items, counts: data.counts, trashCount: data.trash_count });
      if (!state.trash && state.category !== "all" && !data.counts.some((c) => c.category === state.category) && !state.q) {
        state.category = "all"; pref.set("category", "all"); return load();
      }
    } catch (e) {
      if (e.status === 401) return showLogin();
      toast(e.message, true);
    }
    renderNav(); renderList(); pushToViewer();
  }

  // ให้ viewer เรียกกลับ
  window.TMApp = {
    reload: load,
    setSort(sort) { state.sort = sort; pref.set("sort", sort); load(); },
    setActive(id) { state.activeId = id; renderList(); },
    openUpload: () => openModal("uploadModal"),
    openLink: () => openModal("linkModal"),
    ready: pushToViewer,
  };

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
  async function uploadOne(file) {
    const el = document.createElement("div");
    el.className = "q-item";
    el.innerHTML = `<div class="q-row"><b>${esc(file.name)}</b><span class="st">${TM.size(file.size)} · รอ</span></div><div class="bar"><i></i></div>`;
    $("queue").prepend(el);
    const st = el.querySelector(".st"), bar = el.querySelector(".bar i");
    pending++;
    try {
      const { uploadUrl } = await api("/api/uploads", { method: "POST", body: { name: file.name, size: file.size, mimeType: file.type } });
      const meta = await putFile(uploadUrl, file, (p) => { bar.style.width = `${Math.round(p * 100)}%`; st.textContent = `${Math.round(p * 100)}%`; });
      const done = await api("/api/uploads/complete", { method: "POST", body: { driveFileId: meta.id } });
      bar.style.width = "100%"; el.classList.add("done");
      st.innerHTML = `${icon("check", 13)} ${esc(CAT_LABELS[done.category] || "เสร็จ")}`;
    } catch (e) {
      el.classList.add("err"); bar.style.width = "100%"; st.textContent = e.message;
    } finally {
      if (--pending === 0) load();
    }
  }
  const uploadFiles = (files) => [...files].forEach(uploadOne);

  // ---------- หน้าต่าง ----------
  function openModal(id) { $(id).classList.add("open"); }
  function closeModal(el) { el.closest(".modal").classList.remove("open"); }

  async function showApp() {
    $("loginView").hidden = true; $("appView").hidden = false;
    $("who").textContent = state.user.full_name || state.user.email;
    if (state.category === "trash") state.category = "all";
    await load();
  }
  function showLogin() { $("appView").hidden = true; $("loginView").hidden = false; }

  function bind() {
    $("catNav").addEventListener("click", (e) => {
      const b = e.target.closest("[data-cat]"); if (!b) return;
      const cat = b.dataset.cat;
      state.trash = cat === "trash";
      if (!state.trash) { state.category = cat; pref.set("category", cat); }
      state.activeId = null;
      $("appView").classList.remove("drawer");
      load();
    });
    $("list").addEventListener("click", (e) => {
      const b = e.target.closest("[data-id]"); if (!b) return;
      state.activeId = Number(b.dataset.id); renderList();
      viewer()?.open(state.activeId);
      $("appView").classList.remove("drawer");
    });
    let t;
    $("search").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 300); });
    $("uploadBtn").onclick = () => openModal("uploadModal");
    $("linkBtn").onclick = () => openModal("linkModal");
    $("drawerBtn").onclick = () => $("appView").classList.toggle("drawer");
    $("appView").addEventListener("click", (e) => { if (e.target === $("appView")) $("appView").classList.remove("drawer"); });
    $("logoutBtn").onclick = async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); location.reload(); };
    document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeModal(b)));
    document.querySelectorAll(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("open"); }));

    const drop = $("drop");
    drop.onclick = () => $("fileInput").click();
    $("fileInput").onchange = (e) => { uploadFiles(e.target.files); e.target.value = ""; };
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); uploadFiles(e.dataTransfer.files); });

    $("linkForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target), btn = e.target.querySelector(".btn-primary");
      btn.disabled = true;
      try {
        const r = await api("/api/links", { method: "POST", body: Object.fromEntries(f) });
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
  api("/api/me").then((d) => { state.user = d.user; d.user ? showApp() : showLogin(); }).catch(showLogin);
})();
