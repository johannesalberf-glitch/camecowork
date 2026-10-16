# Cameco Careers Inc. — Credential Verification Portal

A single-page, zero-build-step verification web app for a Toronto staffing agency.
Candidates are registered in the admin portal, receive a unique **6-digit code**, and anyone
holding that code can render the candidate's **Digital ID Card** immediately — on any device,
inside Telegram / WhatsApp / Instagram in-app browsers, Safari, Chrome or Firefox.

Data lives in **Supabase** (Postgres). Nothing important is stored in `localStorage`,
so nothing is lost when webviews clear storage. Shared links like
`https://your-domain.com/?code=482913` auto-fill and verify on load.

---

## 1. File structure

```
├── index.html               # SPA shell: verify view, admin view, ID card, modals
├── css/app.css              # webview fixes (--vh), OTP input, card, barcode, print
├── js/
│   ├── config.js            # ← put YOUR Supabase URL/anon key + agency branding here
│   ├── utils.js             # DOM/format/clipboard/retry/viewport/deep-link helpers
│   ├── db.js                # data layer: Supabase RPC backend + demo backend
│   ├── idcard.js            # ID card renderer + PNG export (html2canvas)
│   ├── verify.js            # public verification flow (OTP, deep links, errors)
│   ├── admin.js             # passkey gate, candidate CRUD, realtime, settings
│   └── app.js               # bootstrap, routing, banners
├── supabase/schema.sql      # tables + RLS + all server functions (run once)
├── qa/mobile-preview.html   # dev-only phone-frame harness, never linked from the app
├── netlify.toml             # /admin rewrite + security headers (Netlify)
├── vercel.json              # /admin rewrite + security headers (Vercel)
└── _redirects               # /admin rewrite (Netlify / Cloudflare Pages)
```

Open `qa/mobile-preview.html?w=320&h=800&src=/index.html` to render the app inside a
320 px phone frame with a live overflow report (widths 320/360/390/412 are one click apart).

## 2. Deploy — step by step

### Step 1 · Database (Supabase) — ~5 minutes

1. Create a free project at <https://supabase.com> (pick the region closest to your
   candidates/employers).
2. Open **SQL Editor → New query**, paste the entire `supabase/schema.sql`, click **Run**.
   Re-running is always safe and doubles as the upgrade path — it adds any missing columns
   (e.g. `work_name`, `work_type`, `sex`, `phone`) without touching existing data. This
   creates the tables, locks them down with RLS and installs all server functions.
3. **Project Settings → API** → copy the **Project URL** plus **either** the legacy
   **anon public key** (`eyJ…`) **or** the newer `sb_publishable_…` key — both work, and
   the publishable key survives JWT-secret rotation. Only a public key may ever go into
   `js/config.js`; **never** the `service_role` JWT or an `sb_secret_…` key — those
   bypass every database guard and belong only inside the Supabase dashboard.

### Step 2 · Configure — ~2 minutes

Edit `js/config.js`:

- `SUPABASE_URL`, `SUPABASE_ANON_KEY` → the two values from Step 1.
- `AGENCY` (name, address, phone, email, registration number) → printed on the ID card
  and the footer; Cameco branding is already filled in.

After deploying, the site must open with **no red banner**. A banner means the keys did
not arrive (wrong file, typo, or the host is still serving an old cached copy).

### Step 3 · Host the static site — pick ONE

There is **no build step**: upload/connect the folder as-is, publish directory = project
root. `index.html` is the entry point.

**Netlify — easiest, `/admin` works out of the box**

- *Fastest (no account needed to try):* open <https://app.netlify.com/drop> and drag the
  whole project folder onto the page. You get an instant HTTPS URL like
  `https://random-name.netlify.app`. Then **Claim site** to keep it.
- *Recommended (auto-deploy on every change):* push the folder to a GitHub repository →
  Netlify → **Add new site → Import an existing project** → pick the repo →
  Build command: *(leave empty)* → Publish directory: `/` → **Deploy**.
- *Custom domain:* Site configuration → **Domain management → Add a domain** (e.g.
  `camecocareers.ca`) → add the DNS records it shows at your registrar → HTTPS certificate
  is issued automatically. `netlify.toml` (included) already adds the `/admin` rewrite and
  security headers.

**Vercel**

- <https://vercel.com> → **Add New → Project** → import the repo → Framework preset:
  **Other**, Build command: *(none)*, Output directory: root → **Deploy**.
  `vercel.json` (included) provides the `/admin` rewrite + headers.
- Custom domain: Project → **Settings → Domains**.

**Cloudflare Pages**

- <https://dash.cloudflare.com> → **Workers & Pages → Create → Pages** → connect a Git
  repo (or **Direct Upload** with the folder) → build command: none, output: root → save.
  The included `_redirects` file handles `/admin`. Custom domain: project → **Custom domains**.

**GitHub Pages / any static host / cPanel shared hosting**

- Everything works (the app is plain files), but there is **no server rewrite**, so open
  the staff portal as `https://your-site/?admin=1` — or just tap the logo five times —
  instead of `/admin`. Enable the host's free HTTPS certificate (GitHub Pages and cPanel
  both offer one).

### Step 4 · First-run checklist — ~5 minutes

1. Open the public URL → the verify page appears with **no red banner**. Type a wrong
   code → "No matching credential" — that proves the database answers.
2. Open the staff portal (`/admin`, or `?admin=1`) → unlock with passkey `admin2026` →
   **Portal settings → Update passkey** *immediately*.
3. Register a test candidate → tap **Copy verification link** → open the link in a
   private window **and** on a phone → the card appears → **Save image** works.
4. Delete the test candidate, register the first real one, then share either the link or
   the 6-digit code.
5. Share links look trustworthy on a custom domain; HTTPS is required for the clipboard
   and share features.

**Local preview (optional):** `python3 -m http.server 8137` in the project folder, then
open <http://localhost:8137>. Without real Supabase keys, local previews silently fall
back to an in-memory dataset so the UI can be reviewed (sample codes `482913`, `619204`,
`377915`). On a real domain the fallback is disabled automatically — a missing
configuration shows an error banner instead of ever presenting sample data.

## 3. Using it

**Public verification** — `https://your-domain.com/` or a link with the code pre-attached:

| Link shape | Behaviour |
|---|---|
| `https://domain.com/?code=482913` | fills and verifies automatically |
| `https://domain.com/?otp=482913` | same |
| `https://domain.com/#code=482913` | same (hash variants supported) |
| Telegram Mini-App start params | `tgWebAppStartParam` / `startapp` values are parsed |

Verification states: `active` (green badge), `expired` (grey badge, dates in the past),
`not_found` (revoked codes included — they stop working instantly), `rate_limited`
(25 failed attempts per device / 10 minutes), plus clear offline/timeout errors with Retry.

**Staff portal** — three ways in, all gated by the master passkey:
`https://domain.com/admin` (rewrite configs included) · `?admin=1` · five quick taps on the maple-leaf logo.

**Admin features:** candidate registration (name, passport, **sex**, **phone**, job title,
**work name** and **work type** for the ID card, photo URL *or* upload, status), unique
6-digit code generator, searchable registry with stats, one-click **Copy verification
link** and native **Share**, edit, optimistic delete with rollback, passkey rotation,
live sync across devices (Supabase broadcast channel, 45 s polling fallback, refresh on
tab focus).

**Photo handling:** uploaded photos are down-scaled in the browser and embedded as a
data URI — the card then exports as PNG without any CORS/taint problems. Remote URLs work
too; use **Embed from URL** to convert them. If a host blocks embedding, the URL is used
directly and the export automatically falls back to a generated avatar if the canvas
would be tainted.

## 4. Security model

- `candidates`, `app_secrets`, `audit_log`, `verify_attempts` have **RLS enabled with no
  policies** — the anon key cannot read or dump anything directly, so passport numbers and
  the full registry are not publicly listable.
- The public `verify_candidate_otp()` function returns **only the card fields, only for an
  exact code match**, logs attempts (SHA-256 of the code, never the raw value) and rate-limits
  per device.
- All admin operations go through `admin_*` server functions. The passkey is stored as a
  **bcrypt hash** (`pgcrypto`), every call re-verifies it, failures are counted with a
  15-minute lockout and slowed by a deliberate delay. The passkey is never stored in the
  database in clear text and never bundled into the frontend.
- Frontend session convenience: "keep me signed in" stores the passkey in `sessionStorage`
  only (wrapped in try/catch — the portal still works when storage is blocked).
- **Key hygiene:** this project only ever needs a public key. If a `service_role` JWT or an
  `sb_secret_…` key is ever exposed (chat, screenshot, commit, email), rotate it
  immediately — Dashboard → Settings → API → rotate the JWT secret / revoke the secret
  key. The app keeps working afterwards because it uses the publishable key.

**Hardening ideas for larger deployments:** add Supabase Auth (email OTP / MFA) for staff and
switch the admin RPCs to JWT checks; move verification behind an Edge Function with IP-based
rate limiting; enable Point-in-Time recovery. The current model is deliberately
"simple passkey, server-side enforced", which fits the requirement while keeping the
database locked down.

**Privacy:** passport numbers are personal information. Collect them with consent, handle
them per PIPEDA and Ontario privacy law, and prune `verify_attempts`/`audit_log` periodically
(cron examples are at the bottom of `schema.sql`).

## 5. Customization (`js/config.js`)

- `AGENCY.*` — name, address, phone, email, registration number, signer name/title;
  every `data-agency` element in `index.html` is filled automatically.
- `CARD.DEFAULT_VALIDITY_YEARS` — default expiry applied to new candidates.
- `CARD.SHOW_LEGAL_DISCLAIMER` — the "not a Government of Canada document" line on the card
  footer. Keep it if the card could be mistaken for a government document.
- `AUTO_VERIFY_ON_LINK`, `OTP_AUTOSUBMIT_MS`, `REQUEST_TIMEOUT_MS`, `REALTIME.POLL_MS`, `DEBUG`.
- `DEMO_MODE` — `'auto'` (default: silent in-memory fallback on local previews only),
  `true` to force the fallback anywhere, `false` to force the cloud backend.
  Set `false` if you use a **custom Supabase domain** (the auto-detector
  only recognises `*.supabase.co` / `*.supabase.in` URLs).

**Cache busting:** when you edit `js/*` or `css/*`, bump the `?v=YYYYMMDD` parameter on the
local `<script>`/`<link>` tags in `index.html` so browsers fetch fresh files.

## 6. Cross-browser / webview notes

**Supported browsers** — the app deliberately sticks to features supported since ~2020 so
that office desktops and in-app webviews behave the same (no build step, no ES modules,
plain classic `<script>` tags — every webview can parse them):

| Browser / webview | Status |
|---|---|
| Chrome & Edge 87+ (Windows / macOS / Android) | full support |
| Safari 14+ / iOS & iPadOS 14+ | full support (Save Image uses the share sheet → *Save to Photos*) |
| Firefox 90+ (desktop & Android) | full support (Share quietly falls back to Copy link) |
| Samsung Internet 14+ | full support |
| Telegram / WhatsApp / Instagram / Facebook in-app browsers | full support — viewport, clipboard and export all have fallbacks for these |
| Internet Explorer / Android < 7 | not supported |

Built-in compatibility measures:

- Height uses `100dvh` where supported plus a live `--vh` variable maintained from
  `visualViewport`/`resize` events — fixes the classic Telegram sticky-viewport bug.
- OTP input uses `inputmode="numeric"` + `pattern="[0-9]*"` + `autocomplete="one-time-code"`
  for the right keypad on every platform; digits are sanitised on input and paste.
- Clipboard uses `navigator.clipboard` with an `execCommand` fallback for older webviews.
- Image export tries the **Web Share API** first (share sheet → Save Image), then
  `<a download>`, then opening the PNG in a new tab with a long-press hint (iOS Safari).
- Dates are formatted without `Intl`, and date strings are parsed with an explicit
  `T00:00:00` suffix — identical output on every engine, no Safari date quirks.
- Form fields are forced to 16px on small screens so iOS Safari does not zoom on focus.
- `supabase-js` is initialised with `persistSession: false` — no cookies, no storage, nothing
  for Safari ITP or webview sandboxes to block.
- Built for phone widths first: verified with the included `qa/mobile-preview.html` harness
  at 320 / 360 / 390 / 412 px with zero horizontal overflow on every screen.
- If the Tailwind or supabase-js CDN is unreachable, the app shows a clear banner instead of
  failing silently; layout still renders from `css/app.css`.

One practical tip: after changing any `js/` or `css/` file, bump the `?v=` suffix on the
`<script>` / `<link>` tags in `index.html` (currently `?v=20261016e`). In-app webviews and
company proxies cache static files very aggressively; the version suffix makes phones pick
up the new build immediately.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| Red banner "Backend not configured" | Edit `js/config.js` with real Supabase keys (or set `DEMO_MODE: true` for a UI-only preview). |
| "The database is not fully configured" | Re-run `supabase/schema.sql`; check the SQL editor output. |
| Verification fails with `function digest(text, unknown) does not exist` (or `crypt`/`gen_salt`) | The database was created from an older copy of `schema.sql` whose functions pinned `search_path` to `public`, but Supabase installs pgcrypto in the `extensions` schema. Re-run the current `schema.sql` — re-running is safe and replaces the functions. |
| Verification always returns "No matching credential" | Code is wrong/revoked, or the row's `status` is `revoked`. |
| "Too many attempts" | Device hit the throttle (25 failed / 10 min). Wait, or clear it: `delete from verify_attempts;`. |
| Admin can't log in | Default passkey is `admin2026` until changed. 20 failures / 15 min triggers lockout; reset with `delete from audit_log where action='admin_auth';`. |
| Real-time badge shows "Auto-refresh" | Broadcast channel unavailable (rare) — polling fallback keeps the table fresh every 45 s. |
| Downloaded image missing the photo | The photo host blocks CORS — use **Embed from URL** or **Upload image** in the form. |
| `/admin` 404s on GitHub Pages | Use `?admin=1` there, or host on Netlify/Vercel/Cloudflare (configs included). |

## 8. Legal

This portal verifies credentials **issued by the agency operating it**. It is not affiliated
with, and must not be presented as, the Government of Canada or IRCC. Work authorization in
Canada is determined by IRCC — keep the card's disclaimer line enabled unless your counsel
advises otherwise, and never use this system to create documents that imply government
issuance.
