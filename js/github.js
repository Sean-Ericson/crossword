/*
 * github.js — minimal GitHub Contents API client for the private data repo.
 * All requests carry the fine-grained PAT; api.github.com sends permissive
 * CORS headers so this works from any static host.
 */

import { b64EncodeUtf8, b64DecodeUtf8 } from './util.js';

// `xw:test:gh-api` lets integration tests point the client at a mock server.
const API =
  globalThis.localStorage?.getItem?.('xw:test:gh-api') || 'https://api.github.com';

export class GitHubError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}
export class AuthError extends GitHubError {}
export class ConflictError extends GitHubError {}

export class GitHubClient {
  /** @param {{token:string, owner:string, repo:string, branch?:string}} cfg */
  constructor({ token, owner, repo, branch = 'main' }) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.shaCache = new Map(); // path -> last-known blob sha
  }

  headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  contentsUrl(path) {
    return `${API}/repos/${this.owner}/${this.repo}/contents/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
  }

  async raise(resp, context) {
    let detail = '';
    try {
      detail = (await resp.json()).message ?? '';
    } catch {
      /* no body */
    }
    const msg = `${context}: HTTP ${resp.status}${detail ? ` — ${detail}` : ''}`;
    if (resp.status === 401 || resp.status === 403) throw new AuthError(msg, resp.status);
    if (resp.status === 409 || resp.status === 422) throw new ConflictError(msg, resp.status);
    throw new GitHubError(msg, resp.status);
  }

  /** @returns {Promise<{json: any, sha: string} | null>} null on 404 */
  async getFile(path) {
    const resp = await fetch(`${this.contentsUrl(path)}?ref=${encodeURIComponent(this.branch)}`, {
      headers: this.headers(),
      cache: 'no-store',
    });
    if (resp.status === 404) return null;
    if (!resp.ok) await this.raise(resp, `read ${path}`);
    const data = await resp.json();
    this.shaCache.set(path, data.sha);
    let json = null;
    try {
      json = JSON.parse(b64DecodeUtf8(data.content));
    } catch {
      throw new GitHubError(`read ${path}: not valid JSON`);
    }
    return { json, sha: data.sha };
  }

  /**
   * Create/update a JSON file. Uses the provided sha, else the cached one.
   * @returns {Promise<{sha: string}>} the new blob sha
   * @throws {ConflictError} when the sha is stale (caller should refetch+merge)
   */
  async putFile(path, obj, { message, sha, keepalive = false } = {}) {
    const body = {
      message: message || `update ${path}`,
      content: b64EncodeUtf8(JSON.stringify(obj, null, 1)),
      branch: this.branch,
    };
    const useSha = sha !== undefined ? sha : this.shaCache.get(path);
    if (useSha) body.sha = useSha;
    const resp = await fetch(this.contentsUrl(path), {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive,
    });
    if (!resp.ok) {
      // A 422 "sha wasn't supplied" means the file exists but we had no sha.
      this.shaCache.delete(path);
      await this.raise(resp, `write ${path}`);
    }
    const data = await resp.json();
    this.shaCache.set(path, data.content.sha);
    return { sha: data.content.sha };
  }

  /** @returns {Promise<Array<{name:string, path:string, type:string}>>} [] on 404 */
  async listDir(path) {
    const resp = await fetch(`${this.contentsUrl(path)}?ref=${encodeURIComponent(this.branch)}`, {
      headers: this.headers(),
      cache: 'no-store',
    });
    if (resp.status === 404) return [];
    if (!resp.ok) await this.raise(resp, `list ${path}`);
    const data = await resp.json();
    return Array.isArray(data)
      ? data.map((e) => ({ name: e.name, path: e.path, type: e.type }))
      : [];
  }

  /** Light connectivity/permissions check. */
  async testAuth() {
    try {
      const resp = await fetch(`${API}/repos/${this.owner}/${this.repo}`, {
        headers: this.headers(),
        cache: 'no-store',
      });
      if (!resp.ok) {
        let detail = '';
        try {
          detail = (await resp.json()).message ?? '';
        } catch {
          /* ignore */
        }
        return {
          ok: false,
          error:
            resp.status === 404
              ? 'Repo not found (check owner/repo, and that the token can access it).'
              : `HTTP ${resp.status}${detail ? ` — ${detail}` : ''}`,
        };
      }
      const repo = await resp.json();
      return {
        ok: true,
        private: !!repo.private,
        pushAllowed: !!repo.permissions?.push,
      };
    } catch (err) {
      return { ok: false, error: `Network error: ${err.message}` };
    }
  }
}
