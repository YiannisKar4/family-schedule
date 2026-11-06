// The Supabase project, shared with the budget site. Both values are public by design:
// the publishable key only works together with a signed-in user, and Row Level Security
// in the database decides what that user can see.
export const SUPABASE_URL = 'https://ljsdwqpkqkvtyjrevwnk.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_JWcVk0Y2g8iTLPOiRtuaIA_PtgWwpn7';

// Both sites live on yianniskar4.github.io, so they share the browser's storage.
// Using the budget's sign-in key means a device signed in to one is signed in to the other.
export const SESSION_KEY = 'budget.session';

// Start of every other key this site saves in the browser (view, filters).
export const STORAGE_PREFIX = 'schedule';
