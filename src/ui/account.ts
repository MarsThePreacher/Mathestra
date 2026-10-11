// The account control in a top bar: "Sign in" when signed out, an avatar with
// a menu when signed in. Shared by the landing page and the calculator.

import { avatarUrl, displayName, signOut, type User } from '../lib/supabase';
import type { AuthDialog } from './authDialog';

export interface AccountAction {
  label: string;
  run: () => void;
}

export class AccountControl {
  private user: User | null = null;
  private menu: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;

  constructor(
    private root: HTMLElement,
    private auth: AuthDialog,
    private actions: () => AccountAction[] = () => [],
    private onSignedOut: () => void = () => {},
  ) {
    root.classList.add('account');
    document.addEventListener('pointerdown', (e) => {
      if (this.menu && !root.contains(e.target as Node)) this.setOpen(false);
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) {
        this.setOpen(false);
        this.button?.focus();
      }
    });
    this.render();
  }

  setUser(user: User | null): void {
    this.user = user;
    this.render();
  }

  private isOpen(): boolean {
    return !!this.menu?.classList.contains('open');
  }

  private setOpen(open: boolean): void {
    if (!this.menu || !this.button) return;
    this.menu.classList.toggle('open', open);
    this.button.setAttribute('aria-expanded', String(open));
    if (open) (this.menu.querySelector('button') as HTMLElement | null)?.focus();
  }

  private render(): void {
    this.root.replaceChildren();
    this.menu = null;
    const user = this.user;
    if (!user) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ghost';
      b.textContent = 'Sign in';
      b.addEventListener('click', () => this.auth.open('signin'));
      this.root.append(b);
      return;
    }

    const name = displayName(user);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'avatar-btn';
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-label', `Account: ${name}`);
    b.title = name;
    const pic = avatarUrl(user);
    if (pic) {
      const img = document.createElement('img');
      img.src = pic;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.replaceWith(document.createTextNode(initial(name))));
      b.append(img);
    } else {
      b.textContent = initial(name);
    }
    b.addEventListener('click', () => this.setOpen(!this.isOpen()));

    const menu = document.createElement('div');
    menu.className = 'menu-pop';
    menu.setAttribute('role', 'menu');
    const head = document.createElement('div');
    head.className = 'account-head';
    head.innerHTML = '<b></b><span></span>';
    head.querySelector('b')!.textContent = name;
    head.querySelector('span')!.textContent = user.email && user.email !== name ? user.email : 'Signed in';
    menu.append(head);

    const item = (label: string, run: () => void) => {
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'menu-item';
      it.setAttribute('role', 'menuitem');
      it.innerHTML = '<b></b>';
      it.querySelector('b')!.textContent = label;
      it.addEventListener('click', () => {
        this.setOpen(false);
        run();
      });
      menu.append(it);
    };
    for (const a of this.actions()) item(a.label, a.run);
    item('Sign out', async () => {
      try {
        await signOut();
      } finally {
        this.onSignedOut();
      }
    });

    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll<HTMLElement>('.menu-item')];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
      else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
      else return;
      e.preventDefault();
    });

    this.root.append(b, menu);
    this.button = b;
    this.menu = menu;
  }
}

function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}
