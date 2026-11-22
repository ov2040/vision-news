/* إدارة المنصة — تعمل من المتصفح مباشرة عبر واجهة GitHub البرمجية.
   الدخول بمفتاح GitHub (Personal Access Token) يُحفظ على هذا الجهاز فقط.
   القائمة البريدية تُحفظ في المستودع مشفّرة (AES-256-GCM، مفتاح مشتق من كلمة سر بـ PBKDF2)،
   ولا تُفك إلا بكلمة السر نفسها المحفوظة في أسرار GitHub باسم RECIPIENTS_KEY. */
"use strict";

const REPO = "ov2040/vision-news";
const API = "https://api.github.com";
const TOKEN_KEY = "vn-admin-token";
const ADM = { token: null, user: null, pass: null, recips: null, recipsSha: null };

function admToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
async function gh(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${ADM.token}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status}: ${j.message || "خطأ"}`);
  return j;
}
function utf8ToB64(str) { const bytes = new TextEncoder().encode(str); let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
function b64ToUtf8(b64) { const bin = atob(b64.replace(/\n/g, "")); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); }
async function getFile(path) {
  try { const j = await gh(`/repos/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=main&t=${Date.now()}`); return { text: b64ToUtf8(j.content), sha: j.sha }; }
  catch (e) { if (String(e.message).startsWith("404")) return { text: null, sha: null }; throw e; }
}
async function putFile(path, text, sha, message) {
  const j = await gh(`/repos/${REPO}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, { method: "PUT", body: JSON.stringify({ message, content: utf8ToB64(text), branch: "main", ...(sha ? { sha } : {}) }) });
  return j.content.sha;
}
async function dispatch(workflow, inputs = {}) {
  await gh(`/repos/${REPO}/actions/workflows/${workflow}/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main", inputs }) });
}

/* --- تثبيت قرارات المراجعة بضغطة واحدة (من شريط القرارات أو صفحة المراجعة) */
async function commitDrafts(btn) {
  const d = drafts(); if (!d.length) return;
  ADM.token = ADM.token || admToken();
  if (!ADM.token) { location.hash = "#/admin"; return; }
  if (btn) btn.disabled = true;
  try {
    ADM.user = ADM.user || await gh("/user");
    const f = await getFile("data/decisions.csv");
    const name = ADM.user.name || ADM.user.login;
    const lines = d.map((x) => [x.id, x.decision, x.p || "", x.i || "", name, (x.note || "").replace(/[,\n]/g, " ")].join(","));
    const text = ((f.text || "معرف الخبر,القرار,الأولوية,المؤشرات,بواسطة,ملاحظة").replace(/\s+$/, "")) + "\n" + lines.join("\n") + "\n";
    await putFile("data/decisions.csv", text, f.sha, `تثبيت ${d.length} قرار مراجعة — ${ADM.user.login}`);
    saveDrafts([]); toast(`ثُبّت ${fmt(d.length)} قرارًا — يُعاد البناء خلال دقائق`); route();
  } catch (e) { toast("تعذر الحفظ: " + e.message); if (btn) btn.disabled = false; }
}

/* --- التشفير (متوافق مع scripts/recipients.py) */
const ub64 = (u8) => { let s = ""; u8.forEach((b) => (s += String.fromCharCode(b))); return btoa(s); };
const b64u = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function encryptJSON(obj, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deriveKey(pass, salt), new TextEncoder().encode(JSON.stringify(obj))));
  return JSON.stringify({ v: 1, kdf: "pbkdf2-sha256-200000", alg: "aes-256-gcm", salt: ub64(salt), iv: ub64(iv), ct: ub64(ct) }, null, 1) + "\n";
}
async function decryptJSON(text, pass) {
  const o = JSON.parse(text);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64u(o.iv) }, await deriveKey(pass, b64u(o.salt)), b64u(o.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/* --- الواجهة */
async function viewAdmin(q) {
  ADM.token = ADM.token || admToken();
  if (!ADM.token) return adminLogin();
  if (!ADM.user) {
    try {
      ADM.user = await gh("/user");
      const repo = await gh(`/repos/${REPO}`);
      if (!repo.permissions?.push) throw new Error("هذا الحساب لا يملك صلاحية الكتابة على المستودع");
    } catch (e) {
      ADM.token = null; ADM.user = null;
      return adminLogin(`تعذر الدخول: ${e.message}`);
    }
  }
  const tab = q.get("tab") || "mail";
  const tabs = [["mail", "القائمة البريدية"], ["newsletter", "النشرة"], ["runs", "التشغيل"], ["sources", "المصادر"], ["decisions", "القرارات"]];
  let body = "";
  try {
    body = await ({ mail: admMail, newsletter: admNewsletter, runs: admRuns, sources: admSources, decisions: admDecisions })[tab]();
  } catch (e) {
    body = `<div class="card"><p class="down">خطأ: ${esc(e.message)}</p></div>`;
  }
  setTimeout(() => { const b = $("#admLogout"); if (b) b.onclick = () => { try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch {} Object.assign(ADM, { token: null, user: null, pass: null, recips: null }); applyMode(); route(); }; });
  return `<section class="hero"><div><h1>⚙️ إدارة المنصة</h1><p>مرحبًا ${esc(ADM.user.name || ADM.user.login)} — كل تغيير هنا يُحفظ في المستودع باسمك ويمكن الرجوع عنه</p></div></section>
    <div class="row noprint" style="margin-bottom:12px"><div class="tabs" style="margin:0">${tabs.map(([k, l]) => `<button class="${k === tab ? "on" : ""}" onclick="location.hash='#/admin?tab=${k}'">${l}</button>`).join("")}</div><span class="spacer"></span><button class="btn sm" id="admLogout">تسجيل الخروج</button></div>${body}`;
}

function adminLogin(err = "") {
  setTimeout(() => {
    $("#admGo").onclick = () => {
      const t = $("#admTok").value.trim(); if (!t) return;
      ADM.token = t; ADM.user = null;
      try { ($("#admRemember").checked ? localStorage : sessionStorage).setItem(TOKEN_KEY, t); localStorage.setItem("vn-team", "1"); } catch {}
      applyMode(); route();
    };
  });
  return `<section class="hero"><div><h1>⚙️ إدارة المنصة</h1><p>للمشرفين فقط — الدخول بمفتاح من GitHub</p></div></section>
  <div class="grid g2"><div class="card">
    ${err ? `<p class="down">${esc(err)}</p>` : ""}
    <label class="muted" style="font-size:13px">مفتاح GitHub (Personal Access Token)</label>
    <input id="admTok" type="password" dir="ltr" style="width:100%;padding:9px;border:1px solid var(--line);border-radius:8px;margin:6px 0" placeholder="github_pat_...">
    <label style="font-size:13.5px;display:flex;gap:8px;align-items:center;margin:6px 0 12px"><input type="checkbox" id="admRemember"> تذكّرني على هذا الجهاز (لا تستخدمه على جهاز مشترك)</label>
    <button class="btn p" id="admGo">دخول</button></div>
  <div class="card"><h3>إنشاء المفتاح (مرة واحدة)</h3><ol style="font-size:14px;margin:0;padding-right:18px">
    <li>افتح <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a></li>
    <li>الاسم: <code>vision-news-admin</code>، والمدة: 90 يومًا مثلًا.</li>
    <li><b>Repository access</b> ← Only select repositories ← <code>vision-news</code>.</li>
    <li><b>Permissions</b> ← Repository permissions: <b>Contents</b>: Read and write، و<b>Actions</b>: Read and write.</li>
    <li>Generate token، ثم انسخه والصقه هنا.</li></ol>
    <p class="note" style="margin-top:10px">المفتاح يُحفظ في متصفحك فقط ولا يُرسل إلا إلى GitHub. أي شخص تريده مشرفًا: أضفه Collaborator في المستودع، وينشئ مفتاحه بنفسه.</p></div></div>`;
}

/* القائمة البريدية */
async function admMail() {
  if (!ADM.pass || !ADM.recips) {
    const f = await getFile("data/recipients.enc");
    setTimeout(() => {
      $("#admUnlock").onclick = async () => {
        const pass = $("#admPass").value; if (pass.length < 10) { toast("كلمة السر قصيرة (10 أحرف على الأقل)"); return; }
        try {
          ADM.recips = f.text ? await decryptJSON(f.text, pass) : [];
          ADM.recipsSha = f.sha; ADM.pass = pass; route();
        } catch { toast("كلمة السر غير صحيحة"); }
      };
    });
    return `<div class="card" style="max-width:640px"><h2>فتح القائمة البريدية</h2>
      <p>${f.text ? "القائمة محفوظة مشفّرة. أدخل كلمة سر القائمة لفتحها." : "لا توجد قائمة بعد. اختر كلمة سر قوية للقائمة (10 أحرف فأكثر) — ستحتاجها في كل مرة، وتُحفظ نفسها في أسرار GitHub باسم <code>RECIPIENTS_KEY</code>."}</p>
      <input id="admPass" type="password" dir="ltr" style="width:100%;padding:9px;border:1px solid var(--line);border-radius:8px;margin:6px 0 12px">
      <button class="btn p" id="admUnlock">${f.text ? "فتح" : "إنشاء القائمة"}</button>
      ${f.text ? "" : `<div class="note" style="margin-top:12px">بعد الإنشاء: افتح <a href="https://github.com/${REPO}/settings/secrets/actions/new" target="_blank" rel="noopener">أسرار المستودع</a> وأضف سرًا اسمه <code>RECIPIENTS_KEY</code> قيمته كلمة السر نفسها، حتى يستطيع نظام الإرسال فك القائمة.</div>`}</div>`;
  }
  const pr = S.meta.priorities;
  const rows = ADM.recips.map((r, i) => `<tr><td><input data-k="name" data-i="${i}" value="${esc(r.name || "")}" placeholder="الاسم"></td>
    <td><input data-k="email" data-i="${i}" value="${esc(r.email)}" dir="ltr" placeholder="name@economy.gov.om"></td>
    <td class="pcodes">${[["ALL", "الكل"], ...pr.map((p) => [p.code, p.code])].map(([c, l]) => `<label title="${esc(c === "ALL" ? "كل الأولويات + الخلاصة العامة" : P(c).nameAr)}"><input type="checkbox" data-c="${c}" data-i="${i}" ${r.codes.includes(c) ? "checked" : ""}>${l}</label>`).join("")}</td>
    <td><label class="sw"><input type="checkbox" data-k="active" data-i="${i}" ${r.active !== false ? "checked" : ""}> فعّال</label></td>
    <td><button class="btn sm no" data-del="${i}">حذف</button></td></tr>`).join("");
  const coverage = () => { const per = {}; ADM.recips.filter((r) => r.active !== false).forEach((r) => r.codes.forEach((c) => (per[c] = (per[c] || 0) + 1)));
    return pr.map((p) => { const n = (per[p.code] || 0) + (per.ALL || 0); return `<span class="${n ? "" : "down"}">${p.code} (${fmt(n)})</span>`; }).join(" · "); };
  setTimeout(() => {
    const root = $("#admMailT");
    root.addEventListener("change", () => setTimeout(() => ($("#admCov").innerHTML = coverage())));
    root.querySelectorAll("input[data-k]").forEach((el) => (el.onchange = () => { const r = ADM.recips[+el.dataset.i]; r[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value.trim(); }));
    root.querySelectorAll("input[data-c]").forEach((el) => (el.onchange = () => { const r = ADM.recips[+el.dataset.i]; const s = new Set(r.codes); el.checked ? s.add(el.dataset.c) : s.delete(el.dataset.c); r.codes = [...s]; }));
    root.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { ADM.recips.splice(+b.dataset.del, 1); route(); }));
    $("#admAdd").onclick = () => { ADM.recips.push({ name: "", email: "", codes: [], active: true }); route(); };
    $("#admSave").onclick = async () => {
      const bad = ADM.recips.filter((r) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email || "") || !r.codes.length);
      if (bad.length) { toast("كل مستلم يحتاج بريدًا صحيحًا وأولوية واحدة على الأقل"); return; }
      const b = $("#admSave"); b.disabled = true; b.textContent = "جارٍ الحفظ…";
      try {
        ADM.recipsSha = await putFile("data/recipients.enc", await encryptJSON(ADM.recips, ADM.pass), ADM.recipsSha, `تحديث القائمة البريدية (${ADM.recips.length} مستلمًا) — ${ADM.user.login}`);
        toast("حُفظت القائمة مشفّرة في المستودع");
      } catch (e) { toast("تعذر الحفظ: " + e.message); }
      b.disabled = false; b.textContent = "حفظ القائمة";
    };
  });
  return `<div class="card"><div class="row"><h2>القائمة البريدية (${fmt(ADM.recips.length)})</h2><span class="spacer"></span><button class="btn" id="admAdd">+ إضافة مختص</button><button class="btn p" id="admSave">حفظ القائمة</button></div>
    <p class="muted" style="font-size:13px">اختر لكل مختص أولوياته؛ «الكل» يعني كل الأولويات مع الخلاصة العامة (للقيادة). لا تُحفظ التعديلات حتى تضغط «حفظ القائمة».</p>
    <div style="overflow-x:auto"><table id="admMailT" class="admt"><thead><tr><th>الاسم</th><th>البريد</th><th>الأولويات</th><th></th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="muted">القائمة فارغة — أضف أول مختص.</td></tr>`}</tbody></table></div>
    <p class="muted" style="font-size:13px;margin-top:10px">عدد المستلمين لكل أولوية (الأحمر = بلا مستلم): <span id="admCov">${coverage()}</span></p></div>`;
}

/* النشرة */
async function admNewsletter() {
  const runs = await gh(`/repos/${REPO}/actions/workflows/newsletter.yml/runs?per_page=8`).catch(() => ({ workflow_runs: [] }));
  const log = await getFile("data/state/newsletter_log.json");
  const entries = log.text ? JSON.parse(log.text).slice().reverse().slice(0, 10) : [];
  const weeks = S.meta.reports.filter((r) => r.type === "week").slice().reverse().slice(0, 6);
  setTimeout(() => {
    const go = async (mode) => {
      if (mode === "send" && !confirm("إرسال النشرة لكل المختصين في القائمة؟ تأكد أنك راجعت المعاينة.")) return;
      try { await dispatch("newsletter.yml", { mode, week: $("#admWeek").value, force: $("#admForce").checked ? "true" : "false" }); toast(mode === "send" ? "بدأ الإرسال — تابع الحالة أدناه" : "بدأ إرسال المعاينة إلى بريدك"); setTimeout(route, 4000); }
      catch (e) { toast("تعذر التشغيل: " + e.message); }
    };
    $("#admPrev").onclick = () => go("preview");
    $("#admSend").onclick = () => go("send");
  });
  return `<div class="grid g2"><div class="card"><h2>إرسال النشرة</h2>
      <label class="muted" style="font-size:13px">الأسبوع</label>
      <select id="admWeek" style="width:100%;padding:8px;border:1px solid var(--line);border-radius:8px;margin:4px 0 10px"><option value="">الأسبوع الأخير (تلقائي)</option>${weeks.map((w) => `<option value="${w.id.slice(2)}">${esc(w.label)}${w.partial ? " (جارٍ)" : ""} — ${fmt(w.total)} خبر</option>`).join("")}</select>
      <label style="font-size:13.5px;display:flex;gap:8px;align-items:center;margin-bottom:12px"><input type="checkbox" id="admForce"> إعادة الإرسال حتى لو أُرسلت نشرة هذا الأسبوع</label>
      <div class="row"><button class="btn" id="admPrev">📧 أرسل لي معاينة</button><button class="btn p" id="admSend">📨 أرسل للمختصين</button></div>
      <p class="note" style="margin-top:12px">المعاينة تصل تلقائيًا كل سبت 6 مساءً. الإرسال للمختصين لا يتم إلا بضغطك هنا.</p></div>
    <div class="card"><h2>آخر التشغيلات</h2>${runsTable(runs.workflow_runs)}
      <h3 style="margin-top:14px">سجل الإرسال</h3><table class="mini">${entries.map((x) => `<tr><td>${x.mode === "send" ? "📨 إرسال" : "📧 معاينة"}</td><td>${esc(x.week.slice(2))}</td><td class="n">${fmt(x.count)}</td><td class="muted">${new Date(x.at).toLocaleString("ar-OM-u-nu-latn")}</td></tr>`).join("") || `<tr><td class="muted">لم تُرسل نشرة بعد.</td></tr>`}</table></div></div>`;
}

function runsTable(runs) {
  const st = (r) => r.status !== "completed" ? `<span class="st review">⏳ يعمل</span>` : r.conclusion === "success" ? `<span class="st auto">✓ نجح</span>` : `<span class="st rejected">✗ فشل</span>`;
  return `<table class="mini">${(runs || []).map((r) => `<tr><td>${st(r)}</td><td>${esc(r.name)}</td><td class="muted">${esc(r.event === "workflow_dispatch" ? "يدوي" : r.event === "schedule" ? "مجدول" : "تحديث")}</td><td class="muted">${new Date(r.created_at).toLocaleString("ar-OM-u-nu-latn")}</td><td><a href="${esc(r.html_url)}" target="_blank" rel="noopener">التفاصيل</a></td></tr>`).join("") || `<tr><td class="muted">لا توجد تشغيلات.</td></tr>`}</table>`;
}

/* التشغيل */
async function admRuns() {
  const runs = await gh(`/repos/${REPO}/actions/runs?per_page=12`);
  setTimeout(() => {
    $("#admCollect").onclick = async () => { try { await dispatch("update.yml", { collect: "true" }); toast("بدأ الجمع — يستغرق 3–5 دقائق"); setTimeout(route, 4000); } catch (e) { toast("تعذر التشغيل: " + e.message); } };
    $("#admRefresh").onclick = () => route();
  });
  return `<div class="card"><div class="row"><h2>التشغيل والتحديث</h2><span class="spacer"></span><button class="btn" id="admRefresh">تحديث الحالة</button><button class="btn p" id="admCollect">🔄 اجمع الأخبار الآن</button></div>
    <p class="muted" style="font-size:13px">الجمع يعمل تلقائيًا كل 3 ساعات. بعد اكتمال أي تشغيل بنجاح يُحدَّث الموقع خلال دقيقة.</p>${runsTable(runs.workflow_runs)}</div>`;
}

/* المصادر */
async function admSources() {
  const f = await getFile("config/sources.json");
  const cfg = JSON.parse(f.text);
  const health = Object.fromEntries(S.meta.sources.map((s) => [s.id, s]));
  setTimeout(() => {
    $("#admSrcSave").onclick = async () => {
      document.querySelectorAll("[data-src]").forEach((el) => {
        const s = cfg.sources.find((x) => x.id === el.dataset.src);
        if (el.dataset.f === "active") s.active = el.checked;
        if (el.dataset.f === "feeds") s.feeds = el.value.split("\n").map((x) => x.trim()).filter(Boolean);
      });
      try { await putFile("config/sources.json", JSON.stringify(cfg, null, 2) + "\n", f.sha, `تعديل المصادر — ${ADM.user.login}`); toast("حُفظت المصادر — تُطبَّق في الجمع القادم"); }
      catch (e) { toast("تعذر الحفظ: " + e.message); }
    };
  });
  return `<div class="card"><div class="row"><h2>المصادر</h2><span class="spacer"></span><button class="btn p" id="admSrcSave">حفظ التعديلات</button></div>
    <p class="muted" style="font-size:13px">روابط RSS تُجرَّب بالترتيب (رابط في كل سطر). لإضافة مصدر جديد كليًا أرسل رابطه لمسؤول النظام.</p>
    <table class="admt"><thead><tr><th>المصدر</th><th>الحالة</th><th>روابط RSS</th><th>فعّال</th></tr></thead><tbody>
    ${cfg.sources.map((s) => { const h = health[s.id] || {}; return `<tr><td><b>${esc(s.nameAr)}</b><div class="muted" style="font-size:12px">${esc(s.kind || "")}</div></td>
      <td style="font-size:13px">${!h.lastRunAt ? "لم يُجرَّب" : h.consecutiveFailures ? `<span class="down">فشل ×${fmt(h.consecutiveFailures)}</span>` : `<span class="up">يعمل</span> (${h.method === "rss" ? "RSS" : "صفحة"})`}</td>
      <td><textarea data-src="${s.id}" data-f="feeds" dir="ltr" rows="${Math.max(2, s.feeds.length)}" style="width:100%;min-width:280px;font-size:12px;border:1px solid var(--line);border-radius:6px;padding:6px">${esc(s.feeds.join("\n"))}</textarea></td>
      <td><input type="checkbox" data-src="${s.id}" data-f="active" ${s.active !== false ? "checked" : ""}></td></tr>`; }).join("")}</tbody></table></div>`;
}

/* القرارات */
async function admDecisions() {
  const d = drafts();
  const f = await getFile("data/decisions.csv");
  const existing = (f.text || "").trim().split("\n").length - 1;
  setTimeout(() => {
    const b = $("#admDecSave"); if (!b) return;
    b.onclick = () => commitDrafts(b);
  });
  return `<div class="card"><h2>قرارات المراجعة</h2>
    <p>القرارات المحفوظة على هذا الجهاز من صفحة «المراجعة»: <b>${fmt(d.length)}</b>. القرارات المثبتة سابقًا في المستودع: ${fmt(Math.max(0, existing))}.</p>
    ${d.length ? `<table class="mini">${d.map((x) => `<tr><td>${esc(x.decision)}</td><td dir="auto">${esc(x.title)}</td><td>${esc(x.p || "")} ${esc(x.i || "")}</td></tr>`).join("")}</table>
    <button class="btn p" id="admDecSave" style="margin-top:12px">تثبيت القرارات في المستودع</button>` : `<p class="muted">لا توجد قرارات جديدة. راجع الأخبار من صفحة <a href="#/review">المراجعة</a> ثم عد هنا.</p>`}</div>`;
}
