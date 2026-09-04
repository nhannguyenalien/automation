const FLOW_HOSTS = new Set(["labs.google", "flow.google.com"]);

export function parseFlowUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !FLOW_HOSTS.has(url.hostname)) return null;
    const match = url.pathname.match(/(?:\/tools\/flow)?\/project\/([^/]+)(?:\/scene\/([^/]+))?/);
    if (!match) return null;
    return { url, projectId: match[1], sceneId: match[2] || null };
  } catch {
    return null;
  }
}

export function flowProjectRoot(value) {
  const parsed = parseFlowUrl(value);
  if (!parsed) return "";
  return parsed.url.hostname === "flow.google.com"
    ? `https://flow.google.com/project/${parsed.projectId}`
    : `${parsed.url.origin}${parsed.url.pathname.match(/^(.*\/tools\/flow\/project\/[^/]+)/)[1]}`;
}

export function isSameFlowProject(first, second) {
  const left = parseFlowUrl(first);
  const right = parseFlowUrl(second);
  return Boolean(left && right && left.projectId === right.projectId);
}
