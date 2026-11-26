/** Keep nearby details visible while retaining the full scene within the far plane. */
export function clippingPlanes(targetDistance, centerDistance, sceneRadius, nearFactor = 1) {
  const automaticNear = Math.max(0.01, Math.min(1, targetDistance / 100));
  const near = Math.max(0.001, Math.min(10, automaticNear * nearFactor));
  const far = Math.max(near * 2, centerDistance + Math.max(sceneRadius, 1) * 1.05);
  return {near, far};
}
