-- ============================================================================
-- Cameco Careers Inc. — Verification Portal
-- Supabase schema, Row Level Security and server-side RPC functions.
--
-- HOW TO RUN
--   1. Open your Supabase project → SQL Editor → New query.
--   2. Paste this entire file and click "Run". It is idempotent: re-running
--      it will not wipe existing candidates.
--   3. Copy Project URL + anon public key into js/config.js.
--   4. Sign in to the portal and change the default passkey immediately.
--
-- SECURITY MODEL (why there are no public table policies)
--   The `candidates` table stores passport numbers (personal information).
--   Instead of a public SELECT policy — which would let anyone with the anon
--   key dump every passport — all access goes through SECURITY DEFINER
--   functions:
--     • verify_candidate_otp(otp, device_id)  → returns ONLY the fields the
--       ID card needs, and only when the 6-digit code matches. Rate limited
--       per device. This satisfies "public read for OTP verification".
--     • admin_* (passkey guarded, bcrypt-verified, lockout-protected) →
--       controlled writes, listing, OTP generation and passkey rotation.
--   RLS is enabled with zero policies, so direct REST access returns nothing.
-- ============================================================================

-- pgcrypto provides digest() and crypt()/gen_salt(). Supabase pre-installs it
-- in the "extensions" schema; on a vanilla Postgres this installs it into
-- public. Every function below runs with search_path = public, extensions,
-- pg_temp so both layouts resolve identically.
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. TABLES
-- ----------------------------------------------------------------------------

create table if not exists public.candidates (
  id           uuid primary key default gen_random_uuid(),
  employee_id  text unique,
  name         text not null,
  passport     text not null,
  role         text not null,
  work_name    text,                                   -- position/assignment shown on the ID card
  work_type    text,                                   -- e.g. Permanent Full-Time, Seasonal, TFWP
  sex          text,                                   -- Male / Female / Other / Prefer not to say
  phone        text,                                   -- contact number shown on the card
  otp          text not null unique,
  photo_url    text,                                   -- https URL or data URI
  issue_date   date not null default current_date,
  expiry_date  date not null default (current_date + interval '1 year')::date,
  status       text not null default 'active',         -- active | revoked
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint candidates_name_len     check (char_length(name) between 2 and 120),
  constraint candidates_role_len     check (char_length(role) between 2 and 160),
  constraint candidates_passport_fmt check (passport ~ '^[A-Z0-9][A-Z0-9 -]{3,19}$'),
  constraint candidates_otp_fmt      check (otp ~ '^[0-9]{6}$'),
  constraint candidates_status_chk   check (status in ('active', 'revoked')),
  constraint candidates_dates_chk    check (expiry_date >= issue_date)
);

create index if not exists candidates_otp_idx     on public.candidates (otp);
create index if not exists candidates_created_idx on public.candidates (created_at desc);

-- Upgrade path for installs created before work_name / work_type existed.
-- Re-running this whole file is safe: existing rows are untouched.
alter table public.candidates add column if not exists work_name text;
alter table public.candidates add column if not exists work_type text;
alter table public.candidates add column if not exists sex text;
alter table public.candidates add column if not exists phone text;

-- Admin passkey hash + any future secrets. Never exposed to anon.
create table if not exists public.app_secrets (
  key   text primary key,
  value text not null
);

-- Audit trail: admin auth, mutations, passkey changes.
create table if not exists public.audit_log (
  id         bigserial primary key,
  action     text not null,
  detail     jsonb,
  ok         boolean not null default true,
  created_at timestamptz not null default now()
);

-- Public verification attempts (rate limiting + abuse forensics).
-- Stores a SHA-256 of the attempted code, never the raw value.
create table if not exists public.verify_attempts (
  id         bigserial primary key,
  device_id  text,
  otp_hash   text,
  ok         boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists verify_attempts_dev_idx on public.verify_attempts (device_id, created_at desc);

-- Human-readable employee id sequence (CCO-2026-01003 …).
create sequence if not exists public.candidate_seq start 1001;

-- Default master passkey: admin2026  → CHANGE IT from the portal settings.
insert into public.app_secrets (key, value)
values ('admin_passkey_hash', crypt('admin2026', gen_salt('bf', 10)))
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- 2. ROW LEVEL SECURITY — locked down; access happens via RPC only
-- ----------------------------------------------------------------------------

alter table public.candidates      enable row level security;
alter table public.app_secrets     enable row level security;
alter table public.audit_log       enable row level security;
alter table public.verify_attempts enable row level security;

-- No policies are created on purpose: deny all direct access.
revoke all on public.candidates      from anon, authenticated;
revoke all on public.app_secrets     from anon, authenticated;
revoke all on public.audit_log       from anon, authenticated;
revoke all on public.verify_attempts from anon, authenticated;
revoke all on sequence public.candidate_seq from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. INTERNAL HELPERS (not callable by clients)
-- ----------------------------------------------------------------------------

-- bcrypt passkey check with failure lockout (20 failures / 15 minutes).
create or replace function public._assert_admin(p_passkey text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_ok   boolean;
  v_fail integer;
begin
  select count(*) into v_fail
    from public.audit_log
   where action = 'admin_auth'
     and ok = false
     and created_at > now() - interval '15 minutes';

  if v_fail >= 20 then
    raise exception 'RATE_LIMITED'
      using hint = 'Too many failed passkey attempts. Try again in a few minutes.';
  end if;

  select (value = crypt(p_passkey, value)) into v_ok
    from public.app_secrets
   where key = 'admin_passkey_hash';

  v_ok := coalesce(v_ok, false);
  insert into public.audit_log (action, ok) values ('admin_auth', v_ok);

  if not v_ok then
    perform pg_sleep(0.4);   -- slows scripted guessing
    raise exception 'INVALID_PASSKEY' using hint = 'The master passkey is incorrect.';
  end if;
  return true;
end;
$$;

-- Unique random 6-digit code.
create or replace function public._new_otp()
returns text
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v text;
  i integer := 0;
begin
  loop
    i := i + 1;
    v := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from public.candidates where otp = v);
    exit when i >= 200;
  end loop;
  return v;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. PUBLIC RPC — health probe (used by the frontend diagnostics banner)
-- ----------------------------------------------------------------------------

create or replace function public.health()
returns jsonb
language sql
security definer
set search_path = public, extensions, pg_temp
as $$ select jsonb_build_object('ok', true, 'version', 'schema-1'); $$;

-- ----------------------------------------------------------------------------
-- 5. PUBLIC RPC — OTP verification
--    Returns minimal fields for the ID card; never the full row.
-- ----------------------------------------------------------------------------

create or replace function public.verify_candidate_otp(p_otp text, p_device_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_otp  text := regexp_replace(coalesce(p_otp, ''), '[^0-9]', '', 'g');
  v_dev  text := left(coalesce(nullif(trim(coalesce(p_device_id, '')), ''), 'anon'), 80);
  v_row  public.candidates%rowtype;
  v_fail integer;
begin
  if char_length(v_otp) <> 6 then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- Per-device throttle: 25 failed attempts / 10 minutes.
  select count(*) into v_fail
    from public.verify_attempts
   where device_id = v_dev
     and ok = false
     and created_at > now() - interval '10 minutes';

  if v_fail >= 25 then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  select * into v_row
    from public.candidates
   where otp = v_otp
     and status <> 'revoked'
   limit 1;

  if v_row is null then
    insert into public.verify_attempts (device_id, otp_hash, ok)
    values (v_dev, encode(digest(v_otp, 'sha256'), 'hex'), false);
    perform pg_sleep(0.25);
    return jsonb_build_object('status', 'not_found');
  end if;

  insert into public.verify_attempts (device_id, otp_hash, ok)
  values (v_dev, encode(digest(v_otp, 'sha256'), 'hex'), true);

  return jsonb_build_object(
    'status', 'ok',
    'candidate', jsonb_build_object(
      'name',        v_row.name,
      'passport',    v_row.passport,
      'role',        v_row.role,
      'work_name',   v_row.work_name,
      'work_type',   v_row.work_type,
      'sex',         v_row.sex,
      'phone',       v_row.phone,
      'photo_url',   v_row.photo_url,
      'employee_id', v_row.employee_id,
      'issue_date',  v_row.issue_date,
      'expiry_date', v_row.expiry_date,
      'expired',     (v_row.expiry_date < current_date),
      'status',      v_row.status,
      'verified_at', now()
    )
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. ADMIN RPCs — every call is passkey-guarded
-- ----------------------------------------------------------------------------

-- 6.1 Login probe. Also tells the UI if the default passkey is still in use.
create or replace function public.admin_check(p_passkey text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_default boolean;
begin
  perform public._assert_admin(p_passkey);
  select (value = crypt('admin2026', value)) into v_default
    from public.app_secrets
   where key = 'admin_passkey_hash';
  return jsonb_build_object('ok', true, 'using_default_passkey', coalesce(v_default, false));
end;
$$;

-- 6.2 List all candidates (newest first).
create or replace function public.admin_list_candidates(p_passkey text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform public._assert_admin(p_passkey);
  return coalesce(
    (select jsonb_agg(to_jsonb(c) order by c.created_at desc)
       from public.candidates c),
    '[]'::jsonb
  );
end;
$$;

-- 6.3 Create or update a candidate. NULL p_id → insert.
-- Older signatures are dropped first so PostgREST never sees two overloads
-- after an upgrade.
drop function if exists public.admin_save_candidate(text, uuid, text, text, text, text, text, date, date, text);
drop function if exists public.admin_save_candidate(text, uuid, text, text, text, text, text, date, date, text, text, text);

create or replace function public.admin_save_candidate(
  p_passkey     text,
  p_id          uuid    default null,
  p_name        text    default null,
  p_passport    text    default null,
  p_role        text    default null,
  p_otp         text    default null,
  p_photo_url   text    default null,
  p_issue_date  date    default null,
  p_expiry_date date    default null,
  p_status      text    default 'active',
  p_work_name   text    default null,
  p_work_type   text    default null,
  p_sex         text    default null,
  p_phone       text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_id  uuid;
  v_row public.candidates%rowtype;
begin
  perform public._assert_admin(p_passkey);

  if p_id is null then
    insert into public.candidates
      (name, passport, role, work_name, work_type, sex, phone, otp, photo_url, issue_date, expiry_date, status, employee_id)
    values (
      trim(p_name),
      upper(trim(p_passport)),
      trim(p_role),
      nullif(trim(coalesce(p_work_name, '')), ''),
      nullif(trim(coalesce(p_work_type, '')), ''),
      nullif(trim(coalesce(p_sex, '')), ''),
      nullif(trim(coalesce(p_phone, '')), ''),
      coalesce(nullif(regexp_replace(coalesce(p_otp, ''), '[^0-9]', '', 'g'), ''), public._new_otp()),
      nullif(trim(coalesce(p_photo_url, '')), ''),
      coalesce(p_issue_date, current_date),
      coalesce(p_expiry_date, (current_date + interval '1 year')::date),
      coalesce(p_status, 'active'),
      'CCO-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.candidate_seq')::text, 5, '0')
    )
    returning id into v_id;
  else
    update public.candidates set
      name        = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
      passport    = coalesce(nullif(upper(trim(coalesce(p_passport, ''))), ''), passport),
      role        = coalesce(nullif(trim(coalesce(p_role, '')), ''), role),
      work_name   = case when p_work_name is null then work_name else nullif(trim(p_work_name), '') end,
      work_type   = case when p_work_type is null then work_type else nullif(trim(p_work_type), '') end,
      sex         = case when p_sex is null then sex else nullif(trim(p_sex), '') end,
      phone       = case when p_phone is null then phone else nullif(trim(p_phone), '') end,
      otp         = coalesce(nullif(regexp_replace(coalesce(p_otp, ''), '[^0-9]', '', 'g'), ''), otp),
      photo_url   = nullif(trim(coalesce(p_photo_url, '')), ''),
      issue_date  = coalesce(p_issue_date, issue_date),
      expiry_date = coalesce(p_expiry_date, expiry_date),
      status      = coalesce(nullif(p_status, ''), status),
      updated_at  = now()
    where id = p_id
    returning id into v_id;

    if v_id is null then
      raise exception 'NOT_FOUND' using hint = 'That candidate no longer exists.';
    end if;
  end if;

  select * into v_row from public.candidates where id = v_id;

  insert into public.audit_log (action, ok, detail)
  values (case when p_id is null then 'candidate_create' else 'candidate_update' end, true,
          jsonb_build_object('id', v_id, 'employee_id', v_row.employee_id));

  return jsonb_build_object('ok', true, 'candidate', to_jsonb(v_row));

exception
  when unique_violation then
    raise exception 'DUPLICATE_OTP'
      using hint = 'That 6-digit code is already assigned to another candidate.';
  when check_violation then
    raise exception 'VALIDATION'
      using hint = 'One or more fields are invalid (name, passport format, code format or dates).';
end;
$$;

-- 6.4 Delete a candidate.
create or replace function public.admin_delete_candidate(p_passkey text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform public._assert_admin(p_passkey);

  delete from public.candidates where id = p_id;
  if not found then
    raise exception 'NOT_FOUND' using hint = 'That candidate no longer exists.';
  end if;

  insert into public.audit_log (action, ok, detail)
  values ('candidate_delete', true, jsonb_build_object('id', p_id));

  return jsonb_build_object('ok', true);
end;
$$;

-- 6.5 Generate a guaranteed-unique 6-digit code.
create or replace function public.admin_generate_otp(p_passkey text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform public._assert_admin(p_passkey);
  return jsonb_build_object('ok', true, 'otp', public._new_otp());
end;
$$;

-- 6.6 Rotate the master passkey (min 8 characters).
create or replace function public.admin_change_passkey(p_passkey text, p_new_passkey text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  perform public._assert_admin(p_passkey);

  if char_length(coalesce(p_new_passkey, '')) < 8 then
    raise exception 'WEAK_PASSKEY' using hint = 'The new passkey must be at least 8 characters.';
  end if;

  update public.app_secrets
     set value = crypt(p_new_passkey, gen_salt('bf', 10))
   where key = 'admin_passkey_hash';

  insert into public.audit_log (action, ok) values ('passkey_change', true);

  return jsonb_build_object('ok', true);
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. GRANTS — expose only the intended surface to anon/authenticated
-- ----------------------------------------------------------------------------

-- Internal helpers stay private.
revoke all on function public._assert_admin(text) from public, anon, authenticated;
revoke all on function public._new_otp()           from public, anon, authenticated;

-- Public verification + health.
revoke all on function public.verify_candidate_otp(text, text) from public;
revoke all on function public.health()                         from public;
grant execute on function public.verify_candidate_otp(text, text) to anon, authenticated;
grant execute on function public.health()                         to anon, authenticated;

-- Admin surface (guarded by the bcrypt passkey check inside each function).
revoke all on function public.admin_check(text)                 from public;
revoke all on function public.admin_list_candidates(text)       from public;
revoke all on function public.admin_save_candidate(text, uuid, text, text, text, text, text, date, date, text, text, text, text, text) from public;
revoke all on function public.admin_delete_candidate(text, uuid) from public;
revoke all on function public.admin_generate_otp(text)          from public;
revoke all on function public.admin_change_passkey(text, text)  from public;

grant execute on function public.admin_check(text)                 to anon, authenticated;
grant execute on function public.admin_list_candidates(text)       to anon, authenticated;
grant execute on function public.admin_save_candidate(text, uuid, text, text, text, text, text, date, date, text, text, text, text, text) to anon, authenticated;
grant execute on function public.admin_delete_candidate(text, uuid) to anon, authenticated;
grant execute on function public.admin_generate_otp(text)          to anon, authenticated;
grant execute on function public.admin_change_passkey(text, text)  to anon, authenticated;

-- Make PostgREST pick up the new functions immediately.
notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- 8. OPTIONAL: retention / cleanup (run periodically via pg_cron if desired)
-- ----------------------------------------------------------------------------
-- delete from public.verify_attempts where created_at < now() - interval '90 days';
-- delete from public.audit_log       where created_at < now() - interval '180 days';
