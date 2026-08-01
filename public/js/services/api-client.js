// ============================================================
// Thin fetch wrapper. Every backend call in the app goes through
// one instance of this, so auth/error/retry behaviour only needs
// to change in one place.
// ============================================================

export class ApiClient {
  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
    /** Called when the server reports the staff session is gone (401). */
    this.onUnauthorized = null;
  }

  async request(method, path, body) {
    let res;
    try {
      const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
        // Send the httpOnly staff session cookie. Same-origin is already the
        // browser default, but stating it makes the dependency explicit.
        credentials: 'same-origin',
      };
      if (body !== undefined) opts.body = JSON.stringify(body);
      res = await fetch(this.baseUrl + path, opts);
    } catch (err) {
      return { ok: false, error: 'Network error — is the server running?' };
    }

    // A 401 means the staff session expired or was never established. Surface
    // it once, centrally, instead of letting every dashboard panel render an
    // unexplained "could not load" message.
    if (res.status === 401 && this.onUnauthorized) this.onUnauthorized();

    try {
      return await res.json();
    } catch (err) {
      // A non-JSON body means the server returned something unexpected
      // (proxy error page, HTML). Don't let JSON.parse throw into callers.
      return { ok: false, error: `Unexpected response from server (${res.status})` };
    }
  }

  get(path)          { return this.request('GET', path); }
  post(path, body)   { return this.request('POST', path, body); }
  patch(path, body)  { return this.request('PATCH', path, body); }
  delete(path)       { return this.request('DELETE', path); }
}

// Single shared instance — the whole app talks to the same API origin.
export const api = new ApiClient();
