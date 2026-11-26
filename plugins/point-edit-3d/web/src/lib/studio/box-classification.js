// Depths are camera-space distances. The front object's projected bounds define
// the initial depth cluster; objects overlapping it join the cluster transitively.
export function classifyBox(items) {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.depth - b.depth);
  const front = sorted[0];
  let near = front.depthMin, far = front.depthMax;
  const members = new Set([front.objectId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of sorted) {
      if (!members.has(item.objectId) && item.depth <= far && item.depthMax >= near) {
        members.add(item.objectId); near = Math.min(near, item.depthMin); far = Math.max(far, item.depthMax); changed = true;
      }
    }
  }
  const frontDepth = front.depth;
  const thickness = Math.max(far - near, 1e-9);
  return items.map(item => ({...item, role: members.has(item.objectId) ? 'object' : 'surface',
    score: item.coverage * Math.exp(-(item.depth - frontDepth) / thickness), frontDepth, frontThickness: thickness}));
}
