# Analytics Agent Rules

## Scope
Applies to event naming, instrumentation, QA, and reporting for conversion tracking.

## Event Taxonomy
Track at minimum:
- `cta_clicked`
- `form_started`
- `form_step_completed`
- `form_submitted`
- `form_submit_failed`
- `call_clicked`
- `faq_opened`

## Event Property Standards
- Include `page`, `section`, `cta_text`, and `variant` where relevant.
- Include UTM parameters when available.
- Keep property names lowercase_snake_case.

## Data Quality Rules
- Validate events in browser dev tools before release.
- Prevent duplicate firing from double clicks or rerenders.
- Keep naming stable; introduce version suffixes only when schema changes.

## Reporting Cadence
- Weekly summary: sessions, form starts, form submits, submit rate, call-click rate.
- Flag significant week-over-week changes and likely causes.
- Recommend one next experiment based on bottleneck stage.
