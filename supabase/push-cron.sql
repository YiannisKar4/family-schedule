-- Runs the push notifications: every minute, pg_cron calls the Edge Function "sched-push",
-- which sends the reminders and change notices that are due.
-- Run once in the Supabase dashboard (SQL Editor -> paste -> Run), after schema.sql and after
-- the Edge Function is deployed. Safe to re-run. To stop notifications: select cron.unschedule('sched-push');

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule('sched-push', '* * * * *', $$
  select net.http_post(
    url := 'https://ljsdwqpkqkvtyjrevwnk.supabase.co/functions/v1/sched-push',
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select cron_secret from public.sched_push_config)),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
$$);
