// หน้าหลัก: แฟ้มประเภทสื่อ + ค้นหาและอัปโหลด พื้นที่ทำงานและตัวอย่างอยู่ใน viewer
(() => {
  const { api, icon, esc, toast, pref, CAT_COLORS, CAT_LABELS } = TM;
  const $ = (id) => document.getElementById(id);
  const state = { user: null, category: pref.get("category", "all"), trash: false, q: "", sort: pref.get("sort", "newest"), items: [], counts: [], trashCount: 0, activeId: null };
  const viewer = () => $("viewer").contentWindow?.Viewer;

  function setIcons() {
    for (const id of ["headerLogo", "loginLogo"]) $(id).innerHTML = icon("layers", 28);
    $("storageIcon").innerHTML = icon("archive", 24);
    $("accountAvatar").innerHTML = icon("document", 18);
    $("uploadBtn").innerHTML = `${icon("upload", 16)} อัปโหลดสื่อ`;
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
    let html = row("all", "สื่อทั้งหมด", "#1d513b", total, !state.trash && state.category === "all");
    for (const key of Object.keys(CAT_LABELS)) {
      html += row(key, CAT_LABELS[key], CAT_COLORS[key], byCat[key] || 0, !state.trash && state.category === key);
    }
    html += row("trash", "ถังขยะ", "#8C93A6", state.trashCount, state.trash);
    $("catNav").innerHTML = html;
  }

  function pushToViewer() {
    viewer()?.render({ items: state.items, category: state.category, trash: state.trash, sort: state.sort, q: state.q, activeId: state.activeId });
  }

  let loadVersion = 0;
  async function load() {
    const version = ++loadVersion;
    const p = new URLSearchParams({ sort: state.sort });
    if (state.trash) p.set("trash", "1");
    else if (state.category !== "all") p.set("category", state.category);
    if (state.q) p.set("q", state.q);
    try {
      const data = await api(`/api/media?${p}`);
      if (version !== loadVersion) return;
      Object.assign(state, { items: data.items, counts: data.counts, trashCount: data.trash_count });

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
  function openModal(id) { const modal = $(id); modal.classList.add("open"); modal.querySelector("input:not([hidden]), [data-close], button")?.focus(); }
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
      $("drawerBtn").setAttribute("aria-expanded", "false");
      load();
    });
    let t;
    $("search").addEventListener("input", (e) => { clearTimeout(t); state.q = e.target.value.trim(); t = setTimeout(load, 300); });
    $("uploadBtn").onclick = () => openModal("uploadModal");
    $("linkBtn").onclick = () => openModal("linkModal");
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
