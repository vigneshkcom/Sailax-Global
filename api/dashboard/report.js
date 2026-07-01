// api/dashboard/report.js
// Scheduled DAILY ads report, emailed via Resend.
//
// Triggered by a GitHub Actions schedule (.github/workflows/daily-report.yml),
// which calls this endpoint with the CRON_SECRET bearer. For each account it
// pulls TODAY's spend + leads so far (same sources as the live dashboard) plus
// a rolling 7-day context line, then emails an HTML summary. Every secret stays
// server-side — nothing is ever returned to the browser.
//
// Vercel Environment Variables:
//   RESEND_API_KEY     Resend API key (re_...).                         REQUIRED
//   REPORT_RECIPIENTS  Comma-separated To: addresses.                   REQUIRED
//   REPORT_FROM        From: header. Default "Sailax Ads <onboarding@resend.dev>".
//                      (The onboarding@resend.dev test sender only delivers to
//                       your own Resend account email until you verify a domain.)
//   CRON_SECRET        If set, the endpoint only runs for requests carrying
//                      "Authorization: Bearer <CRON_SECRET>" — the GitHub Actions
//                      workflow adds this header. Leave UNSET to test by URL.
//   DASHBOARD_URL      Optional "View live dashboard" link in the email.
//   META_TOKEN, GHL_API_KEY_UK/AU, GHL_LOCATION_ID_UK/AU  (as used elsewhere)

const META_API_VERSION = 'v21.0';
const ONSITE_LEAD_TYPES = ['onsite_conversion.lead_grouped', 'leadgen_grouped', 'lead'];
const PIXEL_LEAD_TYPE = 'offsite_conversion.fb_pixel_lead';

// Mirrors the dashboard's ACCOUNTS config. HWS first.
// HWS is a single campaign inside the AU "Sailax Global" account, so it carries
// a campaignId; the others report at account level.
const ACCOUNTS = [
  { key: 'hws',    name: 'HWS',       sub: 'Australia',       accountId: '749874504045597',  campaignId: '120252378091870672',  currency: 'AUD', locale: 'en-AU', tz: 'Australia/Sydney', accent: '#16A34A', ghlLeadSource: 'Instant Forms', ghlLeadLabel: 'Instant Forms', ghlLeadTags: ['instant forms'], ghlLeadMatch: 'any', ghlPipeline: 'HWS' },
  { key: 'aircon', name: 'Aircon',    sub: 'Australia (VIC)', accountId: '749874504045597',  campaignId: '120252890311900672', currency: 'AUD', locale: 'en-AU', tz: 'Australia/Sydney', accent: '#0EA5E9', ghlAccount: 'hws', ghlLeadSource: 'Instant Forms', ghlLeadLabel: 'Instant Forms', ghlLeadTags: ['instant forms'], ghlLeadMatch: 'any', ghlPipeline: 'Aircon' },
  { key: 'au',     name: 'Aquoz',     sub: 'Australia',       accountId: '1616113923003676', currency: 'AUD', locale: 'en-AU', tz: 'Australia/Sydney', accent: '#FF6B35', ghlLeadSource: ['facebook', 'landing page'], ghlLeadLabel: 'FB + Landing Page', ghlLeadTags: ['landing page'], ghlLeadMatch: 'any', ghlPipeline: null },
  { key: 'uk',     name: 'Sailax UK', sub: 'United Kingdom',  accountId: '1220120669692442', currency: 'GBP', locale: 'en-GB', tz: 'Europe/London',    accent: '#3B82F6', ghlLeadSource: null, ghlLeadLabel: null, ghlLeadTags: null, ghlLeadMatch: 'any', ghlPipeline: null },
];

// Extra guard for stray bulk CRM imports; the positive source/tag match is primary.
const EXCLUDE_TAGS = ['bulk'];

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

/* ── Meta: last-7-days daily breakdown ──────────────────────────────────── */
async function fetchMeta(a, token, since, until) {
  const tok = encodeURIComponent(token);
  // HWS runs as a single campaign inside a shared account, so query the campaign
  // node directly; the other accounts report at account level.
  const node = a.campaignId ? a.campaignId : `act_${a.accountId}`;
  const level = a.campaignId ? 'campaign' : 'account';
  const base = `https://graph.facebook.com/${META_API_VERSION}/${node}/insights`;
  const range7 = encodeURIComponent(JSON.stringify({ since, until }));
  const dayRows = await fetchAllPages(
    `${base}?level=${level}&fields=spend,impressions,clicks,actions&time_increment=1&time_range=${range7}&limit=500&access_token=${tok}`
  );
  const days = dayRows.map((d) => ({
    date: d.date_start,
    spend: parseFloat(d.spend || 0),
    impressions: parseInt(d.impressions || 0, 10),
    clicks: parseInt(d.clicks || 0, 10),
    leads: extractLeads(d.actions),
  }));
  return { days };
}

/* ── GHL: pipelines + opportunities ─────────────────────────────────────── */
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
// Tags may sit on the opportunity or its contact, as strings or {name}/{tag} objects.
function oppTags(o) {
  let raw = o.tags || o.contact?.tags || o.contactTags || [];
  if (!Array.isArray(raw)) raw = typeof raw === 'string' ? raw.split(',') : [];
  return raw.map((t) => (typeof t === 'string' ? t : (t && (t.name || t.tag || t.label)) || '')).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}
function excludeBulk(opps) {
  if (!EXCLUDE_TAGS.length) return opps || [];
  return (opps || []).filter((o) => {
    const tags = oppTags(o);
    return !tags.some((t) => EXCLUDE_TAGS.some((x) => t.includes(x)));
  });
}
// A real lead = matches any of the account's lead source(s) and/or required tag(s).
// ghlLeadSource and ghlLeadTags may each be a string or a list, so an account can
// accept several sources (e.g. Aquoz: Facebook + Landing Page).
// match 'any' (default): source OR tag qualifies; 'all': both required.
function leadMatches(o, a) {
  const srcList = (Array.isArray(a.ghlLeadSource) ? a.ghlLeadSource : (a.ghlLeadSource ? [a.ghlLeadSource] : [])).map((s) => String(s).toLowerCase());
  const reqTags = (Array.isArray(a.ghlLeadTags) ? a.ghlLeadTags : (a.ghlLeadTags ? [a.ghlLeadTags] : [])).map((t) => String(t).toLowerCase());
  const useSrc = srcList.length > 0, useTag = reqTags.length > 0;
  if (!useSrc && !useTag) return true;
  const src = (o.source || o.leadSource || o.attributionSource || '').toLowerCase();
  const hasSrc = useSrc && srcList.some((s) => src.includes(s));
  const hasTag = useTag && oppTags(o).some((t) => reqTags.includes(t));
  return a.ghlLeadMatch === 'all' ? ((!useSrc || hasSrc) && (!useTag || hasTag)) : ((useSrc && hasSrc) || (useTag && hasTag));
}
function filterLeads(opps, a) { return (opps || []).filter((o) => leadMatches(o, a)); }
// Resolve a pipeline-name token (e.g. "HWS") to its id(s) so a multi-pipeline
// location (HWS + Aircon) can be narrowed to one. null → keep all pipelines.
function pipelineIdSet(pipelines, token) {
  if (!token) return null;
  const t = token.toLowerCase();
  const ids = (pipelines || []).filter((p) => (p.name || '').toLowerCase().includes(t)).map((p) => p.id);
  return ids.length ? new Set(ids) : null;
}
function filterByPipeline(opps, idSet) {
  if (!idSet) return opps || [];
  return (opps || []).filter((o) => idSet.has(o.pipelineId || o.pipeline_id));
}
const oppDate = (o, tz) => {
  const c = o.createdAt || o.created_at || o.dateAdded;
  return c ? new Date(c).toLocaleDateString('en-CA', { timeZone: tz }) : null;
};
const countOnDay = (opps, tz, day) => (opps || []).filter((o) => oppDate(o, tz) === day).length;
const countInRange = (opps, tz, since, until) =>
  (opps || []).filter((o) => { const d = oppDate(o, tz); return d && d >= since && d <= until; }).length;
async function fetchPipelines(key, locationId) {
  for (const param of ['locationId', 'location_id']) {
    try {
      const j = await ghlGet(key, `/opportunities/pipelines?${param}=${locationId}`);
      if (j && Array.isArray(j.pipelines)) return j.pipelines;
    } catch {}
  }
  return [];
}
function stageBreakdown(opps, pipelines, tz, since, until) {
  const names = {}, order = {};
  (pipelines || []).forEach((pl) =>
    (pl.stages || []).forEach((s, i) => { names[s.id] = s.name; order[s.id] = s.position ?? i; })
  );
  const cnt = {};
  (opps || []).forEach((o) => {
    const d = oppDate(o, tz);
    if (!d || d < since || d > until) return;
    const sid = o.pipelineStageId || o.stageId || 'unknown';
    cnt[sid] = (cnt[sid] || 0) + 1;
  });
  const total = Object.values(cnt).reduce((a, b) => a + b, 0);
  return Object.entries(cnt)
    .sort((a, b) => (order[a[0]] ?? 99) - (order[b[0]] ?? 99))
    .map(([sid, n]) => ({ name: names[sid] || 'Unknown', count: n, pct: total > 0 ? Math.round(n / total * 100) : 0 }));
}
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
  const today = todayIn(a.tz);            // the reporting day (in the account's tz)
  const since7 = addDays(today, -6);      // rolling 7 days, ending today (inclusive)
  const out = { a, day: today, error: null, ghlError: null, leadsSource: 'meta', stages: [], bySource: [] };

  // Meta — today's figures are partial/still settling (spend can lag a couple hours)
  try {
    const meta = await fetchMeta(a, process.env.META_TOKEN, since7, today);
    const dayRow = meta.days.find((d) => d.date === today);
    out.spendDay = dayRow ? dayRow.spend : 0;
    out.clicksDay = dayRow ? dayRow.clicks : 0;
    out.imprDay = dayRow ? dayRow.impressions : 0;
    out.metaLeadsDay = dayRow ? dayRow.leads : 0;
    out.spend7 = meta.days.reduce((s, d) => s + d.spend, 0);
    out.metaLeads7 = meta.days.reduce((s, d) => s + d.leads, 0);
  } catch (e) {
    out.error = 'Meta: ' + e.message;
    out.spendDay = out.clicksDay = out.imprDay = out.metaLeadsDay = out.spend7 = out.metaLeads7 = 0;
  }

  // GHL leads (preferred when configured); fall back to Meta-reported leads
  out.leadsDay = out.metaLeadsDay;
  out.leads7 = out.metaLeads7;
  const ghlAcct = a.ghlAccount || a.key;
  const key = process.env[`GHL_API_KEY_${ghlAcct.toUpperCase()}`];
  const loc = process.env[`GHL_LOCATION_ID_${ghlAcct.toUpperCase()}`];
  if (key && loc) {
    try {
      const [oppsRaw, pipelinesAll] = await Promise.all([fetchAllOpps(key, loc), fetchPipelines(key, loc)]);
      const opps = excludeBulk(oppsRaw);                              // drop bulk CRM imports (tag "Bulk")
      const pipeIds = pipelineIdSet(pipelinesAll, a.ghlPipeline);     // narrow to the account's pipeline (HWS, not Aircon)
      const pipelines = pipeIds ? pipelinesAll.filter((p) => pipeIds.has(p.id)) : pipelinesAll;
      const leadOpps = filterLeads(filterByPipeline(opps, pipeIds), a);
      out.leadsDay = countOnDay(leadOpps, a.tz, today);
      out.leads7 = countInRange(leadOpps, a.tz, since7, today);
      out.bySource = sourcesOnDay(leadOpps, a.tz, today);            // sources of the counted leads only
      out.stages = stageBreakdown(leadOpps, pipelines, a.tz, since7, today); // 7-day window for stages
      out.leadsSource = a.ghlLeadSource ? 'ghl-fb' : 'ghl';
    } catch (e) {
      out.ghlError = 'GHL: ' + e.message;
    }
  }

  out.cplDay = out.leadsDay > 0 ? out.spendDay / out.leadsDay : null;
  out.cpl7 = out.leads7 > 0 ? out.spend7 / out.leads7 : null;
  return out;
}

/* ── email rendering (table-based, inline styles for client compat) ───────── */
const fmtLongDate = (iso, locale) =>
  new Date(iso + 'T12:00:00Z').toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function kpiCell(label, value, sub, color) {
  // bgcolor attribute (not just CSS background) so desktop Outlook fills the tile;
  // border-radius is kept for Gmail/Apple Mail and simply ignored by Outlook.
  return `<td width="50%" valign="top" style="padding:6px;">
    <table width="100%" cellpadding="0" cellspacing="0" role="presentation" bgcolor="#F5F6F8" style="background:#F5F6F8;border-radius:14px;">
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
  // The coloured name "pill" is a filled table cell (bgcolor) rather than a
  // styled <span>, because Outlook won't paint a background on an inline span.
  const header = `<tr><td style="padding:12px 24px 4px;">
      <table cellpadding="0" cellspacing="0" role="presentation" align="left"><tr>
        <td bgcolor="${a.accent}" style="background:${a.accent};border-radius:10px;padding:6px 13px;font-size:13px;font-weight:700;color:#ffffff;">${esc(a.name)}</td>
        <td style="padding-left:10px;font-size:12px;color:#9CA3AF;white-space:nowrap;">${esc(a.sub)} · ${a.currency}</td>
      </tr></table>
    </td></tr>`;

  if (r.error && !r.stages.length && r.leadsSource === 'meta') {
    return `${header}<tr><td style="padding:6px 24px 8px;">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation" bgcolor="#FEF2F2" style="background:#FEF2F2;border-radius:12px;"><tr><td style="padding:12px 14px;font-size:13px;color:#991B1B;">${esc(r.error)}</td></tr></table>
    </td></tr><tr><td style="padding:14px 24px 6px;"><div style="border-bottom:1px solid #E5E7EB;"></div></td></tr>`;
  }

  const leadTag = r.leadsSource === 'ghl-fb' ? `CRM · ${esc(a.ghlLeadLabel || 'Facebook')}` : r.leadsSource === 'ghl' ? 'CRM' : 'Meta-reported';
  const kpis = `<table width="100%" cellpadding="0" cellspacing="0">
    <tr>${kpiCell('Spend · today', money(r.spendDay, a), `7d: ${money(r.spend7, a)}`, a.accent)}${kpiCell('Leads · today', String(r.leadsDay), leadTag, '#111827')}</tr>
    <tr>${kpiCell('Cost / Lead', r.cplDay != null ? money(r.cplDay, a) : '—', r.cpl7 != null ? `7d: ${money(r.cpl7, a)}` : 'no leads', '#111827')}${kpiCell('Clicks · today', r.clicksDay.toLocaleString(), `${r.imprDay.toLocaleString()} impressions`, '#111827')}</tr>
  </table>`;

  let src = '';
  if (r.bySource.length) {
    // Each source is a filled cell in one table row (with thin spacer cells),
    // so they stay side-by-side and keep their background in Outlook too.
    const cells = r.bySource
      .map((s, i) => `${i ? '<td width="6" style="font-size:0;line-height:0;">&nbsp;</td>' : ''}<td bgcolor="#F5F6F8" style="background:#F5F6F8;border-radius:10px;padding:6px 11px;font-size:12px;color:#374151;white-space:nowrap;">${esc(s.src)} · <strong>${s.n}</strong></td>`)
      .join('');
    src = `<div style="font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#9CA3AF;margin:18px 0 8px;">New leads by source · today</div>
      <table cellpadding="0" cellspacing="0" role="presentation"><tr>${cells}</tr></table>`;
  }

  let stages = '';
  if (r.stages.length) {
    const maxCount = Math.max(1, ...r.stages.map((s) => s.count));
    const rows = r.stages.map((s) => {
      const barW = Math.max(2, Math.round(s.count / maxCount * 120)); // max 120px bar
      // Bar = a fixed-width filled cell (bgcolor + width attribute) so Outlook
      // paints it; a plain <div> with a CSS background won't render there.
      const bar = `<table cellpadding="0" cellspacing="0" role="presentation" width="${barW}" style="width:${barW}px;"><tr>
          <td bgcolor="${a.accent}" height="6" style="background:${a.accent};height:6px;border-radius:3px;font-size:0;line-height:0;mso-line-height-rule:exactly;">&nbsp;</td>
        </tr></table>`;
      return `<tr>
        <td style="padding:7px 6px;font-size:13px;color:#111827;border-bottom:1px solid #F3F4F6;width:40%;">${esc(s.name)}</td>
        <td style="padding:7px 6px;border-bottom:1px solid #F3F4F6;">${bar}</td>
        <td align="right" style="padding:7px 6px;font-size:13px;font-weight:700;color:#111827;border-bottom:1px solid #F3F4F6;white-space:nowrap;">${s.count} <span style="font-size:11px;color:#9CA3AF;font-weight:500;">${s.pct}%</span></td>
      </tr>`;
    }).join('');
    stages = `<div style="font-size:12px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#9CA3AF;margin:18px 0 6px;">Pipeline stages · 7 days</div>
      <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
  }

  const ghlNote = r.ghlError
    ? `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" bgcolor="#FFFBEB" style="background:#FFFBEB;border-radius:12px;margin-top:12px;"><tr><td style="padding:10px 14px;font-size:12px;color:#92400E;">${esc(r.ghlError)} — showing Meta-reported leads.</td></tr></table>`
    : '';

  return `${header}
    <tr><td style="padding:8px 18px 0;">${kpis}</td></tr>
    <tr><td style="padding:0 24px;">${src}${stages}${ghlNote}</td></tr>
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
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(dash)}" style="height:46px;v-text-anchor:middle;width:230px;" arcsize="26%" stroke="f" fillcolor="#FF6B35">
          <w:anchorlock/>
          <center style="color:#ffffff;font-family:'Segoe UI',Arial,sans-serif;font-size:14px;font-weight:600;">View live dashboard &rarr;</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-- -->
        <a href="${esc(dash)}" style="display:inline-block;background:#FF6B35;color:#fff;text-decoration:none;font-size:14px;font-weight:600;border-radius:12px;padding:13px 30px;">View live dashboard →</a>
        <!--<![endif]-->
      </td></tr>`
    : '';
  return `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="X-UA-Compatible" content="IE=edge">
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <style type="text/css">body,table,td,div,span,a,strong{font-family:'Segoe UI',Arial,sans-serif !important;}table{border-collapse:collapse !important;}</style>
  <![endif]-->
  </head>
  <body style="margin:0;padding:0;background:#EEF0F3;font-family:'Outfit',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" bgcolor="#EEF0F3" style="background:#EEF0F3;padding:24px 12px;"><tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" role="presentation" bgcolor="#ffffff" style="max-width:600px;width:100%;background:#fff;border-radius:24px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.06);">
      <tr><td bgcolor="#111827" style="background:#111827;padding:24px;">
        <div style="font-size:20px;font-weight:700;color:#fff;">Sail<span style="color:#FF6B35;">ax</span> <span style="font-weight:500;color:#9CA3AF;font-size:15px;">· Daily Ads Report</span></div>
        <div style="font-size:13px;color:#9CA3AF;margin-top:4px;">${esc(dateLabel)} <span style="color:#6B7280;">· figures so far today</span></div>
      </td></tr>
      ${blocks}
      ${dashBtn}
      <tr><td style="background:#F9FAFB;padding:18px 24px;text-align:center;">
        <div style="font-size:11px;color:#9CA3AF;line-height:1.7;">Today's figures are live and update through the day · Meta spend can lag a couple of hours.<br>Spend via Meta Marketing API · Leads &amp; sources via GoHighLevel · HWS counts Instant Form leads, Aquoz counts Facebook + Landing Page — both exclude bulk CRM imports.</div>
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
  // When CRON_SECRET is set, only callers that send the matching bearer (the
  // GitHub Actions schedule) may run this. Leave it unset to test by URL.
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
    const day = reports[0].day;
    const dateLabel = fmtLongDate(day, ACCOUNTS[0].locale);
    const short = new Date(day + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const subjBits = reports.map((r) => `${r.a.name} ${money(r.spendDay, r.a)}/${r.leadsDay}L`).join(' · ');
    const subject = `Sailax Ads · ${short} · ${subjBits}`;
    const html = buildEmail(reports, dateLabel);
    const result = await sendEmail(recipients, subject, html);
    return res.status(200).json({ sent: true, id: result.id || null, to: recipients, subject });
  } catch (e) {
    return res.status(500).json({ error: `Report failed: ${e.message}` });
  }
}
