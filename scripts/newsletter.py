"""النشرة الأسبوعية بالبريد لمختصي الأولويات.

الوضعان:
  python scripts/newsletter.py preview   نسخة معاينة لك أنت فقط (تحوي كل الأولويات)
  python scripts/newsletter.py send      إرسال لكل مختص نشرة أولوياته (بعد مراجعتك للمعاينة)

الفترة: الأسبوع (الأحد–السبت) الذي ينتهي قبل يوم التشغيل أو فيه. يمكن تحديده: --week 2026-11-08

الإعداد كله في أسرار GitHub (لا يُكتب أي بريد في المستودع العام):
  SMTP_USER       عنوان Gmail المرسِل
  SMTP_PASSWORD   كلمة مرور التطبيقات (App Password) لهذا الحساب
  RECIPIENTS_KEY  كلمة سر القائمة البريدية المشفّرة data/recipients.enc (تُدار من صفحة «إدارة المنصة»)
  RECIPIENTS      (بديل اختياري) سطر لكل مستلم:  البريد, رموز الأولويات أو ALL
                  مثال:  ahmed@economy.gov.om, P06 P08
  PREVIEW_TO      (اختياري) بريد المعاينة؛ الافتراضي SMTP_USER

قواعد الأمان: لا صور ولا مرفقات ولا تتبع؛ الروابط مباشرة لمواقع الصحف فقط (روابط Google الوسيطة تُحذف ويبقى اسم المصدر)؛
كل مستلم يُرسل له منفردًا فلا تنكشف عناوين الآخرين.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import smtplib
import ssl
import sys
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from urllib.parse import urlsplit

from build import week_start
from common import SITE, STATE, now_iso, read_json, write_json

MUSCAT = timezone(timedelta(hours=4))
SITE_URL = os.getenv("SITE_URL", "https://ov2040.github.io/vision-news/")
TYPE_ORDER = ["decree", "decision", "international", "agreement", "figures", "project", "other", "event"]
MAX_PER_PRIORITY = 8
e = html.escape


# ---------------------------------------------------------------- البيانات
def load(week: str | None):
    meta = read_json(SITE / "data" / "meta.json", None)
    if not meta:
        raise SystemExit("لم تُبنَ البيانات: شغّل scripts/build.py أولًا.")
    today = datetime.now(MUSCAT).date()
    start = date.fromisoformat(week) if week else week_start(today - timedelta(days=1))
    rid = f"w-{start.isoformat()}"
    report = read_json(SITE / "data" / "reports" / f"{rid}.json", None)
    if not report:
        raise SystemExit(f"لا يوجد تقرير للأسبوع {start} (لا أخبار فيه).")
    arts = read_json(SITE / "data" / "articles.json", [])
    arts = [a for a in arts if a["st"] in ("auto", "confirmed") and report["start"] <= a["d"] <= report["end"]]
    return meta, report, arts


def parse_recipients(raw: str, valid: set) -> tuple[list, list]:
    out, errors = [], []
    for n, line in enumerate((raw or "").splitlines(), start=1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        email, _, codes = line.partition(",")
        email = email.strip()
        if "@" not in email:
            errors.append(f"سطر {n}: بريد غير صالح")
            continue
        codes = [c.strip().upper() for c in codes.replace("،", " ").replace(";", " ").split() if c.strip()] or ["ALL"]
        bad = [c for c in codes if c != "ALL" and c not in valid]
        if bad:
            errors.append(f"سطر {n}: رموز غير معروفة {bad}")
            continue
        out.append({"email": email, "codes": codes})
    return out, errors


# ---------------------------------------------------------------- الصياغة
def link_html(a: dict, meta: dict) -> str:
    src = a.get("pub") or next((s["nameAr"] for s in meta["sources"] if s["id"] == a["s"]), a["s"])
    host = (urlsplit(a["u"]).hostname or "").removeprefix("www.")
    title = e(a["t"])
    if not host or "news.google." in host:  # رابط وسيط: يُحذف ويبقى المصدر
        return f'<span style="color:#1f1d2b">{title}</span><br><span style="color:#777;font-size:12px">{e(src)} · {a["d"]}</span>'
    return (f'<a href="{e(a["u"])}" style="color:#1f1d2b;text-decoration:none">{title}</a>'
            f'<br><span style="color:#777;font-size:12px">{e(src)} · {e(host)} · {a["d"]}</span>')


def digest_html(dg: dict, by_id: dict, meta: dict) -> str:
    # الخلاصة بالقواعد = عناوين الأخبار نفسها، فلا تُكرر في البريد؛ تظهر فقط الخلاصة التحريرية (الذكاء الاصطناعي)
    if not dg or not dg.get("bullets") or dg.get("source") != "ai":
        return ""
    rows = []
    for b in dg["bullets"][:6]:
        icon = meta["types"].get(b.get("type") or "", {}).get("icon", "•") if b.get("type") else "•"
        srcs = []
        for rid in b.get("refs", [])[:3]:
            a = by_id.get(rid)
            if a:
                srcs.append(e(a.get("pub") or next((s["nameAr"] for s in meta["sources"] if s["id"] == a["s"]), "")))
        rows.append(f'<li style="margin:0 0 8px">{icon} {e(b["text"])}'
                    + (f'<span style="color:#888;font-size:12px"> — {"، ".join(dict.fromkeys(srcs))}</span>' if srcs else "") + "</li>")
    return f'<ul style="padding:0 18px 0 0;margin:6px 0 4px">{"".join(rows)}</ul>'


def section(code: str, meta: dict, report: dict, arts: list, by_id: dict) -> tuple[str, str, int]:
    pr = next(p for p in report["priorities"] if p["code"] == code)
    items = [a for a in arts if code in a["p"]]
    items.sort(key=lambda a: (TYPE_ORDER.index(a.get("ty", "other")) if a.get("ty", "other") in TYPE_ORDER else 9, a["d"]))
    name = pr["nameAr"]
    if not items:
        return (f'<h3 style="margin:22px 0 4px;color:#3f3566;font-size:16px">{code} — {e(name)}</h3>'
                f'<p style="color:#888;margin:0">لم تُرصد أخبار لهذه الأولوية هذا الأسبوع.</p>',
                f"\n{code} — {name}\nلم تُرصد أخبار هذا الأسبوع.\n", 0)
    rows = "".join(
        f'<tr><td style="padding:7px 0;border-bottom:1px solid #eee;font-size:14px;line-height:1.6">'
        f'<span style="color:#3f3566;font-size:12px">{meta["types"][a.get("ty", "other")]["icon"]} {e(meta["types"][a.get("ty", "other")]["label"])}</span><br>'
        f'{link_html(a, meta)}</td></tr>' for a in items[:MAX_PER_PRIORITY])
    more = f'<p style="font-size:12px;color:#777">و{len(items) - MAX_PER_PRIORITY} أخبار أخرى في <a href="{SITE_URL}#/p/{code}?per={report["id"]}" style="color:#665893">صفحة الأولوية</a>.</p>' if len(items) > MAX_PER_PRIORITY else ""
    h = (f'<h3 style="margin:24px 0 2px;color:#3f3566;font-size:16px">{code} — {e(name)} '
         f'<span style="color:#888;font-weight:normal;font-size:13px">({len(items)} خبر، الأسبوع السابق {pr["prev"]})</span></h3>'
         + (f'<p style="margin:6px 0 2px;font-weight:bold;font-size:14px">الخلاصة:</p>{digest_html(pr.get("digest"), by_id, meta)}' if digest_html(pr.get("digest"), by_id, meta) else "") +
         f'<p style="margin:10px 0 2px;font-weight:bold;font-size:14px">الأخبار:</p><table width="100%" cellpadding="0" cellspacing="0">{rows}</table>{more}')
    t = [f"\n{code} — {name} ({len(items)} خبر)"]
    if (pr.get("digest") or {}).get("source") == "ai":
        t += [f"• {b['text']}" for b in pr["digest"]["bullets"][:6]]
    t += ["الأخبار:"] + [f"- {a['t']} ({a.get('pub') or a['s']}، {a['d']})" for a in items[:MAX_PER_PRIORITY]]
    return h, "\n".join(t) + "\n", len(items)


def render(meta: dict, report: dict, arts: list, codes: list[str], preview_note: str = "") -> tuple[str, str, str, int]:
    by_id = {a["id"]: a for a in arts}
    all_codes = [p["code"] for p in meta["priorities"]]
    everyone = codes == ["ALL"]
    show = all_codes if everyone else [c for c in all_codes if c in codes]
    parts, texts, total = [], [], 0
    for c in show:
        h, t, n = section(c, meta, report, arts, by_id)
        if everyone and n == 0:
            continue
        parts.append(h)
        texts.append(t)
        total += n
    legis = [a for a in arts if a.get("ty") in ("decree", "decision") and (everyone or set(a["p"]) & set(show))]
    legis_html = ""
    if legis:
        legis_html = ('<h2 style="font-size:17px;margin:22px 0 6px;color:#1f1d2b">📜 المراسيم والقرارات</h2><table width="100%" cellpadding="0" cellspacing="0">'
                      + "".join(f'<tr><td style="padding:6px 0;border-bottom:1px solid #eee;font-size:14px">{link_html(a, meta)}</td></tr>' for a in legis[:10])
                      + "</table>")
    overall = ""
    if everyone and digest_html(report.get("digest"), by_id, meta):
        overall = (f'<h2 style="font-size:17px;margin:18px 0 6px;color:#1f1d2b">الخلاصة العامة</h2>'
                   f'{digest_html(report.get("digest"), by_id, meta)}')
    label = report["label"]
    names = "، ".join(next(p["nameAr"] for p in meta["priorities"] if p["code"] == c) for c in show) if not everyone else "كل الأولويات"
    subject = f"رصد الرؤية | {('أولوية ' + names) if len(show) == 1 else 'النشرة الأسبوعية'} | {label}"
    note = f'<div style="background:#fff3d6;padding:10px 14px;border-radius:8px;margin-bottom:14px;font-size:13px">{preview_note}</div>' if preview_note else ""
    body = f"""<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"></head>
<body style="margin:0;background:#f4f3f8;font-family:Tahoma,Arial,sans-serif;direction:rtl;text-align:right">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3f8"><tr><td align="center" style="padding:18px 8px">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:10px">
<tr><td style="background:#3f3566;color:#ffffff;padding:18px 24px;border-radius:10px 10px 0 0">
  <div style="font-size:19px;font-weight:bold">رصد الرؤية — النشرة الأسبوعية</div>
  <div style="font-size:13px;opacity:.85">الرصد الإخباري لرؤية عُمان 2040 · {e(label)}</div></td></tr>
<tr><td style="padding:18px 24px;color:#1f1d2b;font-size:14px;line-height:1.7">
{note}<p style="margin:0 0 6px">الأولويات في هذه النشرة: <b>{e(names)}</b> — {total} خبرًا مرتبطًا بالرؤية هذا الأسبوع.</p>
{overall}{legis_html}{''.join(parts)}
<p style="margin:26px 0 0;font-size:12px;color:#888;border-top:1px solid #eee;padding-top:12px">
نشرة آلية من «رصد الرؤية»: تُجمع الأخبار من المصادر العُمانية والعالمية وتُصنّف وفق أولويات رؤية عُمان 2040. الروابط تفتح الخبر في موقع الصحيفة الأصلية.
للاطلاع على كل الأخبار: <a href="{SITE_URL}" style="color:#665893">{e(SITE_URL)}</a></p>
</td></tr></table></td></tr></table></body></html>"""
    text = f"رصد الرؤية — النشرة الأسبوعية ({label})\nالأولويات: {names}\n" + "".join(texts) + f"\n{SITE_URL}\n"
    return subject, body, text, total


# ---------------------------------------------------------------- الإرسال
def smtp_send(messages: list[EmailMessage]) -> None:
    user, pwd = os.getenv("SMTP_USER"), os.getenv("SMTP_PASSWORD")
    if not user or not pwd:
        raise SystemExit("ينقص SMTP_USER أو SMTP_PASSWORD في أسرار GitHub.")
    host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    with smtplib.SMTP_SSL(host, int(os.getenv("SMTP_PORT", "465")), context=ssl.create_default_context(), timeout=60) as s:
        s.login(user, pwd)
        for m in messages:
            s.send_message(m)


def message(to: str, subject: str, body: str, text: str) -> EmailMessage:
    m = EmailMessage()
    m["From"] = formataddr(("رصد الرؤية", os.getenv("SMTP_USER", "")))
    m["To"] = to
    m["Subject"] = subject
    m["Message-ID"] = make_msgid(domain="vision-news")
    m.set_content(text)
    m.add_alternative(body, subtype="html")
    return m


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["preview", "send", "render"])
    ap.add_argument("--week")
    ap.add_argument("--force", action="store_true", help="إعادة الإرسال حتى لو أُرسلت نشرة هذا الأسبوع")
    a = ap.parse_args(argv)
    meta, report, arts = load(a.week)
    valid = {p["code"] for p in meta["priorities"]}
    recipients, errors = parse_recipients(os.getenv("RECIPIENTS", ""), valid)
    enc = SITE.parent / "data" / "recipients.enc"
    if enc.exists():
        if not os.getenv("RECIPIENTS_KEY"):
            errors.append("توجد قائمة مشفّرة لكن السر RECIPIENTS_KEY غير مضاف في GitHub")
        else:
            from recipients import decrypt
            try:
                for r in decrypt(enc.read_text(encoding="utf-8"), os.environ["RECIPIENTS_KEY"]):
                    codes = [c for c in r.get("codes", []) if c == "ALL" or c in valid]
                    if r.get("active", True) and r.get("email") and codes and r["email"] not in {x["email"] for x in recipients}:
                        recipients.append({"email": r["email"], "codes": codes, "name": r.get("name", "")})
            except Exception:
                errors.append("تعذر فك القائمة المشفّرة: RECIPIENTS_KEY لا يطابق كلمة سر القائمة")
    for err in errors:
        print("تنبيه RECIPIENTS:", err)

    if a.mode == "render":  # لفحص الشكل محليًا
        subject, body, text, total = render(meta, report, arts, ["ALL"])
        (SITE.parent / "data" / "newsletter_preview.html").write_text(body, encoding="utf-8")
        print(subject, total)
        return 0

    log = read_json(STATE / "newsletter_log.json", [])
    if a.mode == "preview":
        counts = {}
        for r in recipients:
            for c in r["codes"]:
                counts[c] = counts.get(c, 0) + 1
        dist = "، ".join(f"{k}: {v}" for k, v in sorted(counts.items())) or "لا مستلمين بعد (أضف RECIPIENTS في الأسرار)"
        note = (f"<b>نسخة معاينة لك فقط.</b> عدد المستلمين: {len(recipients)} ({e(dist)}). كل مختص سيستلم أقسام أولوياته فقط. "
                f"للإرسال: GitHub ← Actions ← «النشرة الأسبوعية» ← Run workflow ← اختر send.")
        subject, body, text, total = render(meta, report, arts, ["ALL"], note)
        to = os.getenv("PREVIEW_TO") or os.getenv("SMTP_USER", "")
        smtp_send([message(to, "[معاينة] " + subject, body, text)])
        log.append({"at": now_iso(), "week": report["id"], "mode": "preview", "count": 1})
        print(f"أُرسلت المعاينة ({total} خبرًا).")
    else:
        if not recipients:
            raise SystemExit("لا يوجد مستلمون: أضف RECIPIENTS في أسرار GitHub.")
        if not a.force and any(x["week"] == report["id"] and x["mode"] == "send" for x in log):
            raise SystemExit(f"نشرة {report['label']} أُرسلت مسبقًا. استخدم force لإعادة الإرسال.")
        msgs = []
        for r in recipients:
            subject, body, text, total = render(meta, report, arts, r["codes"])
            msgs.append(message(r["email"], subject, body, text))
        smtp_send(msgs)
        log.append({"at": now_iso(), "week": report["id"], "mode": "send", "count": len(msgs)})
        print(f"أُرسلت {len(msgs)} نشرة.")
    write_json(STATE / "newsletter_log.json", log[-100:])  # بلا عناوين بريد
    return 0


if __name__ == "__main__":
    sys.exit(main())
