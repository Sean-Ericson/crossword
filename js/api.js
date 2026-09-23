/*
 * api.js — tiny JSON client for the site's own server (/api/...). A 401
 * means the session is gone, so it sends the visitor to the login page.
 */

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function goToLogin() {
  const next = encodeURIComponent(location.pathname + location.search);
  location.href = `./login.html?next=${next}`;
}

async function request(method, path, body, { redirectOn401 = true } = {}) {
  let resp;
  try {
    resp = await fetch(`./api/${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, "Can't reach the server.");
  }
  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }
  if (resp.status === 401 && redirectOn401) {
    goToLogin();
    throw new ApiError(401, data?.error || 'Please log in.');
  }
  if (!resp.ok) throw new ApiError(resp.status, data?.error || `Server error (${resp.status}).`);
  return data;
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body = {}, opts) => request('POST', path, body, opts),
};
