// Reading dropped and picked files.
//
// Nothing here copies a file into storage. Images become a small
// thumbnail plus a note of what the original was; text files become
// text. That's the "links and references, not copies" rule (spec
// decision #1/#14) applied to local files — the bytes stay where Dan
// put them, and Drive takes over as the canonical home once CORE-4
// lands.

const THUMB_MAX = 320;
const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'fountain', 'json', 'csv', 'rtf'];

export function isImage(file) {
  return file.type.startsWith('image/');
}

export function isText(file) {
  if (file.type.startsWith('text/') || file.type === 'application/json') return true;
  const ext = file.name.split('.').pop().toLowerCase();
  return TEXT_EXTENSIONS.includes(ext);
}

export function fileRef(file) {
  return { name: file.name, size: file.size, type: file.type };
}

export function readText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Downscaled to THUMB_MAX on its long edge: the grid never shows an
// image bigger than a tile, and a production's worth of full-size data
// URLs would fill local storage on its own.
export async function makeThumbnail(file) {
  const dataUrl = await readDataUrl(file);
  return shrinkDataUrl(dataUrl);
}

export function shrinkDataUrl(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, THUMB_MAX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      try {
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      } catch {
        // A cross-origin image taints the canvas; the URL still works
        // as a thumbnail even when its pixels can't be read back.
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(null);
    img.crossOrigin = 'anonymous';
    img.src = dataUrl;
  });
}

// Writes a file out of the extension page — the out-box's "Download"
// (M4-16). Extension pages can do this without the downloads
// permission because it's an ordinary anchor click.
export function downloadText(filename, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoked on the next tick so the click has taken the URL first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
