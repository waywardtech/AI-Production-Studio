// A small Google Drive v3 client — only the calls Edge Studio makes.
//
// Documents are created as real Google Docs by uploading plain text with
// the Docs mime type: Drive converts it on the way in, which puts the Doc
// in the right folder in one request. Reading back uses Drive's export,
// so only one Google API (Drive) needs enabling.
//
// `fetchImpl` and `auth` are injected so the sync engine can be tested
// against a simulated Drive; in the extension they're window.fetch and
// shared/google-auth.js.

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DOC_MIME = 'application/vnd.google-apps.document';

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,webViewLink,trashed,parents,appProperties';

export class DriveError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    this.body = body;
  }
}

// Drive query strings are single-quoted; a name containing a quote or a
// backslash would otherwise break (or change) the query.
export function quote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function multipartBody(metadata, content, contentType) {
  const boundary = `edge-studio-${Math.random().toString(36).slice(2)}`;
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

// The same envelope, but with the content as a Blob so the bytes go up
// untouched. Building the body as a Blob rather than a string is what
// keeps a JPEG a JPEG: a binary payload spliced into a JS string would
// be mangled by UTF-8 encoding on the way out.
function multipartBlobBody(metadata, blob, contentType) {
  const boundary = `edge-studio-${Math.random().toString(36).slice(2)}`;
  const head =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  return {
    body: new Blob([head, blob, tail]),
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

// Google's text export starts with a byte-order mark and uses CRLF line
// endings; nothing downstream should have to know that.
export function normalizeExportedText(text) {
  return String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function createDrive({ fetchImpl, auth }) {
  async function request(method, url, { query, json, body, contentType, parse = 'json', retried = false } = {}) {
    const full = new URL(url);
    Object.entries(query || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) full.searchParams.set(key, value);
    });

    const headers = { Authorization: `Bearer ${await auth.getAccessToken()}` };
    let payload = body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json; charset=UTF-8';
      payload = JSON.stringify(json);
    } else if (contentType) {
      headers['Content-Type'] = contentType;
    }

    const response = await fetchImpl(full.href, { method, headers, body: payload });

    // A token that looked valid but was rejected (revoked, or the clock is
    // off): drop it and try exactly once more with a fresh one.
    if (response.status === 401 && !retried) {
      await auth.invalidateToken();
      return request(method, url, { query, json, body, contentType, parse, retried: true });
    }

    if (!response.ok) {
      let detail = '';
      try {
        const err = await response.json();
        detail = err?.error?.message || JSON.stringify(err);
      } catch {
        detail = await response.text().catch(() => '');
      }
      throw new DriveError(response.status, `Drive ${method} failed (${response.status}): ${detail}`, detail);
    }

    if (response.status === 204 || parse === 'none') return null;
    if (parse === 'text') return response.text();
    if (parse === 'blob') return response.blob();
    return response.json();
  }

  async function listAll(query) {
    const files = [];
    let pageToken;
    do {
      const page = await request('GET', `${API}/files`, {
        query: { ...query, pageToken, pageSize: 1000, fields: `nextPageToken,files(${FILE_FIELDS})` },
      });
      files.push(...(page.files || []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  const drive = {
    async about() {
      const data = await request('GET', `${API}/about`, { query: { fields: 'user(emailAddress,displayName)' } });
      return { email: data.user?.emailAddress || null, name: data.user?.displayName || null };
    },

    async getFile(id) {
      try {
        return await request('GET', `${API}/files/${encodeURIComponent(id)}`, { query: { fields: FILE_FIELDS } });
      } catch (error) {
        if (error instanceof DriveError && error.status === 404) return null;
        throw error;
      }
    },

    // Finds files Edge Studio tagged with an app property. drive.file only
    // lets the extension see files it created, so this can't match
    // anything of Dan's by accident.
    async findByAppProperty(key, value, { parentId } = {}) {
      const clauses = [`appProperties has { key=${quote(key)} and value=${quote(value)} }`, 'trashed = false'];
      if (parentId) clauses.push(`${quote(parentId)} in parents`);
      return listAll({ q: clauses.join(' and '), spaces: 'drive' });
    },

    async listChildren(folderId) {
      return listAll({ q: `${quote(folderId)} in parents and trashed = false`, spaces: 'drive' });
    },

    async createFolder({ name, parentId, appProperties = {} }) {
      return request('POST', `${API}/files`, {
        query: { fields: FILE_FIELDS },
        json: { name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : undefined, appProperties },
      });
    },

    async createDoc({ name, parentId, text, description = '', appProperties = {} }) {
      const { body, contentType } = multipartBody(
        { name, mimeType: DOC_MIME, parents: [parentId], description, appProperties },
        text,
        'text/plain; charset=UTF-8'
      );
      return request('POST', `${UPLOAD}/files`, {
        query: { uploadType: 'multipart', fields: FILE_FIELDS },
        body,
        contentType,
      });
    },

    // Replaces a Doc's content (and name/description) from plain text.
    async updateDoc(id, { name, text, description }) {
      const metadata = {};
      if (name !== undefined) metadata.name = name;
      if (description !== undefined) metadata.description = description;
      const { body, contentType } = multipartBody(metadata, text, 'text/plain; charset=UTF-8');
      return request('PATCH', `${UPLOAD}/files/${encodeURIComponent(id)}`, {
        query: { uploadType: 'multipart', fields: FILE_FIELDS },
        body,
        contentType,
      });
    },

    // ---------- files kept as themselves ----------
    //
    // An asset's bytes go up as an ordinary Drive file rather than a
    // Doc: converting a JPEG or an MP4 to a Google Doc would be
    // nonsense, and the point is to get the same file back out.

    async uploadFile({ name, parentId, blob, mimeType, appProperties = {} }) {
      const { body, contentType } = multipartBlobBody(
        {
          name,
          parents: [parentId],
          mimeType: mimeType || blob.type || 'application/octet-stream',
          appProperties,
        },
        blob,
        mimeType || blob.type || 'application/octet-stream'
      );
      return request('POST', `${UPLOAD}/files`, {
        query: { uploadType: 'multipart', fields: FILE_FIELDS },
        body,
        contentType,
      });
    },

    async downloadFile(id) {
      try {
        return await request('GET', `${API}/files/${encodeURIComponent(id)}`, {
          query: { alt: 'media' },
          parse: 'blob',
        });
      } catch (error) {
        if (error instanceof DriveError && error.status === 404) return null;
        throw error;
      }
    },

    async exportText(id) {
      const text = await request('GET', `${API}/files/${encodeURIComponent(id)}/export`, {
        query: { mimeType: 'text/plain' },
        parse: 'text',
      });
      return normalizeExportedText(text);
    },

    async update(id, metadata) {
      return request('PATCH', `${API}/files/${encodeURIComponent(id)}`, {
        query: { fields: FILE_FIELDS },
        json: metadata,
      });
    },

    // Trash, not delete: anything Edge Studio removes can be restored
    // from Drive's trash. A file already gone counts as done.
    async trash(id) {
      try {
        return await request('PATCH', `${API}/files/${encodeURIComponent(id)}`, {
          query: { fields: 'id,trashed' },
          json: { trashed: true },
        });
      } catch (error) {
        if (error instanceof DriveError && error.status === 404) return null;
        throw error;
      }
    },

    // ---------- the hidden app-data index ----------

    appData: {
      async list() {
        return listAll({ spaces: 'appDataFolder' });
      },

      async read(id) {
        return request('GET', `${API}/files/${encodeURIComponent(id)}`, { query: { alt: 'media' } });
      },

      async create({ name, data, appProperties = {} }) {
        const { body, contentType } = multipartBody(
          { name, parents: ['appDataFolder'], mimeType: 'application/json', appProperties },
          JSON.stringify(data),
          'application/json; charset=UTF-8'
        );
        return request('POST', `${UPLOAD}/files`, {
          query: { uploadType: 'multipart', fields: FILE_FIELDS },
          body,
          contentType,
        });
      },

      async update(id, { data, appProperties = {} }) {
        const { body, contentType } = multipartBody(
          { appProperties },
          JSON.stringify(data),
          'application/json; charset=UTF-8'
        );
        return request('PATCH', `${UPLOAD}/files/${encodeURIComponent(id)}`, {
          query: { uploadType: 'multipart', fields: FILE_FIELDS },
          body,
          contentType,
        });
      },
    },
  };

  return drive;
}
