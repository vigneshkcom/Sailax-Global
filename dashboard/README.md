# Sailax — Meta Ads Dashboard

A password-gated dashboard showing **ad spend and leads per day** for the two
Sailax ad accounts, with **GoHighLevel** as the CRM lead source. Built on the
same Vercel serverless-proxy pattern as the Goldsure portal, with one
improvement: the **Meta token never reaches the browser** — both Meta and GHL
are proxied server-side.

## Pages & endpoints

| Path | What it is |
|---|---|
| `/dashboard` | The dashboard UI (`dashboard/index.html`) |
| `/api/dashboard/auth` | Password check (`DASHBOARD_PASSWORD`) |
| `/api/dashboard/config` | Reports which integrations are live (no secrets) |
| `/api/dashboard/meta` | Server-side Meta Marketing API proxy → spend + leads/day |
| `/api/dashboard/ghl` | Server-side GoHighLevel proxy |

## Accounts shown

| Region | Account | Currency |
|---|---|---|
| Sailax UK | `act_1220120669692442` | GBP |
| Sailax AU | `act_749874504045597` | AUD |

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
| `GHL_API_KEY` | for GHL | GoHighLevel **Private Integration** token (`pit-…`). Stays server-side. |
| `GHL_LOCATION_ID` | for GHL | GHL Location / sub-account ID (not secret). |

Meta-only works the moment `META_TOKEN` + `DASHBOARD_PASSWORD` are set. GHL
lights up once `GHL_API_KEY` + `GHL_LOCATION_ID` are added.

## How "Leads" is sourced

- **Spend** is always from Meta (authoritative, per account, in account currency).
- **Leads** per account default to **Meta-reported** leads (from the ad account's
  lead actions). This is correct per account and works immediately.
- When GHL is connected, the **CRM Leads** strip shows total new opportunities/day
  for the location.
- To make each account's headline Leads number come from the **CRM** instead of
  Meta, set `ghlPipeline` for that account in the `ACCOUNTS` array to a substring
  of its GHL pipeline name (e.g. `ghlPipeline:'uk'`). Until then it stays on Meta
  so nothing is double-counted across regions.

> If UK and AU live in **separate GHL locations**, we'll extend `config.js` to
> hold one location ID per account — tell me if that's the case.

## Notes

- Meta Graph API version is set once via `META_API_VERSION` in `api/dashboard/meta.js`.
- No build step and no `package.json` — Vercel runs the `/api` files as
  serverless functions directly (same as the Goldsure repo).
