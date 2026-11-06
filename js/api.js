// Calls the api_sched_* functions in the database, with readable errors.
import * as supa from './supa.js?v=33';

export class ApiError extends Error {
  constructor(message, code = '') {
    super(message);
    this.code = code;
  }
}

async function rpc(fn, args) {
  try {
    return await supa.rpc(fn, args);
  } catch (e) {
    if (e.message === 'login-required') throw new ApiError('Η σύνδεση έληξε. Συνδέσου ξανά με το email σου.', 'login-required');
    if (e.message === 'no-access') throw new ApiError(`Το email ${supa.userEmail()} δεν έχει πρόσβαση.`, 'no-access');
    throw new ApiError(e.message);
  }
}

export const read = (from, to) => rpc('api_sched_read', { from_date: from, to_date: to });
export const add = (event) => rpc('api_sched_add', { event });
export const update = (id, event, scope = 'all', onDate = null) => rpc('api_sched_update', { id, event, scope, on_date: onDate });
export const remove = (id, scope = 'all', onDate = null) => rpc('api_sched_delete', { id, scope, on_date: onDate });
export const saveMember = (member) => rpc('api_sched_save_member', { member });
export const memberPhoto = (id, photo) => rpc('api_sched_member_photo', { id, photo });
export const saveCategory = (category) => rpc('api_sched_save_category', { category });
export const order = (kind, ids) => rpc('api_sched_order', { kind, ids });
