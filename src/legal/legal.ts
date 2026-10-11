// Privacy, Terms and not-found pages: theme switch, nav shadow on scroll, and the
// contents list that follows the section being read.

import './legal.css';
import { trackViewport } from '../ui/viewport';

function effectiveTheme(): 'light' | 'dark' {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(): void {
  const color = effectiveTheme() === 'dark' ? '#111111' : '#efefef';
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', color));
}

document.getElementById('theme-btn')?.addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('mathestra:theme', next);
  } catch {
    // ignore
  }
  applyTheme();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
applyTheme();
trackViewport();

const nav = document.querySelector('.page-nav');
const onScroll = () => nav?.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// Highlight the contents entry for the section currently on screen.
const links = new Map<string, HTMLAnchorElement>();
document.querySelectorAll<HTMLAnchorElement>('.toc a[href^="#"]').forEach((a) => links.set(a.hash.slice(1), a));
if (links.size) {
  const visible = new Set<string>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id);
      const first = [...links.keys()].find((id) => visible.has(id));
      if (!first) return;
      links.forEach((a, id) => {
        a.classList.toggle('current', id === first);
        if (id === first) a.setAttribute('aria-current', 'location');
        else a.removeAttribute('aria-current');
      });
    },
    { rootMargin: '-80px 0px -55% 0px' },
  );
  links.forEach((_a, id) => {
    const section = document.getElementById(id);
    if (section) observer.observe(section);
  });
}
