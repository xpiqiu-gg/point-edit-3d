/** Check a small camera-target distance relative to the scale of the scene. */
export function pivotRecoveryThreshold(sceneRadius) {
  return Math.max(0.1, Math.min(10, Math.max(0, Number.isFinite(sceneRadius) ? sceneRadius : 0) * 0.0001));
}

/** Recover navigation when the orbit target is close to the camera but visible geometry is far away. */
export function recoveredPivotDistance(currentDistance, hitDepth, sceneRadius) {
  if (!Number.isFinite(currentDistance) || currentDistance >= pivotRecoveryThreshold(sceneRadius)) return null;
  if (Number.isFinite(hitDepth) && hitDepth > Math.max(0.2, currentDistance * 20)) return Math.min(hitDepth, 100000);
  if (hitDepth == null && currentDistance < 0.05) return Math.max(1, Math.min(20, sceneRadius * 0.002));
  return null;
}
