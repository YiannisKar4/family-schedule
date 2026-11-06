# Οικογενειακό πρόγραμμα

A small website with the family's week: school, work, football, speech therapy, doctors and anything else.
It is the companion of the [budget site](https://github.com/YiannisKar4/budget) and works the same way:
GitHub Pages for the site, the same Supabase project for the data and the email sign-in.

Live at **https://yianniskar4.github.io/family-schedule/**

- **Εβδομάδα**: Monday to Sunday by the hour, with an all-day row. Tap an empty hour to add something at that time.
  Tap a day's name to see that day as a list.
- **Μήνας**: the month grid. Tap a day to see its list and add to it.
- **Ποιος** (big circles above the calendar, one per person, with their photo or initial):
  tap one or more to make their activities stand out; the others fade but stay on screen.
  Tap a circle again to let it go. Activities with nobody set (family things) never fade.
- Every activity shows who is on it: small circles with each person's photo, or their initial on
  their colour. They stay in colour even when the activity is faded.
- **+ Νέο**: add in a few taps. Typing a title used before (e.g. "Ποδόσφαιρο") fills in its usual
  category, people, time and place.
- **Επανάληψη**: every week or every two weeks, on the days you pick, until a date or with no end.
  Changing or deleting one date asks: **Μόνο αυτή**, **Αυτή και επόμενες** or **Όλες**.
- **Ρυθμίσεις** (gear): family members and categories, each with a colour. Tap a member's circle to
  give them a photo (the site shrinks it to a small square before saving). With a photo already there,
  the same tap offers Αλλαγή or Αφαίρεση. Hidden ones stay on old
  activities but are not offered for new ones.
- Swipe left or right to move a week or a month. Coming back to the page reloads what others added.

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
- The site calls only the `api_sched_*` functions in [`supabase/schema.sql`](supabase/schema.sql):
  `api_sched_read`, `api_sched_add`, `api_sched_update`, `api_sched_delete`,
  `api_sched_save_member`, `api_sched_member_photo`, `api_sched_save_category`, `api_sched_order`.
- Both sites are on `yianniskar4.github.io`, so they share the browser's storage. The schedule uses the
  budget's sign-in key: signed in to one means signed in to the other on that device, and
  **Αποσύνδεση** signs out of both.

## Setting it up (once)

1. Supabase dashboard → **SQL Editor** → paste all of [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
   It is safe to re-run and does not change the budget.
2. **Authentication → URL Configuration → Redirect URLs**: add
   `https://yianniskar4.github.io/family-schedule/**` (keep the budget one). Without it the sign-in link
   from this site goes to the budget.
3. GitHub: **Settings → Pages**, deploy from branch **main**, folder **/ (root)**.

The first visit creates the starting categories (Σχολείο, Δουλειά, Ποδόσφαιρο, Λογοθεραπεία,
Γιατρός, Οικογένεια, Άλλο). Then add the family members in **Ρυθμίσεις**.

## Developing locally

```
npm install
npm run test:db         # schema, series edits and security on a local PostgreSQL (PGlite)
npm run test:expand     # weekly dates, overlaps, month grid
node dev/supabase-mock.mjs   # site on http://localhost:8090 with a fake Supabase on :8091
```

`node dev/db-test.mjs ../budget/supabase/schema.sql` runs the budget schema first, like the real project,
and checks both still work side by side.

In the mock, sign in as `a@example.com`; the code is at `http://localhost:8091/__mail?email=a@example.com`.
It starts with a sample family. `POST /__reset` reloads it, `POST /__quit` stops the mock.

### Releasing a change

GitHub Pages lets browsers cache files for about 10 minutes. After changing any `.js` or `.css` file,
raise the `?v=` number everywhere it appears (`index.html` and the imports at the top of the files in `js/`).
