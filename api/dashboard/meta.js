// api/dashboard/meta.js
// Server-side Meta Marketing API proxy.
//
// Returns per-day account totals AND per-campaign totals for the date range.
// The Meta access token stays on the server — never exposed to the browser.
//
// Vercel Environment Variable:
//   META_TOKEN = a long-lived Meta access token with `ads_read` on both accounts
//
// Query params:
//   account  = numeric ad account id, no "act_" prefix (e.g. 1220120669692442)
//   since    = YYYY-MM-DD
//   until    = YYYY-MM-DD
//   campaign = single campaign id, OR comma-separated ids for multi-campaign accounts

const META_API_VERSION = 'v21.0';

const ONSITE_LEAD_TYPES = ['onsite_conversion.lead_grouped', 'leadgen_grouped', 'lead'];
const PIXEL_LEAD_TYPE = 'offsite_conversion.fb_pixel_lead';

function extractLeads(actions) {
  if (!Array.isArray(actions)) return 0;
  const val = (type) => {
    const a = actions.find((x) => x.action_type === type);
    return a ? parseInt(a.value, 10) || 0 : 0;
  };
  const onsite = ONSITE_LEAD_TYPES.reduce((acc, t) => acc || val(t), 0);
  const pixel = val(PIXEL_LEAD_TYPE);
  return onsite + pixel;
}

async function fetchAllPages(startUrl) {
  let rows = [];
  let url = startUrl;
  let guard = 0;
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

// When multiple campaigns are queried together, the API returns one row per
// campaign per day. Aggregate them into a single row per date.
function aggregateDayRows(rows) {
  const byDate = {};
  for (const r of rows) {
    const d = r.date_start;
    if (!byDate[d]) byDate[d] = { date_start: d, spend: 0, impressions: 0, clicks: 0, actionMap: {} };
    byDate[d].spend += parseFloat(r.spend || 0);
    byDate[d].impressions += parseInt(r.impressions || 0, 10);
    byDate[d].clicks += parseInt(r.clicks || 0, 10);
    for (const act of (r.actions || [])) {
      byDate[d].actionMap[act.action_type] = (byDate[d].actionMap[act.action_type] || 0) + (parseInt(act.value, 10) || 0);
    }
  }
  return Object.values(byDate)
    .sort((a, b) => a.date_start.localeCompare(b.date_start))
    .map((d) => ({
      date_start: d.date_start,
      spend: String(d.spend),
      impressions: String(d.impressions),
      clicks: String(d.clicks),
      actions: Object.entries(d.actionMap).map(([action_type, value]) => ({ action_type, value: String(value) })),
    }));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.META_TOKEN || '';
  if (!token) {
    return res.status(500).json({ error: 'META_TOKEN not configured in Vercel Environment Variables.' });
  }

  const { account, since, until, campaign } = req.query;
  if (!account || !since || !until) {
    return res.status(400).json({ error: 'Missing required query params: account, since, until.' });
  }
  const acct = String(account).replace(/^act_/, '');

  // Support comma-separated campaign IDs (e.g. for Aircon which has multiple campaigns)
  const camps = campaign
    ? String(campaign).split(',').map((s) => s.replace(/[^0-9]/g, '')).filter(Boolean)
    : [];
  const singleCamp = camps.length === 1 ? camps[0] : '';
  const multiCamp = camps.length > 1;

  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  const tok = encodeURIComponent(token);
  const acctBase = `https://graph.facebook.com/${META_API_VERSION}/act_${acct}/insights`;

  // Single campaign: query the campaign node directly (scoped, efficient).
  // Multiple campaigns: query the account node filtered by the campaign IDs.
  // No campaign: query at account level for full-account reports.
  const singleBase = singleCamp
    ? `https://graph.facebook.com/${META_API_VERSION}/${singleCamp}/insights`
    : null;
  const dayLevel = singleCamp ? 'campaign' : 'account';
  const campFilter = multiCamp
    ? `&filtering=${encodeURIComponent(JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: camps }]))}`
    : '';

  try {
    const [dayRowsRaw, campRows, activeRows] = await Promise.all([
      // Daily breakdown — aggregate across campaigns when multiple are requested
      fetchAllPages(
        (multiCamp ? acctBase : (singleBase || acctBase)) +
        `?level=${multiCamp ? 'campaign' : dayLevel}&fields=spend,impressions,clicks,actions` +
        `&time_increment=1&time_range=${timeRange}&limit=500&access_token=${tok}${campFilter}`
      ),
      // Per-campaign totals for the Campaigns table
      fetchAllPages(
        (multiCamp ? acctBase : (singleBase || acctBase)) +
        `?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks,actions` +
        `&time_range=${timeRange}&limit=500&access_token=${tok}${campFilter}`
      ),
      // Active-campaign list — used to surface $0-spend campaigns still running.
      // Skipped for single/multi campaign modes (we know exactly which campaigns we want).
      (async () => {
        if (singleCamp || multiCamp) return [];
        const statuses = encodeURIComponent(JSON.stringify(['ACTIVE', 'WITH_ISSUES', 'PENDING_REVIEW', 'IN_PROCESS']));
        const url = `https://graph.facebook.com/${META_API_VERSION}/act_${acct}/campaigns` +
          `?fields=id,name,effective_status&effective_status=${statuses}&limit=500&access_token=${tok}`;
        try { return await fetchAllPages(url); } catch { return []; }
      })(),
    ]);

    // For multi-campaign queries, one row per campaign per day → aggregate by date
    const dayRows = multiCamp ? aggregateDayRows(dayRowsRaw) : dayRowsRaw;

    const days = dayRows.map((d) => ({
      date: d.date_start,
      spend: parseFloat(d.spend || 0),
      impressions: parseInt(d.impressions || 0, 10),
      clicks: parseInt(d.clicks || 0, 10),
      leads: extractLeads(d.actions),
    }));

    const totals = days.reduce(
      (t, d) => ({
        spend: t.spend + d.spend,
        impressions: t.impressions + d.impressions,
        clicks: t.clicks + d.clicks,
        leads: t.leads + d.leads,
      }),
      { spend: 0, impressions: 0, clicks: 0, leads: 0 }
    );

    // Merge: every active campaign (with its in-range spend, or 0) plus any
    // non-active campaign that did spend in range. Sorted by spend.
    const ACTIVE_RE = /ACTIVE|WITH_ISSUES|PENDING_REVIEW|IN_PROCESS/i;
    const insightsById = {};
    campRows.forEach((c) => { insightsById[c.campaign_id] = c; });
    const mk = (id, name, status, ins) => ({
      id,
      name,
      status,
      spend: ins ? parseFloat(ins.spend || 0) : 0,
      impressions: ins ? parseInt(ins.impressions || 0, 10) : 0,
      clicks: ins ? parseInt(ins.clicks || 0, 10) : 0,
      leads: ins ? extractLeads(ins.actions) : 0,
    });
    const campaigns = [];
    const seen = new Set();

    // For multi-campaign: surface each tracked campaign even with $0 spend
    if (multiCamp) {
      for (const id of camps) {
        const ins = insightsById[id];
        campaigns.push(mk(id, ins ? ins.campaign_name : id, ins ? 'ACTIVE' : 'ACTIVE', ins));
        seen.add(id);
      }
    } else {
      activeRows
        .filter((c) => ACTIVE_RE.test(c.effective_status || ''))
        .forEach((c) => { campaigns.push(mk(c.id, c.name, c.effective_status || 'ACTIVE', insightsById[c.id])); seen.add(c.id); });
    }
    campRows.forEach((c) => {
      if (seen.has(c.campaign_id)) return;
      campaigns.push(mk(c.campaign_id, c.campaign_name, 'INACTIVE', c));
    });
    campaigns.sort((a, b) => b.spend - a.spend);

    return res.status(200).json({ account: acct, since, until, days, totals, campaigns });
  } catch (err) {
    return res.status(500).json({ error: `Meta proxy failed: ${err.message}` });
  }
}
