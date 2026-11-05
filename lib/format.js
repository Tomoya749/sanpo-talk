export const formatInt = (n) => Math.round(n).toLocaleString("ja-JP");

// 経過時間を「12:34」や「1:02:03」の形にする
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export const formatKm = (meters) => (meters / 1000).toFixed(2);

export const formatSeconds = (ms) => (ms / 1000).toFixed(1);
