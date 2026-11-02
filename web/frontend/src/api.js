export async function getJSON(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || "request"), { code: body.error || "request" });
  return body;
}

export function uploadDemo(file, steamid, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/matches/upload");
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
