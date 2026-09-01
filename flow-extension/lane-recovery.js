export const IMAGE_LANE_RETRY_BASE_MS = 30_000;
export const IMAGE_LANE_RETRY_MAX_MS = 5 * 60_000;

export function createLaneBlock(previous, error, now = Date.now()) {
  const failureCount = Math.max(0, Number(previous?.failureCount) || 0) + 1;
  const delayMs = Math.min(
    IMAGE_LANE_RETRY_BASE_MS * (2 ** (failureCount - 1)),
    IMAGE_LANE_RETRY_MAX_MS
  );

  return {
    at: new Date(now).toISOString(),
    retryAt: new Date(now + delayMs).toISOString(),
    failureCount,
    error: String(error || "Lỗi không xác định")
  };
}

export function canRetryLane(block, now = Date.now()) {
  if (!block) return true;
  const retryAt = Date.parse(block.retryAt || "");
  // Old extension versions created permanent blocks without retryAt. Treat
  // those as expired so upgrading/reloading automatically recovers the lane.
  return !Number.isFinite(retryAt) || retryAt <= now;
}
