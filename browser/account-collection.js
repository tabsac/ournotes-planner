/** Game profile-card stickers (MasterDegree); absent data is unknown, never unowned. */
export function stickerCollection(player) {
 const field = ["_degrees", "degrees", "_playerDegrees"].find(k => Object.hasOwn(player || {}, k));
 if (!field || !Array.isArray(player[field])) return {known:false, counts:[], reason:"missing"};
 const counts = new Map();
 for (const row of player[field]) {
  const id = Number(typeof row === "number" ? row : row?._masterDegreeId ?? row?.masterDegreeId ?? row?.master_id ?? row?.masterId ?? row?._masterId ?? row?.id);
  const count = Number(typeof row === "number" ? 1 : row?._amount ?? row?._count ?? row?.count ?? row?.amount ?? 1);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(count) || count < 0) return {known:false, counts:[], reason:"unsupported"};
  counts.set(id, Math.max(counts.get(id) || 0, count));
 }
 return {known:true, counts:[...counts].sort((a,b)=>a[0]-b[0]).map(([id,count])=>({id,count}))};
}
