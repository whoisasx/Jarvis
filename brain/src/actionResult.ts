export function parseActionResult(result: string): {success: boolean; data: unknown} {
  const trimmed = result.trim();
  if (/^failed:/i.test(trimmed)) {
    return {success: false, data: trimmed.replace(/^failed:\s*/i, '')};
  }
  if (/^not_found:?$/i.test(trimmed) || /^not found:/i.test(trimmed)) {
    return {success: false, data: trimmed};
  }
  if (/^found:/i.test(trimmed)) {
    const payload = trimmed.replace(/^found:\s*/i, '');
    const parsed = parseMaybeJson(payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {success: true, data: {ok: true, ...parsed as Record<string, unknown>}};
    }
    return {success: true, data: {ok: true, elementId: payload, found: payload}};
  }
  if (/^success:/i.test(trimmed)) {
    const payload = trimmed.replace(/^success:\s*/i, '');
    return {success: true, data: normalizeSuccessData(parseMaybeJson(payload))};
  }
  if (/^success$/i.test(trimmed) || /^ok$/i.test(trimmed)) {
    return {success: true, data: {ok: true}};
  }
  if (/^failed$/i.test(trimmed)) {
    return {success: false, data: trimmed};
  }
  return {success: true, data: normalizeSuccessData(parseMaybeJson(trimmed))};
}

export function inferErrorCode(result: string): string {
  if (/ELEMENT_STALE/i.test(result)) return 'ELEMENT_STALE';
  if (/INPUT_NOT_FOCUSED/i.test(result)) return 'INPUT_NOT_FOCUSED';
  if (/NO_ACTIVE_CALL/i.test(result)) return 'NO_ACTIVE_CALL';
  if (/PACKAGE_NOT_LAUNCHABLE/i.test(result)) return 'PACKAGE_NOT_LAUNCHABLE';
  if (/SHADE_OPENED/i.test(result)) return 'SHADE_OPENED';
  if (/NO_SMS_APP/i.test(result)) return 'NO_SMS_APP';
  if (/NOT_DEFAULT_SMS_APP/i.test(result)) return 'NOT_DEFAULT_SMS_APP';
  if (/COMPOSE_UNAVAILABLE/i.test(result)) return 'COMPOSE_UNAVAILABLE';
  if (/NO_VISIBLE_CHANGE/i.test(result)) return 'NO_VISIBLE_CHANGE';
  if (/MATCH_AMBIGUOUS/i.test(result)) return 'MATCH_AMBIGUOUS';
  if (/CHOOSER_AMBIGUOUS/i.test(result)) return 'CHOOSER_AMBIGUOUS';
  if (/CONFIRMATION_REQUIRED/i.test(result)) return 'CONFIRMATION_REQUIRED';
  if (/not found|ELEMENT_NOT_FOUND/i.test(result)) return 'ELEMENT_NOT_FOUND';
  if (/permission/i.test(result)) return 'PERMISSION_DENIED';
  if (/secure|lock/i.test(result)) return 'SCREEN_BLOCKED';
  return 'ANDROID_ACTION_FAILED';
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeSuccessData(data: unknown): unknown {
  if (data === true || data === 'ok' || data === 'success') return {ok: true};
  if (Array.isArray(data) || typeof data !== 'object' || data === null) return data;
  const record = data as Record<string, unknown>;
  if (record.ok === undefined) return {ok: true, ...record};
  return data;
}
