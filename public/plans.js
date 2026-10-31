// แผนการจัดการเรียนรู้: อัพโหลด (หน้าเดียวกับอัพโหลดสื่อ) + จัดการไฟล์ของตนเอง
(() => {
  const { api, icon, esc, toast } = TM;
  const $ = (id) => document.getElementById(id);
  const S = { data: null, termId: null, editing: null, pending: 0 };
  const CUSTOM = "__custom";
  const termText = (t) => `ปีการศึกษา ${t.year_be} ภาคเรียนที่ ${t.term_number}${t.status === "active" ? " (ปัจจุบัน)" : ""}`;
  const subjectText = (s) => `${s.subject_name}${s.subject_code ? ` (${s.subject_code})` : ""}${s.grade_level ? ` ${s.grade_level}` : ""}`;
  const keyOf = (s) => `${s.subject_name}|${s.subject_code || ""}|${s.grade_level || ""}`;
  const when = (s) => s ? new Date(s.replace(" ", "T") + "Z").toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }) : "";
  const viewUrl = (p) => ["document", "spreadsheet", "presentation"].includes(p.category) && !["txt", "csv", "tsv", "md"].includes(p.ext) ? `/plan-preview/${p.id}` : `/plan-file/${p.id}`;

  async function fetchData(termId) {
    const d = await api(`/api/plans${termId ? `?term_id=${termId}` : ""}`);
    S.data = d; S.termId = d.term?.id || null;
    return d;
  }

  function fillTerms(sel, value) {
    sel.innerHTML = (S.data?.terms || []).map((t) => `<option value="${t.id}">${esc(termText(t))}</option>`).join("") || `<option value="">ยังไม่มีภาคเรียนในระบบ</option>`;
    if (value) sel.value = value;
  }
  function fillSubjects(sel, subjects, current = null) {
    const list = [...subjects];
    if (current && !list.some((s) => keyOf(s) === keyOf(current))) list.unshift(current);
    sel.innerHTML = `<option value="">— เลือกรายวิชา —</option>` + list.map((s) => `<option value="${esc(keyOf(s))}">${esc(subjectText(s))}</option>`).join("") + `<option value="${CUSTOM}">อื่น ๆ (พิมพ์เอง)</option>`;
    sel._list = list;
    if (current) sel.value = keyOf(current);
  }
  // วิชาของภาคเรียนที่เลือกในฟอร์ม (โหลดใหม่ถ้าไม่ใช่ภาคเรียนเดียวกับข้อมูลปัจจุบัน)
  async function subjectsFor(termId) {
    if (S.data && String(S.data.term?.id) === String(termId)) return S.data.subjects;
    return (await api(`/api/plans?term_id=${termId}`)).subjects;
  }
  function readSubject(form, sel) {
    if (sel.value === CUSTOM) return { subject_name: form.elements.subject_name.value.trim(), subject_code: "", grade_level: form.elements.grade_level.value.trim() };
    const s = (sel._list || []).find((x) => keyOf(x) === sel.value);
    return s ? { subject_name: s.subject_name, subject_code: s.subject_code || "", grade_level: s.grade_level || "" } : null;
  }

  // ---------- หน้ารายการ ----------
  function render() {
    const d = S.data, body = $("plansBody");
    fillTerms($("planTermFilter"), d.term?.id);
    if (!d.term) { body.innerHTML = `<div class="plan-empty">ยังไม่มีปีการศึกษา/ภาคเรียนในระบบ</div>`; return; }
    if (!d.items.length) { body.innerHTML = `<div class="plan-empty"><b>ยังไม่มีแผนฯ ของ${esc(termText(d.term))}</b><p>กด “อัพโหลดแผนฯ” เพื่อเริ่ม</p></div>`; return; }
    const groups = new Map();
    for (const p of d.items) {
      const k = keyOf(p);
      if (!groups.has(k)) groups.set(k, { s: p, units: new Map() });
      const g = groups.get(k);
      if (!g.units.has(p.unit_no)) g.units.set(p.unit_no, []);
      g.units.get(p.unit_no).push(p);
    }
    body.innerHTML = [...groups.values()].map((g) => {
      const units = [...g.units.entries()].sort((a, b) => a[0] - b[0]);
      return `<section class="plan-subject"><header><b>${esc(subjectText(g.s))}</b><span class="muted">${units.length} หน่วย · ${units.reduce((n, [, f]) => n + f.length, 0)} ไฟล์</span></header>
        ${units.map(([u, files]) => `<div class="plan-unit"><h3>หน่วยที่ ${u}<button class="btn btn-sm" data-add='${esc(JSON.stringify({ ...g.s, unit_no: u }))}'>${icon("plus", 13)} เพิ่มไฟล์</button></h3>
          ${files.map((p) => `<div class="plan-file"><span>${icon(p.category === "pdf" ? "pdf" : p.category in { document: 1, spreadsheet: 1, presentation: 1, image: 1, video: 1, audio: 1 } ? p.category : "other", 18)}</span>
            <div class="nm"><b>${esc(p.file_name)}</b><small>${TM.size(p.file_size || 0)} · ${when(p.created_at)}</small></div>
            <div class="acts"><a class="btn btn-sm" href="${viewUrl(p)}" target="_blank" rel="noopener">${icon("external", 13)} ดู</a>
              <a class="btn btn-sm" href="/plan-file/${p.id}?download=1">${icon("download", 13)} ดาวน์โหลด</a>
              <button class="btn btn-sm" data-edit="${p.id}">${icon("edit", 13)} แก้ไข</button>
              <button class="btn btn-sm btn-danger" data-del="${p.id}">${icon("trash", 13)} ลบ</button></div></div>`).join("")}</div>`).join("")}
      </section>`;
    }).join("");
  }

  async function show(termId = S.termId) {
    try { await fetchData(termId); render(); }
    catch (e) { if (e.status === 401) return location.reload(); $("plansBody").innerHTML = `<div class="plan-empty">${esc(e.message)}</div>`; }
  }

  // ---------- อัพโหลด ----------
  async function openUpload(preset = null) {
    $("planError").textContent = "";
    try { if (!S.data) await fetchData(); } catch (e) { return toast(e.message, true); }
    const form = $("planForm");
    fillTerms($("planTerm"), S.data.term?.id);
    fillSubjects($("planSubject"), S.data.subjects, preset && { subject_name: preset.subject_name, subject_code: preset.subject_code, grade_level: preset.grade_level });
    $("planCustom").hidden = true;
    form.elements.unit_no.value = preset?.unit_no || "";
    $("planModal").classList.add("open");
  }

  function putFile(uploadUrl, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300) ? (() => { try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("อ่านผลการอัพโหลดไม่ได้")); } })() : reject(new Error(`อัพโหลดไม่สำเร็จ (${xhr.status})`));
      xhr.onerror = () => reject(new Error("การเชื่อมต่อขัดข้อง"));
      xhr.send(file);
    });
  }

  async function uploadOne(file, target) {
    const el = document.createElement("div");
    el.className = "q-item";
    el.innerHTML = `<div class="q-row"><b>${esc(file.name)}</b><span class="st">${TM.size(file.size)} · รอ</span></div><div class="bar"><i></i></div>`;
    $("planQueue").prepend(el);
    const st = el.querySelector(".st"), bar = el.querySelector(".bar i");
    try {
      const { uploadUrl } = await api("/api/plans/uploads", { method: "POST", body: { ...target, name: file.name, size: file.size, mimeType: file.type } });
      const meta = await putFile(uploadUrl, file, (p) => { bar.style.width = `${Math.round(p * 100)}%`; st.textContent = `${Math.round(p * 100)}%`; });
      await api("/api/plans/uploads/complete", { method: "POST", body: { ...target, driveFileId: meta.id } });
      bar.style.width = "100%"; el.classList.add("done"); st.innerHTML = `${icon("check", 13)} หน่วยที่ ${target.unit_no}`;
    } catch (e) { el.classList.add("err"); bar.style.width = "100%"; st.textContent = e.message; }
  }

  async function uploadFiles(files) {
    files = [...files];
    const form = $("planForm"), err = $("planError");
    err.textContent = "";
    if (!files.length) return;
    if (files.length > S.data.max_batch) { err.textContent = `อัพโหลดได้ครั้งละไม่เกิน ${S.data.max_batch} ไฟล์ (เลือกมา ${files.length} ไฟล์)`; return; }
    if (S.pending) { err.textContent = "กรุณารอให้อัพโหลดชุดก่อนหน้าเสร็จก่อน"; return; }
    const subject = readSubject(form, $("planSubject"));
    const unit = Number(form.elements.unit_no.value);
    if (!form.elements.term_id.value) { err.textContent = "กรุณาเลือกปีการศึกษา/ภาคเรียน"; return; }
    if (!subject?.subject_name) { err.textContent = "กรุณาเลือกรายวิชา"; return; }
    if (!Number.isInteger(unit) || unit < 1 || unit > 60) { err.textContent = "กรุณากรอกหน่วยที่ (1–60)"; return; }
    const target = { term_id: Number(form.elements.term_id.value), unit_no: unit, ...subject };
    S.pending = files.length;
    try { await api("/api/plans/prepare", { method: "POST", body: target }); }
    catch (e) { S.pending = 0; err.textContent = e.message; return; }
    // ส่งพร้อมกันครั้งละ 3 ไฟล์
    const queue = [...files];
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { while (queue.length) await uploadOne(queue.shift(), target); }));
    S.pending = 0;
    if (location.hash === "#/plans") show(target.term_id); else S.data = null;
  }

  // ---------- แก้ไข / ลบ ----------
  async function openEdit(id) {
    const p = S.data.items.find((x) => x.id === id); if (!p) return;
    S.editing = p;
    const form = $("planEditForm");
    form.elements.title.value = p.title; form.elements.unit_no.value = p.unit_no;
    fillTerms($("planEditTerm"), p.academic_term_id);
    fillSubjects($("planEditSubject"), S.data.subjects, p);
    $("planEditCustom").hidden = true; $("planEditError").textContent = "";
    $("planEditModal").classList.add("open");
  }

  async function remove(id) {
    const p = S.data.items.find((x) => x.id === id);
    if (!p || !confirm(`ลบไฟล์ “${p.file_name}”? (ไฟล์ย้ายไปถังขยะ Google Drive กู้คืนได้ 30 วัน)`)) return;
    try { await api("/api/plans/delete", { method: "POST", body: { ids: [id] } }); toast("ลบแล้ว"); show(); }
    catch (e) { toast(e.message, true); }
  }

  function bind() {
    $("planUploadBtn2").innerHTML = `${icon("upload", 16)} อัพโหลดแผนฯ`;
    $("planDropIcon").innerHTML = icon("upload", 34);
    $("planUploadBtn").onclick = () => openUpload();
    $("planUploadBtn2").onclick = () => openUpload();
    $("planTermFilter").onchange = (e) => show(Number(e.target.value));
    $("plansBody").onclick = (e) => {
      const add = e.target.closest("[data-add]"); if (add) return openUpload(JSON.parse(add.dataset.add));
      const ed = e.target.closest("[data-edit]"); if (ed) return openEdit(Number(ed.dataset.edit));
      const del = e.target.closest("[data-del]"); if (del) return remove(Number(del.dataset.del));
    };
    const onSubject = (sel, box) => () => { box.hidden = sel.value !== CUSTOM; };
    $("planSubject").onchange = onSubject($("planSubject"), $("planCustom"));
    $("planEditSubject").onchange = onSubject($("planEditSubject"), $("planEditCustom"));
    $("planTerm").onchange = async (e) => { try { fillSubjects($("planSubject"), await subjectsFor(e.target.value)); $("planCustom").hidden = true; } catch (er) { $("planError").textContent = er.message; } };
    $("planEditTerm").onchange = async (e) => { try { fillSubjects($("planEditSubject"), await subjectsFor(e.target.value), S.editing); } catch (er) { $("planEditError").textContent = er.message; } };

    const drop = $("planDrop");
    drop.onclick = () => $("planFileInput").click();
    drop.onkeydown = (e) => { if (["Enter", " "].includes(e.key)) { e.preventDefault(); $("planFileInput").click(); } };
    $("planFileInput").onchange = (e) => { uploadFiles(e.target.files); e.target.value = ""; };
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); uploadFiles(e.dataTransfer.files); });

    $("planEditForm").onsubmit = async (e) => {
      e.preventDefault();
      const form = e.target, btn = form.querySelector(".btn-primary"), p = S.editing;
      const subject = readSubject(form, $("planEditSubject"));
      if (!subject?.subject_name) { $("planEditError").textContent = "กรุณาเลือกรายวิชา"; return; }
      btn.disabled = true;
      try {
        await api(`/api/plans/${p.id}`, { method: "PATCH", body: { title: form.elements.title.value, term_id: Number(form.elements.term_id.value), unit_no: Number(form.elements.unit_no.value), ...subject } });
        form.closest(".modal").classList.remove("open"); toast("บันทึกแล้ว"); show();
      } catch (er) { $("planEditError").textContent = er.message; }
      finally { btn.disabled = false; }
    };
  }

  bind();
  window.TMPlans = { show: () => show(), openUpload };
})();
