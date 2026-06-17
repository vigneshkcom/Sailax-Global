# Sailax — Meta Ads Dashboard

A password-gated dashboard showing **ad spend and leads per day** for the two
Sailax ad accounts, with **GoHighLevel** as the CRM lead source. Built on the
same Vercel serverless-proxy pattern as the Goldsure portal, with one
improvement: the **Meta token never reaches the browser** — both Meta and GHL
are proxied server-side.

UK and AU are separate Meta ad accounts **and** separate GHL locations, so each
account's leads come straight from its own CRM location (no pipeline mapping).

## Pages & endpoints

| Path | What it is |
|---|---|
| `/dashboard` | The dashboard UI (`dashboard/index.html`) |
| `/api/dashboard/auth` | Password check (`DASHBOARD_PASSWORD`) |
| `/api/dashboard/config` | Reports which integrations are live (no secrets) |
| `/api/dashboard/meta` | Server-side Meta Marketing API proxy → spend + leads/day |
| `/api/dashboard/ghl` | Server-side GoHighLevel proxy (per account) |

## Accounts shown

| Region | Meta account | Currency | GHL |
|---|---|---|---|
| Sailax UK | `act_1220120669692442` | GBP | own location |
| Sailax AU | `act_749874504045597` | AUD | own location |

Configured at the top of `dashboard/index.html` in the `ACCOUNTS` array.

## Deploy (Vercel)

1. Import this GitHub repo into Vercel (New Project → import `Sailax-Global`).
   The existing static marketing pages keep working; Vercel just adds the
   `/api/*` functions.
2. Add the Environment Variables below (Project → Settings → Environment Variables).
3. Deploy, then open `https://<your-vercel-domain>/dashboard`.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DASHBOARD_PASSWORD` | ✅ | Password for the gate. |
| `META_TOKEN` | ✅ | Long-lived Meta token with `ads_read` on **both** accounts. Stays server-side. |
| `GHL_API_KEY_UK` | for UK leads | UK location's **Private Integration** token (`pit-…`). Server-side only. |
| `GHL_LOCATION_ID_UK` | for UK leads | UK GHL location ID (not secret). |
| `GHL_API_KEY_AU` | for AU leads | AU location's Private Integration token (`pit-…`). Server-side only. |
| `GHL_LOCATION_ID_AU` | for AU leads | AU GHL location ID (not secret). |

Meta-only works the moment `META_TOKEN` + `DASHBOARD_PASSWORD` are set. Each
account's CRM leads light up independently once that account's two GHL vars
are added.

## How "Leads" is sourced

- **Spend** is always from Meta (authoritative, per account, in account currency).
- **Leads** per account use **GHL** (new opportunities created per day in that
  account's location, bucketed in the account's timezone) when its GHL vars are
  set — shown with a green `GHL` tag and "CRM-confirmed".
- Until then, Leads fall back to **Meta-reported** leads (blue `Meta` tag) so the
  dashboard is useful immediately.

## Notes

- Meta Graph API version is set once via `META_API_VERSION` in `api/dashboard/meta.js`.
- "Leads" from Meta = sum of onsite (lead-form) + offsite (pixel) lead actions.
- No build step and no `package.json` — Vercel runs the `/api` files as
  serverless functions directly (same as the Goldsure repo).
