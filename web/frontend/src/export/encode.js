import { Muxer, ArrayBufferTarget } from "mp4-muxer";

export const ENCODE_REV = 4;
import { FILTERS } from "../api.js";

function even(n) { return Math.max(2, n - (n % 2)); }

export async function encodeMp4({ canvas, fps = 30, frameCount, draw, filter = "none", text = "", audio = null, onProgress, look }) {
  const width = even(1280);
  const height = even(720);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  const prev = document.createElement("canvas");
  prev.width = width;
  prev.height = height;
  const pctx = prev.getContext("2d");

  function paint(i, transition) {
    const style = look || { filter, text };
    ctx.filter = FILTERS[style.filter || "none"] || "none";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (transition === "crossfade" && i < 8) {
      ctx.globalAlpha = 1;
      ctx.drawImage(prev, 0, 0, width, height);
      ctx.globalAlpha = i / 8;
    } else ctx.globalAlpha = 1;
    if (transition === "whip" && i < 8) {
      const k = 1 - i / 8;
      ctx.save();
      ctx.translate(width * 0.32 * k, height * 0.04 * k);
      ctx.scale(1 + 0.16 * k, 1 + 0.16 * k);
      ctx.drawImage(canvas, 0, 0, width, height);
      ctx.restore();
    } else ctx.drawImage(canvas, 0, 0, width, height);
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    const label = style.text || "";
    if (label) {
      ctx.font = "600 28px sans-serif";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(8,10,14,0.5)";
      ctx.fillRect(32, height - 96, Math.min(width - 64, tw + 40), 54);
      ctx.fillStyle = "#f4efe4";
      ctx.fillText(label, 48, height - 60);
    }
    pctx.clearRect(0, 0, width, height);
    pctx.drawImage(out, 0, 0);
  }

  if (typeof VideoEncoder === "undefined") {
    return recordRealtime({ out, fps, frameCount, draw, paint });
  }

  let audioOk = false;
  if (audio && typeof AudioEncoder !== "undefined" && AudioEncoder.isConfigSupported) {
    try {
      const support = await AudioEncoder.isConfigSupported({
        codec: "mp4a.40.2",
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128000,
      });
      audioOk = !!support.supported;
    } catch { audioOk = false; }
  }
  const target = new ArrayBufferTarget();
  const muxerOpts = {
    target,
    video: { codec: "avc", width, height },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  };
  if (audioOk) muxerOpts.audio = { codec: "aac", numberOfChannels: 2, sampleRate: 48000 };
  const muxer = new Muxer(muxerOpts);
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => { throw err; },
  });
  const videoConfig = {
    codec: "avc1.42001f",
    width,
    height,
    bitrate: 2_000_000,
    framerate: fps,
  };
  try {
    encoder.configure({ ...videoConfig, avc: { format: "avc" } });
  } catch {
    encoder.configure(videoConfig);
  }

  if (audioOk) {
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: () => {},
    });
    audioEncoder.configure({ codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 48000, bitrate: 128000 });
    const chunk = 1024;
    const total = Math.floor((frameCount / fps) * 48000);
    for (let offset = 0; offset < total; offset += chunk) {
      const frames = Math.min(chunk, total - offset);
      const data = new Float32Array(frames * 2);
      for (let i = 0; i < frames; i++) {
        const s = audio[offset + i] || 0;
        data[i * 2] = s;
        data[i * 2 + 1] = s;
      }
      const audioData = new AudioData({
        format: "f32", sampleRate: 48000, numberOfFrames: frames, numberOfChannels: 2,
        timestamp: Math.round((offset / 48000) * 1e6), data,
      });
      audioEncoder.encode(audioData);
      audioData.close();
    }
    await audioEncoder.flush();
  }

  for (let i = 0; i < frameCount; i++) {
    const transition = await draw(i);
    paint(i, transition);
    const frame = new VideoFrame(out, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(frame, { keyFrame: i % 30 === 0 });
    frame.close();
    if (onProgress && i % 4 === 0) onProgress(i / frameCount);
    while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 4));
  }
  if (onProgress) onProgress(1);
  await Promise.race([
    encoder.flush(),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]);
  muxer.finalize();
  return new Blob([target.buffer], { type: "video/mp4" });
}

async function recordRealtime({ out, fps, frameCount, draw, paint }) {
  const stream = out.captureStream(fps);
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
  const rec = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type: "video/webm" })); });
  rec.start();
  for (let i = 0; i < frameCount; i++) {
    await draw(i);
    paint(i, "cut");
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  rec.stop();
  const webm = await done;
  const res = await fetch("/api/mux", { method: "POST", headers: { "Content-Type": "video/webm" }, body: webm });
  if (!res.ok) return webm;
  return new Blob([await res.arrayBuffer()], { type: "video/mp4" });
}

export async function mixAudio({ musicBuffer, duration, sfx = false, bed = false }) {
  const rate = 48000;
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(duration * rate)), rate);
  if (musicBuffer) {
    const src = ctx.createBufferSource();
    src.buffer = musicBuffer;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    src.connect(gain).connect(ctx.destination);
    src.start();
  }
  if (bed) {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 174;
    const g = ctx.createGain();
    g.gain.value = 0.04;
    osc.connect(g).connect(ctx.destination);
    osc.start();
  }
  if (sfx) {
    const noise = ctx.createBuffer(1, Math.floor(rate * 0.2), rate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) * 0.4;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.connect(ctx.destination);
    src.start(0.02);
  }
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

export function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
