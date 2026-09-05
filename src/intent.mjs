// Intent policy: when preparation is worth doing at all.
//
// The fleet default is NOT "prepare everything on every marketing page". A marketing page
// serves its own content first and prepares one destination when the visitor shows they are
// heading there. Signals differ by device: hover does not exist on a phone, so touch and
// viewport proximity carry the same meaning there.

const DEFAULTS = Object.freeze({
  /** Wait this long after the signal before preparing, so a passing cursor costs nothing. */
  dwellMs: 120,
  /** Prepare at most this many distinct apps from one page. */
  maxApps: 1,
  /** Also prepare when the trigger has been visible for a while (the mobile path). */
  visibilityMs: 2_000,
});

/**
 * Wire intent signals on the elements that lead into an application.
 *
 * `triggers` is a list of `{ element, appId }`. Returns a disposer.
 *
 * Every listener is passive and cancellable: moving away before `dwellMs` prepares nothing,
 * and leaving the page cancels whatever is in flight.
 */
export function observeIntent(coordinator, triggers, options = {}) {
  const { dwellMs, maxApps, visibilityMs } = { ...DEFAULTS, ...options };
  const env = options.env ?? {};
  const doc = env.document;
  const started = new Set();
  const timers = new Map();
  const disposers = [];

  const begin = (appId) => {
    if (started.has(appId) || started.size >= maxApps) return;
    started.add(appId);
    coordinator.prepare(appId).catch(() => {
      // Preparation failing is a non-event: activation still works from cold.
      started.delete(appId);
    });
  };

  const arm = (appId, delay) => {
    if (timers.has(appId)) return;
    timers.set(appId, setTimeout(() => {
      timers.delete(appId);
      begin(appId);
    }, delay));
  };

  const disarm = (appId) => {
    const t = timers.get(appId);
    if (t) {
      clearTimeout(t);
      timers.delete(appId);
    }
  };

  for (const { element, appId } of triggers) {
    const onEnter = () => arm(appId, dwellMs);
    const onLeave = () => disarm(appId);
    // Pointer down is the strongest signal short of the click itself: prepare immediately.
    const onDown = () => {
      disarm(appId);
      begin(appId);
    };
    element.addEventListener('pointerenter', onEnter, { passive: true });
    element.addEventListener('focus', onEnter, { passive: true });
    element.addEventListener('pointerleave', onLeave, { passive: true });
    element.addEventListener('blur', onLeave, { passive: true });
    element.addEventListener('pointerdown', onDown, { passive: true });
    disposers.push(() => {
      element.removeEventListener('pointerenter', onEnter);
      element.removeEventListener('focus', onEnter);
      element.removeEventListener('pointerleave', onLeave);
      element.removeEventListener('blur', onLeave);
      element.removeEventListener('pointerdown', onDown);
    });
  }

  // The touch path: a trigger that stays on screen means the visitor is reading about it.
  if (typeof IntersectionObserver === 'function' && triggers.length) {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const match = triggers.find((t) => t.element === entry.target);
        if (!match) continue;
        if (entry.isIntersecting) arm(match.appId, visibilityMs);
        else disarm(match.appId);
      }
    }, { rootMargin: '0px 0px -25% 0px' });
    for (const { element } of triggers) io.observe(element);
    disposers.push(() => io.disconnect());
  }

  if (doc) {
    const onHide = () => {
      if (doc.visibilityState === 'hidden') for (const appId of started) coordinator.cancel(appId);
    };
    doc.addEventListener('visibilitychange', onHide);
    disposers.push(() => doc.removeEventListener('visibilitychange', onHide));
  }

  return () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    for (const d of disposers) d();
  };
}
