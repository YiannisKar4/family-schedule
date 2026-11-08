# Family schedule: context for Claude

Owner: Yiannis (karaglanisy@gmail.com). Talk to him in Greek. Write plainly: no em-dashes, no filler,
change only what he asks. The site's UI text is Greek.

## What this is

The family's calendar: school, work, football, speech therapy, doctors and anything else.
Week view (by the hour) and month view, quick add, weekly series, filter by person.
Live at https://yianniskar4.github.io/family-schedule/ (GitHub Pages, branch `main`, root).

Family members: Γιάννης, Αθηνά, Πάνος, Νικόλας (Πάνος and Νικόλας are the children).

## Decisions already made (do not ask again)

- **Separate repo** from the budget site (https://github.com/YiannisKar4/budget). Keep them separate;
  do not merge repos or READMEs.
- **Same Supabase project as the budget** (the project was named "budget"; he may rename it "Family",
  which changes nothing in code). Same sign-in, same `households` and `allowed_emails`.
  This site's tables and functions are prefixed `sched_` / `api_sched_` and never touch budget tables.
- Same stack and style as the budget: vanilla JS modules, no build step, the budget's CSS base.
- Sign-in uses the budget's browser key (`budget.session`), so one sign-in covers both sites on a device;
  sign-out signs out of both.
- Weekly repeats from phase one: every 1 or 2 weeks, chosen weekdays, optional end date.
  Edits and deletes on a series ask: only this / this and following / all.

## Setup status (check with him before assuming done)

1. Run `supabase/schema.sql` in the Supabase SQL Editor. Safe to re-run.
2. Insert the members:
   ```sql
   insert into sched_members (household_id, name, color, sort_order)
   select a.household_id, v.name, v.color, v.ord
   from allowed_emails a,
        (values ('Γιάννης', '#2a78d6', 0), ('Αθηνά', '#e87ba4', 1), ('Πάνος', '#1baf7a', 2), ('Νικόλας', '#eda100', 3)) v(name, color, ord)
   where a.email = 'karaglanisy@gmail.com'
   on conflict (household_id, name) do nothing;
   ```
3. Supabase → Authentication → URL Configuration → Redirect URLs: add
   `https://yianniskar4.github.io/family-schedule/**` (keep the budget's).
4. GitHub → Settings → Pages: deploy from `main`, `/ (root)`.
5. Push notifications (added Nov 2026): re-run `schema.sql`, deploy the Edge Function `sched-push`
   (dashboard editor, paste `supabase/functions/sched-push/index.ts`, JWT verification off),
   then run `supabase/push-cron.sql`. See README "Push notifications".

## Sign-in email template

The Magic Link template is one per Supabase project. `supabase/magic-link-email.html` holds one template
that branches on `.RedirectTo`: the schedule gets its own text, everything else gets his budget HTML as is.
He pastes it into Supabase → Authentication → Emails → Magic Link. Subject stays shared
(e.g. "Σύνδεση στα οικογενειακά"). Works only once the schedule's Redirect URL is allowed.

A brand new email gets the Confirm signup template instead of Magic Link (Supabase's default is English).
`supabase/confirm-signup-email.html` is the same two designs for that template; he pastes it into
Authentication → Emails → Confirm signup. The sender name ("Οικογενειακά Έξοδα") is in the SMTP settings
and is shared with the budget.

## Working on the code

Work on a branch, open a PR and merge it into `main` yourself, without asking: he said a mistake can be rolled back.
Still answer questions with an answer, not with a change.

See README.md. Before pushing: `npm run test:db`, `npm run test:expand`, `npm run test:push`, and a look at the site in the
mock (`node dev/supabase-mock.mjs`, sign in as a@example.com, code at
http://localhost:8091/__mail?email=a@example.com). After changing any `.js` or `.css`, raise every `?v=`.
The site installs as an app (PWA): `manifest.json`, `icons/`, `sw.js`. The service worker caches only
this site's files: the page network-first, `?v=` files cache-first (so the `?v=` raise is what ships them).

Known limit: on a narrow phone, overlapping events in the week view truncate their titles;
the day list (tap the day name) shows them in full.

If a GitHub Pages deploy hangs ("updating_pages", then "Timeout reached" after 10 minutes, and a re-run sits
queued and cannot be cancelled), it is on GitHub's side. Start a fresh build with a new commit to `main`.
