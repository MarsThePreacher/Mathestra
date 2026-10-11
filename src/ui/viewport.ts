// Keeps the page usable when a phone's own keyboard opens (for text boxes such as the
// title or the sign-in form; equations use Mathestra's keypad instead).
//
// It publishes two CSS variables on <html>:
//   --vvh  the height of the part of the page you can actually see
//   --kb   how much of the bottom the keyboard covers
// and sets the class "kb-open" while a keyboard is up. Whatever has focus is then
// scrolled into the visible part, which browsers do not reliably do on their own.

const EDITABLE = 'input:not([type=range]):not([type=checkbox]):not([type=file]), textarea, [contenteditable]';

export function trackViewport(): void {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) return;

  let raf = 0;
  let reason: 'focus' | 'resize' | 'scroll' = 'resize';
  // Tallest visible height seen at this width: the screen with no keyboard. Comparing
  // against it works whether the browser shrinks the page for the keyboard (Android)
  // or overlays it (iOS).
  let full = vv.height;
  let width = vv.width;
  let wasOpen = false;
  let lastHeight = vv.height;

  const update = () => {
    raf = 0;
    if (Math.abs(vv.width - width) > 1) {
      width = vv.width; // rotated or resized: start over
      full = vv.height;
    }
    full = Math.max(full, vv.height);
    const covered = Math.max(0, full - vv.height);
    root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    root.style.setProperty('--kb', `${Math.round(Math.max(0, window.innerHeight - vv.height - vv.offsetTop))}px`);
    const open = covered > 120 && document.activeElement?.matches(EDITABLE) === true;
    root.classList.toggle('kb-open', open);
    // Bring the field into view when the keyboard appears or changes size, or focus
    // moves; never while the person is scrolling the page themselves.
    const resized = Math.abs(vv.height - lastHeight) > 1;
    if (open && (!wasOpen || resized || reason === 'focus')) reveal(document.activeElement as HTMLElement);
    wasOpen = open;
    lastHeight = vv.height;
  };
  const schedule = (why: typeof reason) => () => {
    reason = why;
    if (!raf) raf = requestAnimationFrame(update);
  };
  vv.addEventListener('resize', schedule('resize'));
  vv.addEventListener('scroll', schedule('scroll'));
  // The keyboard opens a moment after focus; check again once it has settled.
  document.addEventListener('focusin', (e) => {
    if (!(e.target as HTMLElement).matches?.(EDITABLE)) return;
    schedule('focus')();
    setTimeout(schedule('focus'), 350);
  });
  document.addEventListener('focusout', () => setTimeout(schedule('resize'), 50));
  update();
}

/**
 * Scroll an element into the part of the screen the keyboard leaves visible: below
 * anything pinned to the top (the calculator's screen on phones) and above the
 * keyboard. A whole expression line is revealed, not just its text.
 */
function reveal(el: HTMLElement): void {
  const vv = window.visualViewport!;
  const target = el.closest<HTMLElement>('.row') ?? el;
  // Inside a scrolling panel or dialog, let it bring the element into its own view first.
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = target.getBoundingClientRect();
  const pinned = document.querySelector<HTMLElement>('.stage');
  const pinnedBottom = pinned && getComputedStyle(pinned).position === 'sticky' ? pinned.getBoundingClientRect().bottom : 0;
  const top = Math.max(vv.offsetTop, pinnedBottom) + 8;
  const bottom = vv.offsetTop + vv.height - 12;
  if (r.bottom > bottom) window.scrollBy({ top: r.bottom - bottom, behavior: 'smooth' });
  else if (r.top < top) window.scrollBy({ top: r.top - top, behavior: 'smooth' });
}
