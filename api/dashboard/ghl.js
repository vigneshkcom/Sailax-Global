// api/dashboard/ghl.js
// Server-side proxy for the GoHighLevel API using a Private Integration (pit-) token.
// Requests go FROM the Vercel server → GHL, so the key never reaches the browser
// and there are no CORS issues.
//
// Vercel Environment Variable:
//   GHL_API_KEY = your GoHighLevel Private Integration token (pit-xxxx...)
//
// Usage from the browser:
//   /api/dashboard/ghl?path=/opportunities/search?location_id=XXXX&limit=100

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ghlKey = process.env.GHL_API_KEY || '';
  if (!ghlKey) {
    return res.status(500).json({ error: 'GHL_API_KEY not configured in Vercel Environment Variables.' });
  }

  const { path } = req.query;
  if (!path) {
    return res.status(400).json({ error: 'Missing required `path` query parameter.' });
  }

  // Private Integration tokens use services.leadconnectorhq.com with Version 2021-07-28.
  const targetUrl = `https://services.leadconnectorhq.com${path}`;

  try {
    const ghlResp = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${ghlKey}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    const text = await ghlResp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(500).json({
        error: `GHL returned non-JSON response (HTTP ${ghlResp.status})`,
        raw: text.slice(0, 500),
      });
    }

    if (!ghlResp.ok) {
      return res.status(ghlResp.status).json({
        error: data.message || data.msg || data.error || `GHL HTTP ${ghlResp.status}`,
        raw: data,
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: `GHL proxy fetch failed: ${err.message}` });
  }
}
