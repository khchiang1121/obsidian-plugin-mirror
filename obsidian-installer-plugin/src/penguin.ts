const PENGUIN_SVG = `
<svg width="100%" height="100%" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="36" cy="67" rx="16" ry="3" fill="#000" opacity="0.15"/>
  <path d="M36 6c-15 0-24 15-24 34 0 15 10 26 24 26s24-11 24-26C60 21 51 6 36 6z" fill="#1c1c1e"/>
  <path d="M14 26c-7 4-9 14-4 20 3 4 9 4 11-1" fill="#1c1c1e"/>
  <path d="M58 26c7 4 9 14 4 20-3 4-9 4-11-1" fill="#1c1c1e"/>
  <path d="M36 18c-9 0-15 11-15 24 0 11 7 18 15 18s15-7 15-18c0-13-6-24-15-24z" fill="#f5f6f7"/>
  <circle cx="29" cy="23" r="3.2" fill="#1c1c1e"/>
  <circle cx="43" cy="23" r="3.2" fill="#1c1c1e"/>
  <circle cx="30" cy="22" r="1.1" fill="#fff"/>
  <circle cx="44" cy="22" r="1.1" fill="#fff"/>
  <path d="M31 28 L41 28 L36 35 Z" fill="#f5a623"/>
  <ellipse cx="23" cy="66" rx="8" ry="3.5" fill="#f5a623"/>
  <ellipse cx="49" cy="66" rx="8" ry="3.5" fill="#f5a623"/>
</svg>`.trim();

export interface PenguinController {
  stop(): void;
}

export interface PenguinOptions {
  /** Master on/off — if false, this is a no-op and nothing is ever scheduled. */
  enabled: boolean;
  /**
   * By default, prefers-reduced-motion (read from the OS/desktop
   * environment via matchMedia — not an Obsidian setting) suppresses the
   * penguin entirely, per standard accessibility practice. Set true to show
   * it anyway.
   */
  ignoreReducedMotion: boolean;
}

/**
 * Purely decorative: a custom SVG penguin (not an emoji, for size and
 * consistent rendering) walks across the bottom of boundsEl's visible area
 * once, then disappears — repeating at random intervals while the settings
 * tab stays open. Uses the Web Animations API directly rather than a CSS
 * keyframes/stylesheet, since this project never ships a styles.css — walk
 * (position) and waddle (rotate/bob) are two separate Animation objects on
 * two different properties of the same element, so they run concurrently
 * without one overwriting the other.
 *
 * container is where the element is appended (should be outside boundsEl,
 * e.g. document.body — boundsEl gets emptied on every settings re-render,
 * which would otherwise kill a mid-walk penguin); boundsEl's own
 * getBoundingClientRect() defines the walking lane, so it stays visually
 * confined to that element (the plugin's own settings content) rather than
 * crossing the whole Obsidian window.
 *
 * Call stop() to cancel any pending/in-flight penguin — see settingsTab.ts's
 * hide() and its settings-change handlers.
 */
export function startWalkingPenguin(
  container: HTMLElement,
  boundsEl: HTMLElement,
  options: PenguinOptions
): PenguinController {
  let stopped = false;
  let timeoutId: number | undefined;
  let activeWalk: Animation | undefined;
  let activeWaddle: Animation | undefined;
  let activeEl: HTMLElement | undefined;

  if (!options.enabled) {
    return { stop(): void {} };
  }

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion && !options.ignoreReducedMotion) {
    return { stop(): void {} };
  }

  function scheduleNext(first = false): void {
    if (stopped) return;
    // First appearance waits until the tab has clearly been open for a
    // while (not an instant "gotcha" on open); later ones stay spaced out
    // randomly so it reads as an occasional surprise, not a fixed cadence.
    const delay = first ? 10000 : 20000 + Math.random() * 40000;
    timeoutId = window.setTimeout(spawn, delay);
  }

  function spawn(): void {
    if (stopped) return;
    const rect = boundsEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      // Settings tab isn't actually visible right now (e.g. a different tab
      // is active) — skip this cycle and check again next time rather than
      // spawning somewhere meaningless.
      scheduleNext();
      return;
    }

    const size = 90;
    const reverse = Math.random() < 0.5;
    const duration = 9000 + Math.random() * 5000;
    // Stays fully inside [rect.left, rect.right] the whole time — no
    // off-screen entrance/exit flourish, since that portion of the path
    // would extend past the settings modal's own visible chrome, not just
    // past boundsEl itself.
    const startX = reverse ? rect.right - size : rect.left;
    const endX = reverse ? rect.left : rect.right - size;
    const topY = Math.max(rect.top, rect.bottom - size - 12);
    const flip = reverse ? 'scaleX(-1) ' : '';

    const wrapper = container.createDiv();
    wrapper.style.position = 'fixed';
    wrapper.style.top = `${topY}px`;
    wrapper.style.left = `${startX}px`;
    wrapper.style.width = `${size}px`;
    wrapper.style.height = `${size}px`;
    // Obsidian's own modal likely sits inside its own stacking context (its
    // open/close animation transforms the container), which can trap a
    // "normal" z-index below it regardless of the number used — go high
    // enough that this stays visible even if it ends up in that context too.
    wrapper.style.zIndex = '999999';
    wrapper.style.pointerEvents = 'none';
    wrapper.style.filter = 'drop-shadow(0 3px 3px rgba(0,0,0,0.3))';
    wrapper.innerHTML = PENGUIN_SVG;

    activeEl = wrapper;
    activeWalk = wrapper.animate([{ left: `${startX}px` }, { left: `${endX}px` }], {
      duration,
      easing: 'linear',
      fill: 'forwards',
    });
    activeWaddle = wrapper.animate(
      [
        { transform: `${flip}translateY(0) rotate(0deg)` },
        { transform: `${flip}translateY(-8px) rotate(${reverse ? 6 : -6}deg)` },
        { transform: `${flip}translateY(0) rotate(0deg)` },
      ],
      { duration: 380, iterations: Infinity }
    );

    activeWalk.onfinish = () => {
      activeWaddle?.cancel();
      wrapper.remove();
      activeEl = undefined;
      activeWalk = undefined;
      activeWaddle = undefined;
      scheduleNext();
    };
  }

  scheduleNext(true);

  return {
    stop(): void {
      stopped = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (activeWalk) activeWalk.onfinish = null;
      activeWalk?.cancel();
      activeWaddle?.cancel();
      activeEl?.remove();
    },
  };
}
