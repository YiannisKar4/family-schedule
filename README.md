# Οικογενειακό πρόγραμμα

A small website with the family's week: school, work, football, speech therapy, doctors and anything else.
It is the companion of the [budget site](https://github.com/YiannisKar4/budget) and works the same way:
GitHub Pages for the site, the same Supabase project for the data and the email sign-in.

Live at **https://yianniskar4.github.io/family-schedule/**

- **Εβδομάδα**: Monday to Sunday by the hour. An all-day activity is a tinted band down all the hours of its days, with its title at the top. Tap an empty hour to add something at that time.
  Tap a day's name to see that day as a list.
- **Μήνας**: the month grid. Tap a day to see its list and add to it.
- **Ποιος** (one circle per person, with their photo or initial; always in sight: in the top bar on a sideways phone, a tablet or a computer, in the bottom bar on an upright phone):
  tap one or more to make their activities stand out; the others fade but stay on screen.
  Tap a circle again to let it go. Activities with nobody set (family things) never fade.
- Every activity shows who is on it: small circles with each person's photo, or their initial on
  their colour. They stay in colour even when the activity is faded.
- **+ Νέο**: pick a category and that is the title (Ποδόσφαιρο, Γιατρός …). Only **Άλλο**, or no category,
  asks **Τι**. Older activities with their own title keep it. **Πού** has a **Χάρτης** button that opens the
  place in Maps.
- Picking a category or typing a title used before (e.g. "Ποδόσφαιρο") fills in its usual
  category, people, time and place.
- **Επανάληψη**: every week or every two weeks, on the days you pick, until a date or with no end.
  Changing or deleting one date asks: **Μόνο αυτή**, **Αυτή και επόμενες** or **Όλες**.
- **Ρυθμίσεις** (gear): family members and categories, each with a colour (tap it to see all colours and pick one). Tap a member's circle to
  give them a photo (the site shrinks it to a small square before saving). With a photo already there,
  the same tap offers Αλλαγή or Αφαίρεση. Hidden ones stay on old
  activities but are not offered for new ones.
- Swipe left or right to move a week or a month.
- **Ειδοποιήσεις** (in Ρυθμίσεις, per device): a reminder before each activity with a time
  (10΄, 15΄, 30΄, 1 or 2 hours), only for the people picked (none picked: everyone; family activities always),
  and a notice when someone else adds, changes, cancels or deletes something. Tapping one opens that week.
  On an iPhone they work only in the app added to the home screen from Safari (iOS 16.4 or later).
  Signing out of a device stops its notifications.
- **Live**: what someone adds or changes on another phone shows up within a second, with no refresh.
  The page keeps a connection open to Supabase Realtime ([`js/live.js`](js/live.js)) and loads again only when
  the database says something changed. After a phone sleeps, it reconnects and catches up.

## How it fits together

```
Phone / laptop ──► GitHub Pages (this repo: HTML + JS, no build step)
                       │  sign-in token (shared with the budget site)
                       ▼
               Supabase, same project as the budget
                 ├─ Auth: email sign-in link
                 └─ /rest/v1/rpc/api_sched_*
                       │
                       ▼
               Postgres: sched_* tables, guarded by Row Level Security
```

- Tables: `sched_members`, `sched_categories`, `sched_events`, `sched_skips`.
  They sit next to the budget tables and never touch them.
- Access is the budget's: only emails in `allowed_emails` get in, and each person sees only their
  household. Adding someone to the budget also gives them the schedule.
- A weekly series is one row in `sched_events` (`repeat_days`, `repeat_every`, `repeat_until`).
  The site works out its dates ([`js/dates.js`](js/dates.js)). A cancelled date is a row in `sched_skips`;
  a date changed on its own becomes its own event with `parent_id` pointing at the series.
- `schema.sql` adds the four tables to the `supabase_realtime` publication; Realtime still applies
  Row Level Security, so each household hears only about its own rows.
- The site calls only the `api_sched_*` functions in [`supabase/schema.sql`](supabase/schema.sql):
  `api_sched_read`, `api_sched_add`, `api_sched_update`, `api_sched_delete`,
  `api_sched_save_member`, `api_sched_member_photo`, `api_sched_save_category`, `api_sched_order`,
  and `api_sched_push_*` for notifications.
- Both sites are on `yianniskar4.github.io`, so they share the browser's storage. The schedule uses the
  budget's sign-in key: signed in to one means signed in to the other on that device, and
  **Αποσύνδεση** signs out of both.

## Push notifications

Plain Web Push (the browser standard), sent from Supabase, so there is no other service or account:

```
pg_cron, every minute ──► Edge Function sched-push ──► sched_push_due(): what is due now
                                   │                       (reminders + queued changes, marked sent)
                                   └──► each phone's push service (Google, Apple, Mozilla) ──► sw.js shows it
```

- `sched_push_subs`: one row per device that turned them on, with its choices. The site reaches it only
  through `api_sched_push_key/get/save/remove`.
- `api_sched_add/update/delete` queue a line in `sched_push_changes` for the household's other users.
- `sched_push_config` holds the cron secret (made by `schema.sql`) and the VAPID keys (made by the
  function on its first run). Only `service_role` reads it.
- Times are Greek time (`Europe/Athens`). All-day activities have no reminder.
- [`supabase/functions/sched-push/index.ts`](supabase/functions/sched-push/index.ts) is one file using only
  Web Crypto. `npm run test:push` checks its encryption against an independent implementation.

Setting it up: run `schema.sql` again; Supabase → **Edge Functions** → **Deploy a new function** →
**Via Editor**, name `sched-push`, paste `index.ts`, deploy, and turn off JWT verification for it;
then run [`supabase/push-cron.sql`](supabase/push-cron.sql) in the SQL Editor. Within a minute the keys exist
and each device can turn notifications on in Ρυθμίσεις. To stop: `select cron.unschedule('sched-push');`.

## Setting it up (once)

1. Supabase dashboard → **SQL Editor** → paste all of [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
   It is safe to re-run and does not change the budget.
2. **Authentication → URL Configuration → Redirect URLs**: add
   `https://yianniskar4.github.io/family-schedule/**` (keep the budget one). Without it the sign-in link
   from this site goes to the budget.
3. GitHub: **Settings → Pages**, deploy from branch **main**, folder **/ (root)**.

The first visit creates the starting categories (Σχολείο, Δουλειά, Ποδόσφαιρο, Λογοθεραπεία,
Γιατρός, Οικογένεια, Άλλο). The family members are added once with SQL (see CLAUDE.md); the site has no button for new members.

## Developing locally

```
npm install
npm run test:db         # schema, series edits and security on a local PostgreSQL (PGlite)
npm run test:expand     # weekly dates, overlaps, month grid
npm run test:push       # the push function: encryption, VAPID, a full run against fakes
node dev/supabase-mock.mjs   # site on http://localhost:8090 with a fake Supabase on :8091
```

`node dev/db-test.mjs ../budget/supabase/schema.sql` runs the budget schema first, like the real project,
and checks both still work side by side.

In the mock, sign in as `a@example.com`; the code is at `http://localhost:8091/__mail?email=a@example.com`.
It starts with a sample family. `POST /__reset` reloads it, `POST /__quit` stops the mock.

### Releasing a change

GitHub Pages lets browsers cache files for about 10 minutes. After changing any `.js` or `.css` file,
raise the `?v=` number everywhere it appears (`index.html` and the imports at the top of the files in `js/`).
