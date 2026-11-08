// Push notifications on this device: signing up with the browser's push service, and this
// device's choices, kept in the database (sched_push_subs). The Edge Function sends them.
import * as api from './api.js?v=42';

const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/**
 * What this device can do:
 * 'ios-browser' (iPhone outside the home screen app), 'unsupported', 'denied', 'off', 'on'.
 */
export async function status() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return ios() && !installed() ? 'ios-browser' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  return (await subscription()) ? 'on' : 'off';
}

async function subscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

function keys(sub) {
  const j = sub.toJSON();
  return { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth };
}

function bytes(b64u) {
  const bin = atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64u.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Asks for permission (must run inside a tap) and signs this device up with the default choices. */
export async function enable() {
  const { key } = await api.pushKey();
  if (!key) throw new Error('Οι ειδοποιήσεις δεν έχουν ρυθμιστεί ακόμα στο Supabase.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Δεν δόθηκε άδεια για ειδοποιήσεις.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another key cannot be used; start again.
  if (sub && sub.options.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey)))
      !== btoa(String.fromCharCode(...bytes(key)))) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
  await api.pushSave(keys(sub));
}

/** This device's choices: { remindMinutes, members, changes }, or null when it is not signed up. */
export async function choices() {
  const sub = await subscription();
  if (!sub) return null;
  let c = await api.pushGet(sub.endpoint);
  if (!c) { // removed on the server (e.g. signed out elsewhere): sign up again
    await api.pushSave(keys(sub));
    c = await api.pushGet(sub.endpoint);
  }
  return c;
}

export async function save(change) {
  const sub = await subscription();
  if (!sub) throw new Error('Οι ειδοποιήσεις είναι κλειστές σε αυτή τη συσκευή.');
  await api.pushSave({ ...keys(sub), ...change });
}

/** Stops notifications on this device. */
export async function disable() {
  const sub = await subscription();
  if (!sub) return;
  await api.pushRemove(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

/** On each start: keeps the server's copy of this device's keys current. Never asks anything. */
export async function sync() {
  try {
    if ((await status()) !== 'on') return;
    await api.pushSave(keys(await subscription()));
  } catch { /* offline or signed out: next time */ }
}
