export const API_BASE = String(import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
export const needsBackend = import.meta.env.VITE_PAGES === "1" && !API_BASE;

export function api(path) {
  return `${API_BASE}${path}`;
}

async function read(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || "request"), { code: body.error || "request" });
  return body;
}

export async function getJSON(path) {
  return read(await fetch(api(path), { credentials: "include" }));
}

export async function sendJSON(path, method, payload) {
  return read(await fetch(api(path), {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }));
}

export function uploadDemo(file, steamid, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", api("/api/matches/upload"));
    xhr.withCredentials = true;
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      const body = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(Object.assign(new Error(body.error || "upload"), { code: body.error }));
    };
    xhr.onerror = () => reject(new Error("network"));
    const data = new FormData();
    data.append("demo", file);
    if (steamid) data.append("steamid", steamid);
    xhr.send(data);
  });
}

export const FILTERS = {
  none: "none",
  cold: "saturate(0.75) hue-rotate(18deg) contrast(1.05)",
  warm: "sepia(0.28) saturate(1.1) contrast(1.04)",
  contrast: "contrast(1.28) saturate(1.05)",
  bleach: "saturate(0.3) contrast(1.22) brightness(1.05)",
  noir: "grayscale(1) contrast(1.28)",
};
