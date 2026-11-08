-- Family schedule schema for Supabase (PostgreSQL 15+).
-- It lives in the same Supabase project as the budget site and uses the same sign-in,
-- the same households and the same allowed_emails. Its own tables start with sched_.
-- Run in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: it only creates what is missing and replaces the functions. It never
-- changes the budget tables and never deletes data.


-- --------------------------------------------- shared with the budget site
-- In the real project these already exist (created by the budget schema).
-- They are created here only when missing, so this file also works on an empty database.

create table if not exists households (
  id   uuid primary key default gen_random_uuid(),
  name text not null
);

create table if not exists allowed_emails (
  email        text primary key check (email = lower(email)),
  household_id uuid not null references households(id) on delete cascade
);

-- The signed-in user's household. Same lookup as the budget's my_household(),
-- kept under its own name so neither schema can overwrite the other's function.
create or replace function sched_household() returns uuid
language sql stable security definer set search_path = public as $$
  select household_id from allowed_emails
  where email = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;


-- ------------------------------------------------------------------ tables

-- Family members: whose activity it is.
create table if not exists sched_members (
  id           smallint generated always as identity primary key,
  household_id uuid not null references households(id) on delete cascade,
  name         text not null check (name <> ''),
  color        text not null default '#2a78d6' check (color ~ '^#[0-9a-f]{6}$'),
  sort_order   smallint not null default 0,
  archived     boolean not null default false,
  unique (household_id, name)
);
-- A small square photo, as a data URL (the site shrinks it before saving). Null: show the initial.
alter table sched_members add column if not exists photo text
  check (photo is null or (photo ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' and length(photo) <= 200000));

-- Children come first when a notification picks whose picture and colour to show.
-- Added with the push notifications; Πάνος and Νικόλας start as children.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'sched_members' and column_name = 'child') then
    alter table sched_members add column child boolean not null default false;
    update sched_members set child = true where name in ('Πάνος', 'Νικόλας');
  end if;
end $$;

-- What kind of activity: Σχολείο, Δουλειά, Ποδόσφαιρο, Λογοθεραπεία, …
create table if not exists sched_categories (
  id           smallint generated always as identity primary key,
  household_id uuid not null references households(id) on delete cascade,
  name         text not null check (name <> ''),
  color        text not null default '#2a78d6' check (color ~ '^#[0-9a-f]{6}$'),
  sort_order   smallint not null default 0,
  archived     boolean not null default false,
  unique (household_id, name)
);

-- One activity, or a weekly series of them.
--   start_time null          -> all day (it may then span start_date..end_date)
--   repeat_days not null     -> every `repeat_every` weeks on those days (1 = Monday … 7 = Sunday),
--                               from start_date until repeat_until (null = no end)
--   parent_id / parent_date  -> this event replaces one date of a series ("only this one" edits)
create table if not exists sched_events (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  title        text not null check (title <> ''),
  category_id  smallint references sched_categories(id),
  member_ids   smallint[] not null default '{}',
  start_date   date not null,
  end_date     date not null,
  start_time   time,
  end_time     time,
  location     text not null default '',
  notes        text not null default '',
  repeat_days  smallint[],
  repeat_every smallint not null default 1 check (repeat_every between 1 and 8),
  repeat_until date,
  parent_id    uuid references sched_events(id) on delete cascade,
  parent_date  date,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (end_date >= start_date),
  check ((start_time is null) = (end_time is null)),
  check (end_time is null or end_time > start_time),
  check (repeat_days is null or (end_date = start_date and cardinality(repeat_days) > 0
                                 and repeat_days <@ array[1,2,3,4,5,6,7]::smallint[])),
  check (repeat_until is null or repeat_until >= start_date)
);
-- Cancelled: it stays on the calendar, struck through, instead of being deleted.
alter table sched_events add column if not exists cancelled boolean not null default false;
create index if not exists sched_events_range_idx on sched_events (household_id, start_date);
create index if not exists sched_events_parent_idx on sched_events (parent_id);

-- Dates removed from a series (deleted, or replaced by an edited copy).
create table if not exists sched_skips (
  event_id     uuid not null references sched_events(id) on delete cascade,
  household_id uuid not null references households(id) on delete cascade,
  on_date      date not null,
  primary key (event_id, on_date)
);


-- ---------------------------------------------------------------- security

alter table sched_members    enable row level security;
alter table sched_categories enable row level security;
alter table sched_events     enable row level security;
alter table sched_skips      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['sched_members', 'sched_categories', 'sched_events', 'sched_skips'] loop
    execute format('drop policy if exists household_only on %I', t);
    execute format(
      'create policy household_only on %I for all to authenticated
         using (household_id = sched_household()) with check (household_id = sched_household())', t);
  end loop;
end $$;

revoke all on sched_members, sched_categories, sched_events, sched_skips from anon;
grant select, insert, update, delete on sched_members, sched_categories, sched_events, sched_skips to authenticated;
grant usage on all sequences in schema public to authenticated;


-- ----------------------------------------------------------------- helpers

create or replace function sched_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists sched_events_touch on sched_events;
create trigger sched_events_touch before update on sched_events
  for each row execute function sched_touch();

create or replace function _sched_require() returns uuid
language plpgsql stable set search_path = public as $$
declare h uuid := sched_household();
begin
  if h is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  return h;
end $$;

create or replace function _sched_date(p text, label text) returns date
language plpgsql immutable as $$
begin
  if coalesce(p, '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Μη έγκυρη ημερομηνία: %', label; end if;
  return p::date;
end $$;

create or replace function _sched_time(p text) returns time
language plpgsql immutable as $$
begin
  if coalesce(p, '') = '' then return null; end if;
  if p !~ '^\d{1,2}:\d{2}$' then raise exception 'Μη έγκυρη ώρα: %', p; end if;
  return p::time;
end $$;

create or replace function _sched_color(p text) returns text
language plpgsql immutable as $$
begin
  if lower(coalesce(p, '')) !~ '^#[0-9a-f]{6}$' then raise exception 'Μη έγκυρο χρώμα: %', p; end if;
  return lower(p);
end $$;

-- One event as the website sees it.
create or replace function _sched_json(e sched_events) returns json
language sql stable set search_path = public as $$
  select json_build_object(
    'id', e.id, 'title', e.title, 'category', e.category_id, 'members', to_json(e.member_ids),
    'date', to_char(e.start_date, 'YYYY-MM-DD'), 'endDate', to_char(e.end_date, 'YYYY-MM-DD'),
    'start', to_char(e.start_time, 'HH24:MI'), 'end', to_char(e.end_time, 'HH24:MI'),
    'location', e.location, 'notes', e.notes, 'cancelled', e.cancelled,
    'repeatDays', to_json(e.repeat_days), 'repeatEvery', e.repeat_every,
    'repeatUntil', to_char(e.repeat_until, 'YYYY-MM-DD'),
    'parent', e.parent_id, 'parentDate', to_char(e.parent_date, 'YYYY-MM-DD'),
    'skips', coalesce((select json_agg(to_char(s.on_date, 'YYYY-MM-DD') order by s.on_date)
                       from sched_skips s where s.event_id = e.id), '[]'))
$$;

-- Reads an event from the website's JSON and checks it. Raises a readable error when something is off.
create or replace function _sched_values(h uuid, ev jsonb) returns sched_events
language plpgsql stable set search_path = public as $$
declare r sched_events; m smallint;
begin
  r.household_id := h;
  r.title := btrim(coalesce(ev ->> 'title', ''));
  if r.title = '' then raise exception 'Γράψε τίτλο'; end if;
  if coalesce(ev ->> 'category', '') <> '' then
    select id into r.category_id from sched_categories where household_id = h and id = (ev ->> 'category')::smallint;
    if r.category_id is null then raise exception 'Άγνωστη κατηγορία'; end if;
  end if;
  r.member_ids := coalesce((select array_agg(distinct x::smallint order by x::smallint)
                            from jsonb_array_elements_text(coalesce(ev -> 'members', '[]')) x), '{}');
  foreach m in array r.member_ids loop
    if not exists (select 1 from sched_members where household_id = h and id = m) then
      raise exception 'Άγνωστο μέλος';
    end if;
  end loop;
  r.start_date := _sched_date(ev ->> 'date', 'ημερομηνία');
  r.end_date := coalesce(nullif(ev ->> 'endDate', '')::date, r.start_date);
  r.start_time := _sched_time(ev ->> 'start');
  r.end_time := _sched_time(ev ->> 'end');
  if r.start_time is null and r.end_time is not null then raise exception 'Βάλε και ώρα έναρξης'; end if;
  if r.start_time is not null then
    r.end_date := r.start_date;
    if r.end_time is null then r.end_time := least(r.start_time + interval '1 hour', time '23:59'); end if;
    if r.end_time <= r.start_time then raise exception 'Η ώρα λήξης πρέπει να είναι μετά την έναρξη'; end if;
  end if;
  if r.end_date < r.start_date then raise exception 'Η λήξη είναι πριν την έναρξη'; end if;
  r.location := btrim(coalesce(ev ->> 'location', ''));
  r.notes := btrim(coalesce(ev ->> 'notes', ''));
  r.cancelled := coalesce((ev ->> 'cancelled')::boolean, false);
  r.repeat_every := coalesce(nullif(ev ->> 'repeatEvery', '')::smallint, 1);
  if jsonb_typeof(ev -> 'repeatDays') = 'array' and jsonb_array_length(ev -> 'repeatDays') > 0 then
    r.repeat_days := (select array_agg(distinct x::smallint order by x::smallint)
                      from jsonb_array_elements_text(ev -> 'repeatDays') x);
    if not r.repeat_days <@ array[1,2,3,4,5,6,7]::smallint[] then raise exception 'Μη έγκυρη μέρα επανάληψης'; end if;
    r.end_date := r.start_date;
    r.repeat_until := nullif(ev ->> 'repeatUntil', '')::date;
    if r.repeat_until < r.start_date then raise exception 'Το «μέχρι» είναι πριν την έναρξη'; end if;
  end if;
  return r;
end $$;


-- ------------------------------------------------------ push notifications
-- Each phone or computer that turns notifications on is one row in sched_push_subs, with that
-- device's choices. The Edge Function supabase/functions/sched-push runs every minute (pg_cron,
-- see supabase/push-cron.sql), asks sched_push_due() what to send and sends it with Web Push.
-- Only the website functions below and the Edge Function (service_role) reach these tables.

create table if not exists sched_push_subs (
  id             bigint generated always as identity primary key,
  household_id   uuid not null references households(id) on delete cascade,
  user_id        uuid,
  endpoint       text not null unique check (endpoint ~ '^https://'),
  p256dh         text not null,
  auth           text not null,
  remind_minutes smallint check (remind_minutes between 1 and 1440), -- null: no reminders
  member_ids     smallint[] not null default '{}',                     -- empty: everyone
  notify_changes boolean not null default true,
  created_at     timestamptz not null default now()
);

-- Reminders already sent, so each one goes out once.
create table if not exists sched_push_sent (
  sub_id   bigint not null references sched_push_subs(id) on delete cascade,
  event_id uuid not null references sched_events(id) on delete cascade,
  on_date  date not null,
  sent_at  timestamptz not null default now(),
  primary key (sub_id, event_id, on_date)
);

-- What someone added, changed or deleted, waiting to be sent to the others.
create table if not exists sched_push_changes (
  id           bigint generated always as identity primary key,
  household_id uuid not null references households(id) on delete cascade,
  actor        uuid,
  member_ids   smallint[] not null default '{}',
  title        text not null,
  body         text not null,
  on_date      date,
  sent         boolean not null default false,
  created_at   timestamptz not null default now()
);

-- One row: the secret the cron call carries, and the Web Push (VAPID) keys, which the
-- Edge Function creates on its first run.
create table if not exists sched_push_config (
  id            boolean primary key default true check (id),
  cron_secret   text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  vapid_public  text,
  vapid_private jsonb
);
insert into sched_push_config default values on conflict do nothing;
-- The activity's own people (member_ids also holds the people it had before a change).
alter table sched_push_changes add column if not exists who smallint[] not null default '{}';

alter table sched_push_subs    enable row level security;
alter table sched_push_sent    enable row level security;
alter table sched_push_changes enable row level security;
alter table sched_push_config  enable row level security;
revoke all on sched_push_subs, sched_push_sent, sched_push_changes, sched_push_config from anon, authenticated;

-- Member names for a notification title: "Πάνος, Νικόλας".
create or replace function _sched_push_names(h uuid, ids smallint[]) returns text
language sql stable set search_path = public as $$
  select string_agg(name, ', ' order by sort_order, id) from sched_members where household_id = h and id = any(ids)
$$;

-- Whose picture and colour a notification shows: { id, name, color, photo } (photo: true/false), or null for
-- the app's logo. One child on it: that child; two or more: one of them at random. No child: the one
-- person on it, or one of them at random. Nobody, or the whole family: the logo.
create or replace function _sched_push_who(h uuid, ids smallint[]) returns json
language sql volatile set search_path = public as $$
  select case
    when cardinality(ids) = 0 then null
    when not exists (select 1 from sched_members where household_id = h and not archived and not (id = any(ids))) then null
    else (select json_build_object('id', id, 'name', name, 'color', color, 'photo', photo is not null)
          from sched_members where household_id = h and id = any(ids)
          order by child desc, random() limit 1)
  end
$$;

-- "Τρίτη 10 Νοεμβρίου"
create or replace function _sched_push_day(d date) returns text
language sql immutable as $$
  select (array['Δευτέρα','Τρίτη','Τετάρτη','Πέμπτη','Παρασκευή','Σάββατο','Κυριακή'])[extract(isodow from d)::int]
         || ' ' || extract(day from d)::int || ' '
         || (array['Ιανουαρίου','Φεβρουαρίου','Μαρτίου','Απριλίου','Μαΐου','Ιουνίου','Ιουλίου','Αυγούστου',
                   'Σεπτεμβρίου','Οκτωβρίου','Νοεμβρίου','Δεκεμβρίου'])[extract(month from d)::int]
$$;

-- When an event is, for the text of a notification:
--   "Τρίτη 10 Νοεμβρίου · 17:00–18:00 · Γήπεδο"   (one date: d, or the event's own)
--   "Κάθε Τρι, Πεμ · 17:00–18:00"                  (a series)
--   "Από Τρίτη 10 Νοεμβρίου, κάθε Τρι · 17:00–18:00" (a series from d on)
create or replace function _sched_push_when(e sched_events, d date default null, from_d boolean default false) returns text
language plpgsql immutable as $$
declare txt text;
begin
  if e.repeat_days is not null and (d is null or from_d) then
    txt := 'κάθε ' || case when e.repeat_every > 1 then e.repeat_every || ' εβδομάδες: ' else '' end
           || (select string_agg((array['Δευ','Τρι','Τετ','Πεμ','Παρ','Σαβ','Κυρ'])[x], ', ' order by x) from unnest(e.repeat_days) x);
    txt := case when from_d then 'Από ' || _sched_push_day(d) || ', ' || txt else upper(left(txt, 1)) || substr(txt, 2) end;
  elsif d is null and e.end_date > e.start_date then
    txt := _sched_push_day(e.start_date) || ' – ' || _sched_push_day(e.end_date);
  else
    txt := _sched_push_day(coalesce(d, e.start_date));
  end if;
  txt := txt || ' · ' || case when e.start_time is null then 'όλη μέρα'
                              else to_char(e.start_time, 'HH24:MI') || '–' || to_char(e.end_time, 'HH24:MI') end;
  if e.location <> '' then txt := txt || ' · ' || e.location; end if;
  return txt;
end $$;

-- Queues "someone added / changed / deleted this" for the household's other devices.
-- Called by api_sched_add, api_sched_update and api_sched_delete.
create or replace function _sched_push_change(kind text, e sched_events, members smallint[], what text) returns void
language plpgsql security definer set search_path = public as $$
declare h uuid := sched_household();
begin
  if h is null or h <> e.household_id then return; end if;
  insert into sched_push_changes (household_id, actor, member_ids, who, title, body, on_date)
  values (h, auth.uid(), coalesce(members, '{}'), e.member_ids,
          case kind when 'add' then 'Νέο' when 'cancel' then 'Ακυρώθηκε' when 'delete' then 'Διαγραφή' else 'Αλλαγή' end
            || ': ' || e.title || coalesce(' · ' || _sched_push_names(h, e.member_ids), ''),
          what, greatest(e.start_date, (now() at time zone 'Europe/Athens')::date));
end $$;

-- ---- website: this device's notifications

-- The public Web Push key the browser needs to sign up: { key }. Null until the Edge Function has run once.
drop function if exists api_sched_push_key();
create or replace function api_sched_push_key() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('key', case when _sched_require() is not null then (select vapid_public from sched_push_config) end)
$$;

-- This device's choices, or null when it is not signed up (any more).
create or replace function api_sched_push_get(endpoint text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('remindMinutes', s.remind_minutes, 'members', to_json(s.member_ids), 'changes', s.notify_changes)
  from sched_push_subs s where s.endpoint = api_sched_push_get.endpoint and s.household_id = _sched_require()
$$;

-- Signs this device up, or updates it. sub: { endpoint, p256dh, auth, remindMinutes, members, changes }.
-- Choices left out keep their saved value (or the defaults: 30 minutes, everyone, changes on).
create or replace function api_sched_push_save(sub jsonb) returns json
language plpgsql security definer set search_path = public as $$
declare
  h uuid := _sched_require();
  ep text := coalesce(sub ->> 'endpoint', '');
  old sched_push_subs;
  mins smallint;
  mem smallint[];
begin
  if ep !~ '^https://' or coalesce(sub ->> 'p256dh', '') = '' or coalesce(sub ->> 'auth', '') = '' then
    raise exception 'Μη έγκυρη συσκευή για ειδοποιήσεις';
  end if;
  select * into old from sched_push_subs s where s.endpoint = ep and s.household_id = h;
  mins := case when sub ? 'remindMinutes' then nullif(sub ->> 'remindMinutes', '')::smallint
               when old.id is not null then old.remind_minutes else 30 end;
  if mins is not null and (mins < 1 or mins > 1440) then raise exception 'Μη έγκυρος χρόνος υπενθύμισης'; end if;
  mem := case when sub ? 'members' then coalesce((select array_agg(distinct x::smallint order by x::smallint)
                                                  from jsonb_array_elements_text(sub -> 'members') x), '{}')
              else coalesce(old.member_ids, '{}') end;
  if exists (select 1 from unnest(mem) m where not exists (select 1 from sched_members where household_id = h and id = m)) then
    raise exception 'Άγνωστο μέλος';
  end if;
  insert into sched_push_subs as s (household_id, user_id, endpoint, p256dh, auth, remind_minutes, member_ids, notify_changes)
  values (h, auth.uid(), ep, sub ->> 'p256dh', sub ->> 'auth', mins, mem,
          coalesce((sub ->> 'changes')::boolean, old.notify_changes, true))
  on conflict (endpoint) do update set household_id = excluded.household_id, user_id = excluded.user_id,
    p256dh = excluded.p256dh, auth = excluded.auth, remind_minutes = excluded.remind_minutes,
    member_ids = excluded.member_ids, notify_changes = excluded.notify_changes;
  return json_build_object('ok', true);
end $$;

-- Stops notifications on this device.
create or replace function api_sched_push_remove(endpoint text) returns json
language plpgsql security definer set search_path = public as $$
declare h uuid := _sched_require();
begin
  delete from sched_push_subs s where s.endpoint = api_sched_push_remove.endpoint and s.household_id = h;
  return json_build_object('ok', true);
end $$;

-- ---- Edge Function only (service_role)

create or replace function sched_push_config_get() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('cronSecret', cron_secret, 'vapidPublic', vapid_public, 'vapidPrivate', vapid_private)
  from sched_push_config
$$;

-- Saves the keys the Edge Function made on its first run. Never replaces existing ones.
create or replace function sched_push_set_keys(public_key text, private_key jsonb) returns json
language sql security definer set search_path = public as $$
  update sched_push_config set vapid_public = public_key, vapid_private = private_key where vapid_public is null;
  select sched_push_config_get();
$$;

-- Devices the push service says are gone (app uninstalled, notifications turned off).
create or replace function sched_push_gone(endpoints text[]) returns void
language sql security definer set search_path = public as $$
  delete from sched_push_subs where endpoint = any(endpoints);
$$;

-- Everything to send now, marked as sent: [{ endpoint, p256dh, auth, title, body, date, tag, who }].
--   Reminders: a timed activity that starts within the device's remind_minutes (Greek time).
--   Changes: queued by _sched_push_change, to the household's devices of other users.
-- Both skip activities of people the device did not pick; family ones (nobody set) always go.
create or replace function sched_push_due(at_time timestamptz default now()) returns json
language plpgsql security definer set search_path = public as $$
declare
  now_local timestamp := at_time at time zone 'Europe/Athens';
  today date := now_local::date;
  out json;
begin
  delete from sched_push_sent where sent_at < now() - interval '3 days';
  delete from sched_push_changes where sent and created_at < now() - interval '1 day';

  with occ as (
    select e.*, d as on_date, d + e.start_time as starts
    from sched_events e, (values (today), (today + 1)) days(d)
    where e.start_time is not null and not e.cancelled and e.start_date <= d
      and case when e.repeat_days is null then e.start_date = d
               else d <= coalesce(e.repeat_until, 'infinity'::date)
                    and extract(isodow from d)::smallint = any(e.repeat_days)
                    and ((d - (e.start_date - (extract(isodow from e.start_date)::int - 1))) / 7) % e.repeat_every = 0
                    and not exists (select 1 from sched_skips k where k.event_id = e.id and k.on_date = d) end
  ), due as (
    select s.id as sub_id, s.endpoint, s.p256dh, s.auth, o.id as event_id, o.on_date, o.household_id,
           o.title, o.member_ids, o.start_time, o.end_time, o.location,
           ceil(extract(epoch from o.starts - now_local) / 60)::int as mins
    from occ o join sched_push_subs s on s.household_id = o.household_id
    where s.remind_minutes is not null
      and o.starts > now_local and o.starts - make_interval(mins => s.remind_minutes) <= now_local
      and (cardinality(s.member_ids) = 0 or cardinality(o.member_ids) = 0 or s.member_ids && o.member_ids)
      and not exists (select 1 from sched_push_sent x where x.sub_id = s.id and x.event_id = o.id and x.on_date = o.on_date)
  ), mark_sent as (
    insert into sched_push_sent (sub_id, event_id, on_date) select sub_id, event_id, on_date from due on conflict do nothing
  ), news as (
    update sched_push_changes c set sent = true where not c.sent returning c.*
  ), msgs as (
    select endpoint, p256dh, auth,
           title || coalesce(' · ' || _sched_push_names(household_id, member_ids), '') as title,
           case when mins >= 60 and mins % 60 = 0 then 'Σε ' || (mins / 60) || case when mins = 60 then ' ώρα' else ' ώρες' end
                else 'Σε ' || mins || case when mins = 1 then ' λεπτό' else ' λεπτά' end end
             || ' · ' || to_char(start_time, 'HH24:MI') || '–' || to_char(end_time, 'HH24:MI')
             || case when location <> '' then ' · ' || location else '' end as body,
           on_date as date, 'r-' || event_id || '-' || on_date as tag, 0::bigint as ord,
           _sched_push_who(household_id, member_ids) as who
    from due
    union all
    select s.endpoint, s.p256dh, s.auth, n.title, n.body, n.on_date, 'c-' || n.id, n.id,
           _sched_push_who(n.household_id, n.who)
    from news n join sched_push_subs s on s.household_id = n.household_id
    where s.notify_changes and s.user_id is distinct from n.actor
      and (cardinality(s.member_ids) = 0 or cardinality(n.member_ids) = 0 or s.member_ids && n.member_ids)
  )
  select coalesce(json_agg(json_build_object('endpoint', endpoint, 'p256dh', p256dh, 'auth', auth, 'title', title,
                                             'body', body, 'date', to_char(date, 'YYYY-MM-DD'), 'tag', tag, 'who', who)
                       order by ord, title), '[]')
  into out from msgs;
  return out;
end $$;

revoke all on function _sched_push_who(uuid, smallint[]), _sched_push_names(uuid, smallint[]), _sched_push_day(date), _sched_push_when(sched_events, date, boolean),
  _sched_push_change(text, sched_events, smallint[], text), api_sched_push_key(), api_sched_push_get(text),
  api_sched_push_save(jsonb), api_sched_push_remove(text), sched_push_config_get(), sched_push_set_keys(text, jsonb),
  sched_push_gone(text[]), sched_push_due(timestamptz) from public, anon, authenticated;
grant execute on function _sched_push_names(uuid, smallint[]), _sched_push_day(date), _sched_push_when(sched_events, date, boolean),
  _sched_push_change(text, sched_events, smallint[], text), api_sched_push_key(), api_sched_push_get(text),
  api_sched_push_save(jsonb), api_sched_push_remove(text) to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on sched_push_subs, sched_push_sent, sched_push_changes, sched_push_config to service_role;
    grant execute on function sched_push_config_get(), sched_push_set_keys(text, jsonb), sched_push_gone(text[]),
      sched_push_due(timestamptz), _sched_push_names(uuid, smallint[]), _sched_push_who(uuid, smallint[]) to service_role;
  end if;
end $$;


-- ---------------------------------------------------------------- website API

-- Members, categories and every event that can show up between `from` and `to` (dates, inclusive).
-- The website works out the dates of weekly series itself. On a household's first visit it adds
-- a starting set of categories.
create or replace function api_sched_read(from_date text, to_date text) returns json
language plpgsql set search_path = public as $$
declare h uuid := _sched_require(); f date := _sched_date(from_date, 'από'); t date := _sched_date(to_date, 'έως');
begin
  if t < f or t - f > 400 then raise exception 'Μη έγκυρο διάστημα'; end if;
  if not exists (select 1 from sched_categories where household_id = h) then
    insert into sched_categories (household_id, name, color, sort_order) values
      (h, 'Σχολείο', '#2a78d6', 0), (h, 'Δουλειά', '#52514e', 1), (h, 'Ποδόσφαιρο', '#1baf7a', 2),
      (h, 'Λογοθεραπεία', '#6250d6', 3), (h, 'Γιατρός', '#e34948', 4), (h, 'Οικογένεια', '#eda100', 5),
      (h, 'Άλλο', '#898781', 6);
  end if;
  return json_build_object(
    'ok', true,
    'members', coalesce((select json_agg(json_build_object('id', id, 'name', name, 'color', color, 'hidden', archived,
                                                           'photo', photo)
                                         order by sort_order, id)
                         from sched_members where household_id = h), '[]'),
    'categories', coalesce((select json_agg(json_build_object('id', id, 'name', name, 'color', color, 'hidden', archived)
                                            order by sort_order, id)
                            from sched_categories where household_id = h), '[]'),
    'events', coalesce((select json_agg(_sched_json(e) order by e.start_date, e.start_time nulls first)
                        from sched_events e
                        where e.household_id = h and e.start_date <= t
                          and (case when e.repeat_days is null then e.end_date
                                    else coalesce(e.repeat_until, 'infinity'::date) end) >= f), '[]'),
    'titles', coalesce((select json_agg(x order by x ->> 'title')
                        from (select distinct on (lower(title))
                                     json_build_object('title', title, 'category', category_id, 'members', member_ids,
                                                       'start', to_char(start_time, 'HH24:MI'),
                                                       'end', to_char(end_time, 'HH24:MI'), 'location', location)::jsonb x
                              from sched_events where household_id = h
                              order by lower(title), updated_at desc) s), '[]'),
    'updatedAt', now());
end $$;

create or replace function api_sched_add(event jsonb) returns json
language plpgsql set search_path = public as $$
declare h uuid := _sched_require(); r sched_events := _sched_values(h, event);
begin
  r.id := gen_random_uuid(); r.created_by := auth.uid(); r.created_at := now(); r.updated_at := now();
  r.repeat_every := coalesce(r.repeat_every, 1);
  insert into sched_events select r.*;
  perform _sched_push_change('add', r, r.member_ids, _sched_push_when(r));
  return json_build_object('ok', true, 'id', r.id);
end $$;

-- Changes an event. For a weekly series, `scope` says which dates:
--   'all'       the whole series (on_date is ignored)
--   'one'       only on_date: that date leaves the series and becomes its own event
--   'following' on_date and after: the series ends the day before and a new one starts on on_date
create or replace function api_sched_update(id uuid, event jsonb, scope text default 'all', on_date text default null)
returns json language plpgsql set search_path = public as $$
declare
  h uuid := _sched_require();
  old sched_events;
  r sched_events := _sched_values(h, event);
  d date;
  new_id uuid := gen_random_uuid();
begin
  select * into old from sched_events e where e.id = api_sched_update.id and e.household_id = h for update;
  if old.id is null then raise exception 'Η δραστηριότητα δεν βρέθηκε. Κάνε ανανέωση και δοκίμασε ξανά.'; end if;
  if old.repeat_days is null or scope = 'all' then
    update sched_events e set title = r.title, category_id = r.category_id, member_ids = r.member_ids,
           start_date = r.start_date, end_date = r.end_date, start_time = r.start_time, end_time = r.end_time,
           location = r.location, notes = r.notes, cancelled = r.cancelled, repeat_days = r.repeat_days, repeat_every = r.repeat_every,
           repeat_until = r.repeat_until
    where e.id = old.id;
    perform _sched_push_change(case when r.cancelled and not old.cancelled then 'cancel' else 'update' end,
                               r, old.member_ids || r.member_ids, _sched_push_when(r));
    return json_build_object('ok', true, 'id', old.id);
  end if;

  d := _sched_date(on_date, 'ημέρα');
  if scope = 'one' then
    insert into sched_skips values (old.id, h, d) on conflict do nothing;
    r.id := new_id; r.parent_id := old.id; r.parent_date := d;
    r.repeat_days := null; r.repeat_until := null; r.repeat_every := 1;
    r.created_by := auth.uid(); r.created_at := now(); r.updated_at := now();
    insert into sched_events select r.*;
    perform _sched_push_change(case when r.cancelled and not old.cancelled then 'cancel' else 'update' end,
                               r, old.member_ids || r.member_ids, _sched_push_when(r));
    return json_build_object('ok', true, 'id', new_id);
  elsif scope = 'following' then
    if d <= old.start_date then
      return api_sched_update(old.id, event, 'all', null);
    end if;
    update sched_events e set repeat_until = d - 1 where e.id = old.id;
    r.id := new_id; r.created_by := auth.uid(); r.created_at := now(); r.updated_at := now();
    if r.start_date < d then r.start_date := d; r.end_date := d; end if;
    insert into sched_events select r.*;
    update sched_skips s set event_id = new_id where s.event_id = old.id and s.on_date >= d;
    update sched_events c set parent_id = new_id where c.parent_id = old.id and c.parent_date >= d;
    perform _sched_push_change(case when r.cancelled and not old.cancelled then 'cancel' else 'update' end,
                               r, old.member_ids || r.member_ids, _sched_push_when(r, d, true));
    return json_build_object('ok', true, 'id', new_id);
  end if;
  raise exception 'Άγνωστη επιλογή: %', scope;
end $$;

-- Deletes an event. For a weekly series, `scope` works as in api_sched_update.
create or replace function api_sched_delete(id uuid, scope text default 'all', on_date text default null)
returns json language plpgsql set search_path = public as $$
declare h uuid := _sched_require(); old sched_events; d date;
begin
  select * into old from sched_events e where e.id = api_sched_delete.id and e.household_id = h for update;
  if old.id is null then raise exception 'Η δραστηριότητα δεν βρέθηκε. Ίσως έχει ήδη διαγραφεί.'; end if;
  if old.repeat_days is not null and scope in ('one', 'following') then
    d := _sched_date(on_date, 'ημέρα');
    if scope = 'one' then
      insert into sched_skips values (old.id, h, d) on conflict do nothing;
      perform _sched_push_change('delete', old, old.member_ids, _sched_push_when(old, d));
      return json_build_object('ok', true, 'id', old.id);
    end if;
    if d > old.start_date then
      update sched_events e set repeat_until = d - 1 where e.id = old.id;
      delete from sched_events c where c.parent_id = old.id and c.parent_date >= d;
      perform _sched_push_change('delete', old, old.member_ids, _sched_push_when(old, d, true));
      return json_build_object('ok', true, 'id', old.id);
    end if;
  end if;
  delete from sched_events e where e.id = old.id;
  perform _sched_push_change('delete', old, old.member_ids, _sched_push_when(old));
  return json_build_object('ok', true, 'id', old.id);
end $$;

-- Adds a member (id null) or changes one: name, color, hidden.
create or replace function api_sched_save_member(member jsonb) returns json
language plpgsql set search_path = public as $$
declare h uuid := _sched_require(); n text := btrim(coalesce(member ->> 'name', '')); new_id smallint;
begin
  if n = '' then raise exception 'Γράψε όνομα'; end if;
  if coalesce(member ->> 'id', '') = '' then
    insert into sched_members (household_id, name, color, sort_order)
    values (h, n, _sched_color(member ->> 'color'),
            coalesce((select max(sort_order) + 1 from sched_members where household_id = h), 0))
    returning id into new_id;
  else
    update sched_members set name = n, color = _sched_color(member ->> 'color'),
           archived = coalesce((member ->> 'hidden')::boolean, archived)
    where household_id = h and id = (member ->> 'id')::smallint
    returning id into new_id;
    if new_id is null then raise exception 'Το μέλος δεν βρέθηκε'; end if;
  end if;
  return json_build_object('ok', true, 'id', new_id);
exception when unique_violation then
  raise exception 'Υπάρχει ήδη μέλος με όνομα %', n;
end $$;

-- Sets a member's photo (a data URL), or removes it with null or ''.
create or replace function api_sched_member_photo(id smallint, photo text) returns json
language plpgsql set search_path = public as $$
declare h uuid := _sched_require(); p text := nullif(photo, ''); done smallint;
begin
  if p is not null and (p !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' or length(p) > 200000) then
    raise exception 'Η φωτογραφία δεν μπορεί να αποθηκευτεί. Δοκίμασε άλλη.';
  end if;
  update sched_members m set photo = p where m.household_id = h and m.id = api_sched_member_photo.id
  returning m.id into done;
  if done is null then raise exception 'Το μέλος δεν βρέθηκε'; end if;
  return json_build_object('ok', true, 'id', done);
end $$;

-- Adds a category (id null) or changes one: name, color, hidden.
create or replace function api_sched_save_category(category jsonb) returns json
language plpgsql set search_path = public as $$
declare h uuid := _sched_require(); n text := btrim(coalesce(category ->> 'name', '')); new_id smallint;
begin
  if n = '' then raise exception 'Γράψε όνομα'; end if;
  if coalesce(category ->> 'id', '') = '' then
    insert into sched_categories (household_id, name, color, sort_order)
    values (h, n, _sched_color(category ->> 'color'),
            coalesce((select max(sort_order) + 1 from sched_categories where household_id = h), 0))
    returning id into new_id;
  else
    update sched_categories set name = n, color = _sched_color(category ->> 'color'),
           archived = coalesce((category ->> 'hidden')::boolean, archived)
    where household_id = h and id = (category ->> 'id')::smallint
    returning id into new_id;
    if new_id is null then raise exception 'Η κατηγορία δεν βρέθηκε'; end if;
  end if;
  return json_build_object('ok', true, 'id', new_id);
exception when unique_violation then
  raise exception 'Υπάρχει ήδη κατηγορία με όνομα %', n;
end $$;

-- Sets the order of members or categories: `kind` is 'members' or 'categories', `ids` in the new order.
create or replace function api_sched_order(kind text, ids smallint[]) returns json
language plpgsql set search_path = public as $$
declare h uuid := _sched_require();
begin
  if kind = 'members' then
    update sched_members m set sort_order = o.n - 1 from unnest(ids) with ordinality o(id, n)
    where m.household_id = h and m.id = o.id;
  elsif kind = 'categories' then
    update sched_categories c set sort_order = o.n - 1 from unnest(ids) with ordinality o(id, n)
    where c.household_id = h and c.id = o.id;
  else
    raise exception 'Άγνωστο είδος: %', kind;
  end if;
  return json_build_object('ok', true);
end $$;


-- Live updates: Supabase Realtime tells open pages when these tables change.
-- Realtime still applies Row Level Security, so each household hears only about its own rows.
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['sched_events', 'sched_skips', 'sched_members', 'sched_categories'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;


-- Only signed-in users may call the website API; Row Level Security does the rest.
revoke execute on function api_sched_read(text, text), api_sched_add(jsonb),
  api_sched_update(uuid, jsonb, text, text), api_sched_delete(uuid, text, text),
  api_sched_save_member(jsonb), api_sched_member_photo(smallint, text), api_sched_save_category(jsonb), api_sched_order(text, smallint[])
  from public, anon;
grant execute on function api_sched_read(text, text), api_sched_add(jsonb),
  api_sched_update(uuid, jsonb, text, text), api_sched_delete(uuid, text, text),
  api_sched_save_member(jsonb), api_sched_member_photo(smallint, text), api_sched_save_category(jsonb), api_sched_order(text, smallint[])
  to authenticated;
revoke all on function sched_household(), _sched_require(), _sched_date(text, text), _sched_time(text),
  _sched_color(text), _sched_json(sched_events), _sched_values(uuid, jsonb), sched_touch() from anon, public;
grant execute on function sched_household(), _sched_require(), _sched_date(text, text), _sched_time(text),
  _sched_color(text), _sched_json(sched_events), _sched_values(uuid, jsonb), sched_touch() to authenticated;
