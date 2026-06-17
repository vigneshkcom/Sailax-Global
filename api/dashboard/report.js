// api/dashboard/report.js
// Scheduled DAILY ads report, emailed via Resend.
//
// Triggered by Vercel Cron (see vercel.json -> "crons"). For each account it
// pulls YESTERDAY's spend + leads (same sources as the live dashboard) plus a
// 7-day context line, then emails an HTML summary. Every secret stays
// server-side — nothing is ever returned to the browser.
//
// Vercel Environment Variables:
//   RESEND_API_KEY     Resend API key (re_...).                         REQUIRED
//   REPORT_RECIPIENTS  Comma-separated To: addresses.                   REQUIRED
//   REPORT_FROM        From: header. Default "Sailax Ads <onboarding@resend.dev>".
//                      (The onboarding@resend.dev test sender only delivers to
//                       your own Resend account email until you verify a domain.)
//   CRON_SECRET        If set, the endpoint only runs for requests carrying
//                      "Authorization: Bearer <CRON_SECRET>" — Vercel Cron adds
//                      this header automatically. Leave UNSET to test by URL.
//   DASHBOARD_URL      Optional "View live dashboard" link in the email.
//   META_TOKEN, GHL_API_KEY_UK/AU, GHL_LOCATION_ID_UK/AU  (as used elsewhere)

const META_API_VERSION = 'v21.0';
const ONSITE_LEAD_TYPES = ['onsite_conversion.lead_grouped', 'leadgen_grouped', 'lead'];
const PIXEL_LEAD_TYPE = 'offsite_conversion.fb_pixel_lead';

// Mirrors the dashboard's ACCOUNTS config. Aquoz first.
const ACCOUNTS = [
  { key: 'au', name: 'Aquoz',     sub: 'Australia',      accountId: '1616113923003676', currency: 'AUD', locale: 'en-AU', tz: 'Australia/Sydney', accent: '#FF6B35', ghlLeadSource: 'facebook' },
  { key: 'uk', name: 'Sailax UK', sub: 'United Kingdom', accountId: '1220120669692442', currency: 'GBP', locale: 'en-GB', tz: 'Europe/London',    accent: '#3B82F6', ghlLeadSource: null },
];

/* ── helpers ──────────────────────────────────────────────────────────── */
const todayIn = (tz) => new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const money = (v, a, dec = 0) =>
  new Intl.NumberFormat(a.locale, { style: 'currency', currency: a.currency, maximumFractionDigits: dec }).format(v || 0);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function extractLeads(actions) {
  if (!Array.isArray(actions)) return 0;
  const val = (t) => {
    const a = actions.find((x) => x.action_type === t);
    return a ? parseInt(a.value, 10) || 0 : 0;
  };
  const onsite = ONSITE_LEAD_TYPES.reduce((acc, t) => acc || val(t), 0);
  return onsite + val(PIXEL_LEAD_TYPE);
}

async function fetchAllPages(startUrl) {
  let rows = [], url = startUrl, guard = 0;
  while (url && guard < 50) {
    guard++;
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'Meta API error');
    rows = rows.concat(j.data || []);
    url = j.paging && j.paging.next ? j.paging.next : '';
  }
  return rows;
}

/* ── Meta: last-7-days daily + yesterday campaigns ───────────────────────── */
async function fetchMeta(a, token, since7, yesterday) {
  const tok = encodeURIComponent(token);
  const base = `https://graph.facebook.com/${META_API_VERSION}/act_${a.accountId}/insights`;
  const range7 = encodeURIComponent(JSON.stringify({ since: since7, until: yesterday }));
  const range1 = encodeURIComponent(JSON.stringify({ since: yesterday, until: yesterday }));
  const [dayRows, campRows] = await Promise.all([
    fetchAllPages(`${base}?level=account&fields=spend,impressions,clicks,actions&time_increment=1&time_range=${range7}&limit=500&access_token=${tok}`),
    fetchAllPages(`${base}?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks,actions&time_range=${range1}&limit=500&access_token=${tok}`),
  ]);
  const days = dayRows.map((d) => ({
    date: d.date_start,
    spend: parseFloat(d.spend || 0),
    impressions: parseInt(d.impressions || 0, 10),
    clicks: parseInt(d.clicks || 0, 10),
    leads: extractLeads(d.actions),
  }));
  const campaigns = campRows
    .map((c) => ({ name: c.campaign_name, spend: parseFloat(c.spend || 0), leads: extractLeads(c.actions) }))
    .sort((x, y) => y.spend - x.spend);
  return { days, campaigns };
}

/* ── GHL: opportunities (server-side, same logic as the dashboard) ───────── */
async function ghlGet(key, path) {
  const r = await fetch(`https://services.leadconnectorhq.com${path}`, {
    headers: { Authorization: `Bearer ${key}`, Version: '2021-07-28', Accept: 'application/json' },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || j.msg || j.error || `GHL HTTP ${r.status}`);
  return j;
}
async function fetchAllOpps(key, locationId) {
  let all = [], after = null, afterId = null, page = 0;
  while (true) {
    page++;
    let p = `/opportunities/search?location_id=${locationId}&limit=100`;
    if (after) p += `&startAfter=${after}&startAfterId=${afterId}`;
    const j = await ghlGet(key, p);
    const opps = j.opportunities || [];
    all = all.concat(opps);
    if (opps.length < 100 || !(j.meta && j.meta.nextPageUrl)) break;
    after = j.meta?.startAfter;
    afterId = j.meta?.startAfterId;
    if (!after || page > 60) break;
  }
  return all;
}
function filterBySource(opps, src) {
  if (!src) return opps || [];
  return (opps || []).filter((o) =>
    (o.source || o.leadSource || o.attributionSource || '').toLowerCase().includes(src.toLowerCase())
  );
}
const oppDate = (o, tz) => {
  const c = o.createdAt || o.created_at || o.dateAdded;
  return c ? new Date(c).toLocaleDateString('en-CA', { timeZone: tz }) : null;
};
const countOnDay = (opps, tz, day) => (opps || []).filter((o) => oppDate(o, tz) === day).length;
const countInRange = (opps, tz, since, until) =>
  (opps || []).filter((o) => { const d = oppDate(o, tz); return d && d >= since && d <= until; }).length;
function sourcesOnDay(opps, tz, day) {
  const cnt = {};
  (opps || []).forEach((o) => {
    if (oppDate(o, tz) !== day) return;
    const s = o.source || o.leadSource || o.attributionSource || 'Unknown';
    cnt[s] = (cnt[s] || 0) + 1;
  });
  return Object.entries(cnt).sort((a, b) => b[1] - a[1]).map(([src, n]) => ({ src, n }));
}

/* ── per-account data ────────────────────────────────────────────────────── */
async function buildAccount(a) {
  const today = todayIn(a.tz);
  const yesterday = addDays(today, -1);
  const since7 = addDays(today, -7); // 7 days ending yesterday
  const out = { a, yesterday, error: null, ghlError: null, leadsSource: 'meta', campaigns: [], bySource: [] };

  // Meta
  try {
    const meta = await fetchMeta(a, process.env.META_TOKEN, since7, yesterday);
    const dayRow = meta.days.find((d) => d.date === yesterday);
    out.spendY = dayRow ? dayRow.spend : 0;
    out.clicksY = dayRow ? dayRow.clicks : 0;
    out.imprY = dayRow ? dayRow.impressions : 0;
    out.metaLeadsY = dayRow ? dayRow.leads : 0;
    out.spend7 = meta.days.reduce((s, d) => s + d.spend, 0);
    out.metaLeads7 = meta.days.reduce((s, d) => s + d.leads, 0);
    out.campaigns = meta.campaigns.filter((c) => c.spend > 0).slice(0, 6);
  } catch (e) {
    out.error = 'Meta: ' + e.message;
    out.spendY = out.clicksY = out.imprY = out.metaLeadsY = out.spend7 = out.metaLeads7 = 0;
  }

  // GHL leads (preferred when configured); fall back to Meta-reported leads
  out.leadsY = out.metaLeadsY;
  out.leads7 = out.metaLeads7;
  const key = process.env[`GHL_API_KEY_${a.key.toUpperCase()}`];
  const loc = process.env[`GHL_LOCATION_ID_${a.key.toUpperCase()}`];
  if (key && loc) {
    try {
      const opps = await fetchAllOpps(key, loc);
      const leadOpps = filterBySource(opps, a.ghlLeadSource);
      out.leadsY = countOnDay(leadOpps, a.tz, yesterday);
      out.leads7 = countInRange(leadOpps, a.tz, since7, yesterday);
      out.bySource = sourcesOnDay(opps, a.tz, yesterday); // all sources, for visibility
      out.leadsSource = a.ghlLeadSource ? 'ghl-fb' : 'ghl';
    } catch (e) {
      out.ghlError = 'GHL: ' + e.message;
    }
  }

  out.cplY = out.leadsY > 0 ? out.spendY / out.leadsY : null;
  out.cpl7 = out.leads7 > 0 ? out.spend7 / out.leads7 : null;
  return out;
}

/* ── email rendering (table-based, inline styles for client compat) ───────── */
const fmtLongDate = (iso, locale) =>
  new Date(iso + 'T12:00:00Z').toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function kpiCell(label, value, sub, color) {
  return `<td width="50%" style="padding:6px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6F8;border-radius:14px;">
      <tr><td style="padding:16px 18px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:#9CA3AF;">${esc(label)}</div>
        <div style="font-size:27px;font-weight:700;color:${color || '#111827'};line-height:1.1;margin-top:6px;">${value}</div>
        <div style="font-size:12px;color:#6B7280;margin-top:4px;">${esc(sub || '')}</div>
      </td></tr>
    </table>
  </td>`;
}

function accountBlock(r) {
  const a = r.a;
  const header = `<tr><td style="padding:10px 24px 4px;">
      <span style="display:inline-block;background:${a.accent};color:#fff;font-size:13px;font-weight:700;border-radius:10px;padding:5px 12px;">${esc(a.name)}</span>
      <span style="font-size:12px;color:#9CA3AF;margin-left:8px;">${esc(a.sub)} · ${a.currency}</span>
    </td></tr>`;

  if (r.error && !r.campaigns.length && r.leadsSource === 'meta') {
    return `${header}<tr><td style="padding:6px 24px 8px;">
      <div style="background:#FEF2F2;border:1px solid #FECACA;color:#991B1B;border-radius:12px;padding:12px 14px;font-size:13px;">${esc(r.error)}</div>
    </td></tr><tr><td style="padding:14px 24px 6px;"><div style="border-bottom:1px solid #E5E7EB;"></div></td></tr>`;
  }

  const leadTag = r.leadsSource === 'ghl-fb' ? 'CRM · Facebook' : r.leadsSource === 'ghl' ? 'CRM' : 'Meta-reported';
  const kpis = `<table width="100%" cellpadding="0" cellspacing="0">
    <tr>${kpiCell('Spend · yesterday', money(r.spendY, a), `7d: ${money(r.spend7, a)}`, a.accent)}${kpiCell('Leads · yesterday', String(r.leadsY), leadTag, '#111827')}</tr>
    <tr>${kpiCell('Cost / Lead', r.cplY != null ? money(r.cplY, a) : '—', r.cpl7 != null ? `7d: ${money(r.cpl7, a)}` : 'no leads', '#111827')}${kpiCell('Clicks · yesterday', r.clicksY.toLocaleString(), `${r.imprY.toLocaleString()} impressions`, '#111827')}</tr>
  </table>`;

  let src = '';
  if (r.bySource.length) {
    const items = r.bySource
      .map((s) => `<span style="display:inline-block;background:#F5F6F8;border:1px solid #E5E7EB;border-radius:10px;padding:5px 10px;font-size:12px;color:#374151;margin:0 6px 6px 0;">${esc(s.src)} · <strong>${s.n}</strong></span>`)
      .join('');
    src = `<div style="font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#9CA3AF;margin:18px 0 8px;">New leads by source · yesterday</div><div>${items}</div>`;
  }

  let camps = '';
  if (r.campaigns.length) {
    const rows = r.campaigns
      .map((c) => `<tr>
        <td style="padding:8px 6px;font-size:13px;color:#111827;border-bottom:1px solid #F3F4F6;">${esc(c.name)}</td>
        <td align="right" style="padding:8px 6px;font-size:13px;font-weight:600;color:#111827;border-bottom:1px solid #F3F4F6;">${money(c.spend, a)}</td>
        <td align="right" style="padding:8px 6px;font-size:13px;color:#6B7280;border-bottom:1px solid #F3F4F6;">${c.leads || 0}</td>
      </tr>`)
      .join('');
    camps = `<div style="font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#9CA3AF;margin:18px 0 6px;">Top campaigns · yesterday</div>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:10px;font-weight:700;text-transform:uppercase;color:#9CA3AF;padding:0 6px 6px;">Campaign</td>
          <td align="right" style="font-size:10px;font-weight:700;text-transform:uppercase;color:#9CA3AF;padding:0 6px 6px;">Spend</td>
          <td align="right" style="font-size:10px;font-weight:700;text-transform:uppercase;color:#9CA3AF;padding:0 6px 6px;">Leads</td>
        </tr>${rows}
      </table>`;
  }

  const ghlNote = r.ghlError
    ? `<div style="background:#FFFBEB;border:1px solid #FDE68A;color:#92400E;border-radius:12px;padding:10px 14px;font-size:12px;margin-top:12px;">${esc(r.ghlError)} — showing Meta-reported leads.</div>`
    : '';

  return `${header}
    <tr><td style="padding:8px 18px 0;">${kpis}</td></tr>
    <tr><td style="padding:0 24px;">${src}${camps}${ghlNote}</td></tr>
    <tr><td style="padding:16px 24px 6px;"><div style="border-bottom:1px solid #E5E7EB;"></div></td></tr>`;
}

function buildEmail(reports, dateLabel) {
  const blocks = reports.map(accountBlock).join('');
  const dash =
    process.env.DASHBOARD_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/dashboard/`) ||
    (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}/dashboard/`) ||
    '';
  const dashBtn = dash
    ? `<tr><td align="center" style="padding:10px 24px 26px;">
        <a href="${esc(dash)}" style="display:inline-block;background:#FF6B35;color:#fff;text-decoration:none;font-size:14px;font-weight:600;border-radius:12px;padding:13px 30px;">View live dashboard →</a>
      </td></tr>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:0;background:#EEF0F3;font-family:'Outfit',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#EEF0F3;padding:24px 12px;"><tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.06);">
      <tr><td style="background:#111827;padding:24px;">
        <div style="font-size:20px;font-weight:700;color:#fff;">Sail<span style="color:#FF6B35;">ax</span> <span style="font-weight:500;color:#9CA3AF;font-size:15px;">· Daily Ads Report</span></div>
        <div style="font-size:13px;color:#9CA3AF;margin-top:4px;">${esc(dateLabel)}</div>
      </td></tr>
      ${blocks}
      ${dashBtn}
      <tr><td style="background:#F9FAFB;padding:18px 24px;text-align:center;">
        <div style="font-size:11px;color:#9CA3AF;line-height:1.7;">Spend via Meta Marketing API · Leads &amp; sources via GoHighLevel.<br>Aquoz leads counted from Facebook-sourced CRM opportunities only.</div>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

/* ── Resend ───────────────────────────────────────────────────────────────── */
async function sendEmail(to, subject, html) {
  const from = process.env.REPORT_FROM || 'Sailax Ads <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.error || `Resend HTTP ${r.status}`);
  return j;
}

/* ── handler ──────────────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  // When CRON_SECRET is set, only Vercel Cron (which sends the bearer) may run
  // this. Leave it unset to test by visiting the URL.
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not configured in Vercel.' });
  if (!process.env.META_TOKEN) return res.status(500).json({ error: 'META_TOKEN not configured in Vercel.' });
  const recipients = (process.env.REPORT_RECIPIENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) {
    return res.status(500).json({ error: 'REPORT_RECIPIENTS not configured (comma-separated emails).' });
  }

  try {
    const reports = await Promise.all(ACCOUNTS.map(buildAccount));
    const yesterday = reports[0].yesterday;
    const dateLabel = fmtLongDate(yesterday, ACCOUNTS[0].locale);
    const short = new Date(yesterday + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const subjBits = reports.map((r) => `${r.a.name} ${money(r.spendY, r.a)}/${r.leadsY}L`).join(' · ');
    const subject = `Sailax Ads · ${short} · ${subjBits}`;
    const html = buildEmail(reports, dateLabel);
    const result = await sendEmail(recipients, subject, html);
    return res.status(200).json({ sent: true, id: result.id || null, to: recipients, subject });
  } catch (e) {
    return res.status(500).json({ error: `Report failed: ${e.message}` });
  }
}
