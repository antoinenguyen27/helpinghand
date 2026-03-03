export function safeJsonParse(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function isAffirmative(text = '') {
  return /\b(yes|yep|ok|okay|confirm|do it|go ahead|that'?s right|correct|save it|looks good)\b/i.test(text);
}

export function isNegative(text = '') {
  return /\b(no|cancel|stop|don'?t|do not|wait|not now)\b/i.test(text);
}

export function isIrreversible(text = '') {
  return /\b(send|delete|remove|publish|submit|transfer|pay|purchase|checkout|post)\b/i.test(text);
}

export function normalizeDomain(urlString = '') {
  try {
    return new URL(urlString).hostname;
  } catch {
    return 'unknown.local';
  }
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
