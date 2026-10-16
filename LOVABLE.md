# Recreate / Clone this project — Lovable prompt & guide

**Project:** Cameco Careers Inc. — Credential Verification Portal
A zero-build, static web app (HTML + vanilla JS + Tailwind) backed by Supabase.
Live site: `https://johannesalberf-glitch.github.io/camecowork/`
Admin: `https://johannesalberf-glitch.github.io/camecowork/?admin=1` (passkey `admin2026` until you change it)
Repo: `https://github.com/johannesalberf-glitch/camecowork`

---

## A. Clone the existing project (fastest — everything already works)

```bash
git clone https://github.com/johannesalberf-glitch/camecowork.git
cd camecowork
python3 -m http.server 8080     # → http://localhost:8080  (admin: ?admin=1)
```

- Opening `index.html` directly also works — it uses demo data when the backend can't load.
- Backend SQL (tables + functions): `supabase/schema.sql` — re-run it in the Supabase SQL editor any time; re-running is safe.
- The only file you edit to move to another Supabase project: `js/config.js`.

---

## B. Recreate in Lovable + deploy free

1. Go to `lovable.dev` → create a **free** account → **New project**.
2. Connect the existing Supabase project (important — do NOT let Lovable create a new database):
   - Use the **Supabase** integration in Lovable (bottom-left panel) → connect **my existing project** under the account that owns `pogghetoiofixfflxcvd`, **or**
   - Manually add the two values as env vars: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (values are inside the prompt below).
3. Paste the **prompt in section C** as the first message and send it. Let Lovable build.
4. Fix little things with short follow-up messages ("the card download button doesn't work on iPhone — fix it").
5. Click **Publish** (top right) → your app goes live at `https://<your-project>.lovable.app` — free plan can publish to this link. Custom domains / private are paid features.

Notes:
- The Lovable app talks to the **same database** as your GitHub Pages site — same candidates, same codes.
- **Never** paste the `service_role` JWT or an `sb_secret_…` key into Lovable (or anywhere public). Only the publishable key, which is already in the prompt.
- Lovable builds React + Vite + Tailwind apps — that is fine; the backend contract stays identical.

---

## C. The copy-paste Lovable prompt

```text
Build a mobile-first web app: "Cameco Careers Inc. — Credential Verification Portal".

A Toronto staffing agency gives every registered candidate a digital ID card with a unique
6-digit verification code. Employers, partners and candidates can verify a candidate by
entering the code and viewing the ID card. A passkey-protected admin area lets staff register,
edit, revoke and delete candidates.

════════ BACKEND — READ CAREFULLY ════════
My Supabase backend ALREADY EXISTS with all tables and functions. Do NOT create, alter or drop
anything, and never query tables directly (row level security blocks all direct access).
ALL data access happens through supabase.rpc(...) calls — exactly these:

Supabase URL:  https://pogghetoiofixfflxcvd.supabase.co
Public key:    sb_publishable_AlMzpheVXfQv_nm_uePBVA_lV-fDbdZ
Use supabase-js v2. Store as VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY; if the env system is
unavailable, put them directly in the client config file (this key is public information and
safe to hardcode).

1) verify_candidate_otp(p_otp text, p_device_id text) — public, no login.
   p_device_id: generate a random id once per browser and keep it in localStorage.
   Returns ONE of:
   • { status:"ok", candidate:{ name, passport, role, work_name, work_type, sex, phone,
       photo_url, employee_id, issue_date, expiry_date, expired:boolean, status,
       verified_at } }
   • { status:"not_found" }     — wrong code
   • { status:"rate_limited" }  — more than 25 wrong tries per device per 10 minutes
   • { status:"invalid" }       — not exactly 6 digits

2) admin_check(p_passkey) → { ok:true, using_default_passkey:boolean }
   Wrong passkey → error message contains "INVALID_PASSKEY".
   Too many failures → "RATE_LIMITED" (20 failures / 15 minutes).

3) admin_list_candidates(p_passkey) → array of candidate rows, newest first.
   Row fields: id, employee_id, name, passport, role, work_name, work_type, sex, phone, otp,
   photo_url, issue_date, expiry_date, status ("active"|"revoked"), created_at, updated_at

4) admin_save_candidate(p_passkey, p_id, p_name, p_passport, p_role, p_otp, p_photo_url,
   p_issue_date, p_expiry_date, p_status, p_work_name, p_work_type, p_sex, p_phone)
   → { ok:true, candidate:{...} }
   • p_id = null → create. The server auto-generates employee_id ("CCO-<year>-<seq>") and
     defaults: issue date = today, expiry = +1 year, status "active".
   • Edit → pass the candidate id. IMPORTANT: a null parameter keeps the old value;
     an empty string clears it.
   • Errors: "DUPLICATE_OTP" (code already used) | "VALIDATION" (bad values) | "NOT_FOUND".

5) admin_delete_candidate(p_passkey, p_id) → { ok:true }

6) admin_generate_otp(p_passkey) → { ok:true, otp:"123456" }   ← the "Generate" button

7) admin_change_passkey(p_passkey, p_new_passkey) → ok. New passkey minimum 8 characters.

8) health() → { ok:true, version:"schema-1" } — call once on app load; if it errors show a slim
   red banner at the top: "Backend not reachable — check your connection."

════════ SCREENS ════════

A) "/" — public verify page (default route, no login)
   Hero: small badge "International talent acquisition"; H1 "Verify a candidate credential
   in seconds."; paragraph: "Cameco Careers Inc. is a Toronto-based staffing and placement
   agency. Every registered candidate receives a signed digital ID card with a unique 6-digit
   verification code so employers, partners and candidates can confirm authenticity at any
   time." Three ✓ bullets: "Codes are issued directly to registered candidates — never sold
   or transferred." / "Links shared through Telegram, WhatsApp or email auto-fill the code
   for you." / "Revoked or expired credentials are flagged instantly on verification."
   Trust strip: "2012 · Established", "Toronto · Head office", "EN · FR · Bilingual support".
   Verification card: title "Verify a 6-digit code", subtitle "Enter the code from the
   candidate's digital ID card or open their verification link directly." ONE big input:
   digits only, maxlength 6, inputmode numeric, autocomplete="one-time-code", placeholder
   "——————", font ≥16px. Auto-submits ~350 ms after the 6th digit and on Enter; also a
   "Verify" button. Hint: "Six digits, numbers only. Auto-verifies when complete."
   Deep links: on load, if the URL has ?code= or ?otp= → prefill and auto-verify.
   On success → replace the form with the ID card (below).
   Messages: not_found → "We couldn't find a credential with that code. Check the digits and
   try again." / rate_limited → "Too many attempts. Please wait 10 minutes and try again." /
   invalid → "Enter the 6-digit code." / network → "Connection problem — check your internet
   and try again."

B) ID card component (if a candidate successfully verifies)
   Passport-style vertical card: white, rounded-2xl, thin border, soft shadow.
   • Navy header band: "Cameco Careers Inc." + a small red maple-leaf mark + "CANDIDATE
     CREDENTIAL"
   • Photo from photo_url (object-cover, rounded) or an initials avatar
   • Candidate name, bold; status chip: VALID (green) / EXPIRED (red, when expired:true) /
     REVOKED (gray, when status:"revoked")
   • Details grid, 2 columns on mobile, small uppercase labels + values; show "—" when empty:
     Employee ID (mono), Passport no. (mono), Role, Work name, Work type, Sex, Phone,
     Issued, Expires
   • Footer: "Verified <date time>", signature block "M. Tremblay — Director of Placement",
     tiny legal line: "Issued by Cameco Careers Inc. Not a Government of Canada document."
   • Buttons: "Download image" (render the card to PNG with html-to-image, filename
     "<name>-credential.png"); "Share" (navigator.share when available, otherwise copy the
     verification link — try/catch everywhere, webviews sometimes block clipboard);
     "Verify another code" (reset to the form).
   • Format dates as "Oct 16, 2026" with a tiny custom formatter (no Intl locale reliance).

C) "/admin" — staff portal (passkey protected)
   Gate: password input + "Keep me signed in" checkbox (sessionStorage, wrapped in try/catch);
   "Open portal" button → admin_check. Wrong → "Incorrect passkey."
   When using_default_passkey is true, show a persistent amber banner: "The default passkey
   'admin2026' is still active — change it in Settings before sharing this portal."
   Dashboard: header "Candidate registry"; stat chips Total / Active / Expired; search box
   (filters on name, passport, role, employee_id, code, work_name, phone — case-insensitive);
   buttons "Register candidate", "Settings", "Sign out".
   List: desktop → table (Candidate [name + passport], Employee ID, Role / Work, Code [mono +
   copy button], Status [chips], Expires, Edit / Delete buttons). Mobile → cards with the same
   info and full-width buttons. Empty state: "No candidates yet — register the first one."
   Register/Edit modal (full-screen sheet on mobile): Full name*, Passport* (auto-uppercase,
   format A12345678), Role*, Work name, Work type (select: Permanent Full-Time, Fixed-Term
   Full-Time, Part-Time, Contract, Seasonal, TFWP Work Permit), Sex (select: Male, Female,
   Other, X, Prefer not to say), Phone (tel), Issue date & Expiry date (defaults today /
   +1 year), Photo (URL input + optional file picker that downscales client-side to ≤400 KB
   and stores the result as a data URL in photo_url), Code (6 digits, mono) with a "Generate"
   button → admin_generate_otp and a copy button, Status (active / revoked).
   Save → admin_save_candidate with ALL fields. Errors: DUPLICATE_OTP → "That code is already
   used — generate a new one." / VALIDATION → "Check the highlighted fields." Success → toast.
   Delete: confirm dialog "Delete <name>? This cannot be undone." → admin_delete_candidate.
   Settings: current passkey + new passkey (min 8) + confirm → admin_change_passkey; success
   toast; show a green "custom passkey active" chip when using_default_passkey is false.
   Freshness: reload the list after every change; also poll admin_list_candidates every 45 s
   while the dashboard is visible.

════════ DESIGN ════════
Professional, official-but-modern (trust / government-adjacent feel). Colors: deep navy primary
(reference #1e3a8a family; call it "cameco"), red accent #C8102E used sparingly (the maple
leaf, small marks), emerald success / amber warning / red danger, slate neutrals, white cards.
Rounded-2xl/3xl, thin slate borders, soft shadows, 11px uppercase tracking-widest labels,
monospace + tabular-nums for codes and IDs. System font stack only (no web fonts).
Tailwind + shadcn/ui is fine. Include a tiny inline SVG red maple leaf next to the wordmark.

════════ MOBILE + WEBVIEW RULES (hard requirements) ════════
• Zero horizontal scrolling from 320 px width up — check 320/360/390/412. Give grid/text
  containers min-width:0; break long emails/URLs.
• Inputs ≥16px font (prevents iOS auto-zoom). Tap targets ≥44px.
• Must work inside Telegram / WhatsApp / Instagram in-app browsers: no crypto.randomUUID
  (use a random string fallback), clipboard writes in try/catch with a textarea+execCommand
  fallback, share falls back to copy, no service worker needed.
• All network calls ~15 s timeout with a friendly error toast.

════════ ACCEPTANCE CHECKLIST ════════
1. Admin registers a candidate with every field; the card shows all of them; "—" when empty.
2. Candidate verifies with their 6-digit code on a phone → complete card.
3. Opening a ?otp= link auto-verifies.
4. Expired candidate shows the EXPIRED chip; revoked cannot verify.
5. Wrong code → friendly message; 26 wrong tries → rate-limited message.
6. Admin: default-passkey banner shows; changing the passkey in Settings clears it; it persists.
7. Edit / delete / search work; copy-code button copies; the list refreshes by itself.
8. At 320 px wide there is no horizontal scroll on any screen.
```

---

## D. Backend reference (already installed in the Supabase project)

Tables: `candidates`, `app_secrets`, `verify_attempts`, `audit_log` (+ sequence `candidate_seq`).
RLS is **enabled with zero policies** — direct REST access returns nothing; everything goes through RPCs.

| RPC | Purpose |
| --- | --- |
| `verify_candidate_otp(p_otp, p_device_id)` | Public code check → candidate card data (rate limited per device) |
| `admin_check(p_passkey)` | Login probe + detects default passkey |
| `admin_list_candidates(p_passkey)` | All candidates, newest first |
| `admin_save_candidate(…14 params…)` | Create (p_id null) or update (null keeps, '' clears) |
| `admin_delete_candidate(p_passkey, p_id)` | Delete |
| `admin_generate_otp(p_passkey)` | New unique 6-digit code |
| `admin_change_passkey(p_passkey, p_new_passkey)` | Rotate passkey (min 8) |
| `health()` | Connection probe |

Security model: passkey stored as a bcrypt hash (`pgcrypto`, `extensions` schema), wrong
attempts counted with a 15-minute lockout; OTPs stored hashed for attempts log
(SHA-256), never plaintext; functions are `security definer` with
`search_path = public, extensions, pg_temp`.

---

## E. Starting a fresh Supabase project instead?

1. Create the project, then in the SQL editor run the full contents of
   `supabase/schema.sql` from the repo
   (raw: `https://raw.githubusercontent.com/johannesalberf-glitch/camecowork/main/supabase/schema.sql`).
2. Copy the **Project URL** + **anon / `sb_publishable_…`** key into `js/config.js` (static version)
   or into the Lovable env vars.
3. Log into the admin portal and change the default passkey `admin2026` immediately.
4. Re-running `schema.sql` later is always safe (idempotent).
