// Accounts, in one dialog shared by the landing page and the calculator.
//
//   sign in / create account  ->  (new accounts) check your inbox: 6-digit code
//   forgot password           ->  code  ->  choose a new password
//
// New passwords show a strength meter and a checklist of the rules, ticked live.

import {
  resendSignupCode,
  sendPasswordReset,
  signInWithEmail,
  signInWithGoogle,
  signUpWithEmail,
  supabase,
  updatePassword,
  verifyEmailCode,
} from '../lib/supabase';
import { meetsAll, passwordChecks, strength } from '../lib/password';

type Step = 'signin' | 'signup' | 'verify' | 'reset' | 'reset-code' | 'update';

/** Digits in the emailed code (Supabase: Authentication, Email, "Email OTP length"). */
const CODE_LENGTH = 6;
/** Some projects send 8; the boxes grow to fit a longer code when one is entered. */
const MAX_CODE_LENGTH = 8;
const RESEND_SECONDS = 60;

const GOOGLE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.87h5.39a4.6 4.6 0 0 1-2 3.02v2.5h3.23c1.9-1.74 2.98-4.31 2.98-7.34Z"/><path d="M12 22c2.7 0 4.96-.9 6.62-2.43l-3.23-2.5c-.9.6-2.04.95-3.39.95-2.6 0-4.81-1.76-5.6-4.12H3.07v2.58A10 10 0 0 0 12 22Z"/><path d="M6.4 13.9a6 6 0 0 1 0-3.8V7.52H3.07a10 10 0 0 0 0 8.96L6.4 13.9Z"/><path d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.86-2.87A9.6 9.6 0 0 0 12 2 10 10 0 0 0 3.07 7.52L6.4 10.1C7.2 7.74 9.4 5.98 12 5.98Z"/></svg>';
const EYE =
  '<svg class="i-show" viewBox="0 0 20 20" aria-hidden="true"><path d="M1.8 10S4.8 4.5 10 4.5 18.2 10 18.2 10 15.2 15.5 10 15.5 1.8 10 1.8 10Z"/><circle cx="10" cy="10" r="2.6"/></svg><svg class="i-hide" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3l14 14M8.2 4.7A8.6 8.6 0 0 1 10 4.5c5.2 0 8.2 5.5 8.2 5.5a14 14 0 0 1-2.4 3M5.6 6.3C3.2 7.9 1.8 10 1.8 10s3 5.5 8.2 5.5a8 8 0 0 0 3.3-.7"/><path d="M8.2 8.3a2.6 2.6 0 0 0 3.5 3.5"/></svg>';
const TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';
const BACK = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5L7 10l5.5 5.5"/></svg>';
const MAIL =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3.8 7.2l8.2 6 8.2-6"/></svg>';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class AuthDialog {
  private dialog: HTMLDialogElement;
  private body: HTMLElement;
  private title: HTMLElement;
  private back: HTMLButtonElement;
  private step: Step = 'signin';
  private email = '';
  /**
   * The password just entered while signing up. If an emailed code is refused, it lets
   * us check whether the account was confirmed some other way (for example by a mail
   * scanner opening the email's link). Held in memory only, and only for this dialog.
   */
  private password = '';
  private reason = '';
  private resendTimer = 0;
  private resendAt = 0;

  constructor() {
    const d = document.createElement('dialog');
    d.className = 'sheet auth';
    d.setAttribute('aria-labelledby', 'auth-title');
    d.innerHTML = `
      <header class="auth-head">
        <button class="icon-btn auth-back" type="button" aria-label="Back">${BACK}</button>
        <h2 id="auth-title"></h2>
        <button class="icon-btn" type="button" data-close aria-label="Close">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" /></svg>
        </button>
      </header>
      <div class="auth-body"></div>`;
    document.body.append(d);
    this.dialog = d;
    this.body = d.querySelector('.auth-body')!;
    this.title = d.querySelector('#auth-title')!;
    this.back = d.querySelector('.auth-back')!;
    d.querySelector('[data-close]')!.addEventListener('click', () => this.close());
    d.addEventListener('click', (e) => e.target === d && this.close());
    d.addEventListener('close', () => clearInterval(this.resendTimer));
    // Confirming through the email's link (in this tab or another) signs the person in;
    // a dialog still waiting for the code then finishes by itself.
    supabase?.auth.onAuthStateChange((_event, session) => {
      if (session && this.dialog.open && this.step === 'verify') {
        setTimeout(() => this.done('Your email is confirmed. Welcome to Mathestra.'));
      }
    });
    this.back.addEventListener('click', () => {
      const to: Partial<Record<Step, Step>> = { verify: 'signup', reset: 'signin', 'reset-code': 'reset' };
      this.show(to[this.step] ?? 'signin');
    });
  }

  /** Open at a step, optionally saying why (e.g. "Sign in to save your graphs."). */
  open(step: 'signin' | 'signup' | 'update' = 'signin', reason = ''): void {
    this.reason = reason;
    this.show(step);
    if (!this.dialog.open) this.dialog.showModal();
    this.focusFirst();
  }

  close(): void {
    this.password = '';
    this.dialog.close();
  }

  // ---------- steps ----------

  private show(step: Step): void {
    this.step = step;
    clearInterval(this.resendTimer);
    const titles: Record<Step, string> = {
      signin: 'Welcome back',
      signup: 'Create your account',
      verify: 'Check your inbox',
      reset: 'Reset your password',
      'reset-code': 'Check your inbox',
      update: 'Choose a new password',
    };
    this.title.textContent = titles[step];
    this.back.hidden = !['verify', 'reset', 'reset-code'].includes(step);
    this.body.classList.remove('enter');
    void this.body.offsetWidth; // restart the entrance animation
    this.body.classList.add('enter');
    if (step === 'signin' || step === 'signup') this.renderCredentials(step);
    else if (step === 'verify' || step === 'reset-code') this.renderCode(step);
    else if (step === 'reset') this.renderReset();
    else this.renderNewPassword();
    if (this.dialog.open) this.focusFirst();
  }

  private focusFirst(): void {
    requestAnimationFrame(() => {
      const el = this.body.querySelector<HTMLElement>('[data-autofocus]') ?? this.body.querySelector<HTMLElement>('input');
      el?.focus({ preventScroll: true });
    });
  }

  private renderCredentials(step: 'signin' | 'signup'): void {
    const signup = step === 'signup';
    this.body.innerHTML = `
      ${this.reason ? `<p class="auth-reason">${esc(this.reason)}</p>` : ''}
      <div class="auth-tabs" role="tablist" aria-label="Account">
        <button type="button" role="tab" data-to="signin" aria-selected="${!signup}">Sign in</button>
        <button type="button" role="tab" data-to="signup" aria-selected="${signup}">Create account</button>
      </div>
      <button type="button" class="auth-google">${GOOGLE_ICON}<span>Continue with Google</span></button>
      <div class="auth-or"><span>or with email</span></div>
      <form class="auth-form" novalidate>
        <label class="auth-field">
          <span>Email</span>
          <input type="email" name="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" value="${esc(this.email)}" required />
        </label>
        ${passwordField(signup ? 'new-password' : 'current-password', signup)}
        ${signup ? '' : '<div class="auth-row-end"><button type="button" class="auth-link" data-to="reset">Forgot password?</button></div>'}
        <p class="auth-message" role="status" aria-live="polite" hidden></p>
        <button type="submit" class="auth-submit">${signup ? 'Create account' : 'Sign in'}</button>
        ${signup ? '<p class="auth-legal">By creating an account you agree to the <a href="/terms/" target="_blank" rel="noopener">Terms</a> and the <a href="/privacy/" target="_blank" rel="noopener">Privacy Policy</a>.</p>' : ''}
      </form>`;
    this.wireTabsAndLinks();
    const form = this.body.querySelector('form')!;
    const email = form.querySelector<HTMLInputElement>('input[name=email]')!;
    const password = form.querySelector<HTMLInputElement>('input[name=password]')!;
    if (signup) this.wireStrength(password);
    wireReveal(form);
    this.body.querySelector('.auth-google')!.addEventListener('click', () => this.google());
    // Returning with a known email: start in the password field.
    (this.email ? password : email).dataset.autofocus = '1';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      this.email = email.value.trim();
      if (!validEmail(this.email)) return this.say('Enter a valid email address.', true, email);
      if (signup && !meetsAll(password.value)) return this.say('Your password does not meet every requirement yet.', true, password);
      if (!signup && !password.value) return this.say('Enter your password.', true, password);
      await this.busy(async () => {
        if (signup) {
          this.password = password.value;
          const result = await signUpWithEmail(this.email, password.value);
          if (result === 'exists') return this.say('This email already has an account. Sign in instead.', true);
          if (result === 'signed-in') return this.done();
          this.show('verify');
        } else {
          try {
            await signInWithEmail(this.email, password.value);
            this.done();
          } catch (err) {
            // Never confirmed: send a fresh code and take them to enter it.
            if (/email not confirmed/i.test((err as Error).message)) {
              this.password = password.value;
              await resendSignupCode(this.email).catch(() => {});
              this.show('verify');
              return;
            }
            throw err;
          }
        }
      });
    });
  }

  private renderCode(step: 'verify' | 'reset-code'): void {
    this.body.innerHTML = `
      <div class="auth-mail">${MAIL}</div>
      <p class="auth-lede">Enter the ${CODE_LENGTH}-digit code we sent to <b>${esc(this.email)}</b>. It may take a minute to arrive.</p>
      <form class="auth-form" novalidate>
        <div class="otp">
          <input class="otp-input" data-autofocus inputmode="numeric" autocomplete="one-time-code" maxlength="${MAX_CODE_LENGTH}" aria-label="${CODE_LENGTH}-digit code" spellcheck="false" />
          <div class="otp-slots" aria-hidden="true">${'<span></span>'.repeat(MAX_CODE_LENGTH)}</div>
        </div>
        <p class="auth-message" role="status" aria-live="polite" hidden></p>
        <button type="submit" class="auth-submit" disabled>Verify</button>
      </form>
      <p class="auth-foot">
        <span class="auth-resend"></span>
        <button type="button" class="auth-link" data-to="${step === 'verify' ? 'signup' : 'reset'}">Use a different email</button>
      </p>`;
    this.wireTabsAndLinks();
    const form = this.body.querySelector('form')!;
    const input = form.querySelector<HTMLInputElement>('.otp-input')!;
    const slots = [...form.querySelectorAll<HTMLElement>('.otp-slots span')];
    const submit = form.querySelector<HTMLButtonElement>('.auth-submit')!;
    const otp = form.querySelector<HTMLElement>('.otp')!;
    otp.addEventListener('click', () => input.focus());

    const slotsBox = form.querySelector<HTMLElement>('.otp-slots')!;
    const paint = () => {
      const v = input.value;
      const long = v.length > CODE_LENGTH;
      slotsBox.classList.toggle('long', long);
      const shown = long ? MAX_CODE_LENGTH : CODE_LENGTH;
      slots.forEach((s, i) => {
        s.textContent = v[i] ?? '';
        s.classList.toggle('filled', i < v.length);
        s.classList.toggle('active', document.activeElement === input && i === Math.min(v.length, shown - 1));
      });
      submit.disabled = v.length < CODE_LENGTH;
    };
    const verify = () =>
      this.busy(async () => {
        try {
          await this.checkCode(input.value, step);
        } catch (err) {
          otp.classList.remove('shake');
          void otp.offsetWidth;
          otp.classList.add('shake');
          input.select();
          throw err;
        }
        if (step === 'verify') this.done('Your email is confirmed. Welcome to Mathestra.');
        else this.show('update');
      });
    // A full code verifies itself: at once for the longest form, and after a short pause
    // at the usual length, in case the code is longer and more digits are coming.
    let pending = 0;
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, MAX_CODE_LENGTH);
      this.say('');
      paint();
      clearTimeout(pending);
      if (input.value.length === MAX_CODE_LENGTH) void verify();
      else if (input.value.length === CODE_LENGTH) pending = window.setTimeout(() => void verify(), 650);
    });
    input.addEventListener('focus', paint);
    input.addEventListener('blur', paint);
    input.addEventListener('keyup', paint);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      clearTimeout(pending);
      if (input.value.length >= CODE_LENGTH) void verify();
    });
    paint();
    this.startResend(step);
  }

  /**
   * Check an emailed code. Supabase answers "expired or invalid" for several reasons;
   * for a new account the commonest is that it is already confirmed (a mail scanner
   * opened the email's link, which uses the code up). So before reporting failure we
   * try the other accepted code type, then simply sign in with the password just set.
   */
  private async checkCode(code: string, step: 'verify' | 'reset-code'): Promise<void> {
    if (step === 'reset-code') return verifyEmailCode(this.email, code, 'recovery');
    try {
      await verifyEmailCode(this.email, code, 'signup');
      return;
    } catch (first) {
      try {
        await verifyEmailCode(this.email, code, 'email');
        return;
      } catch {
        // fall through to the password check
      }
      if (this.password) {
        try {
          await signInWithEmail(this.email, this.password);
          return; // the account was confirmed already
        } catch {
          // not confirmed yet: report the original problem with the code
        }
      }
      throw first;
    }
  }

  private startResend(step: 'verify' | 'reset-code'): void {
    const el = this.body.querySelector<HTMLElement>('.auth-resend')!;
    this.resendAt = Date.now() + RESEND_SECONDS * 1000;
    const tick = () => {
      const left = Math.ceil((this.resendAt - Date.now()) / 1000);
      if (left > 0) {
        el.textContent = `Resend code in 0:${String(left).padStart(2, '0')}`;
        el.classList.add('waiting');
        return;
      }
      clearInterval(this.resendTimer);
      el.classList.remove('waiting');
      el.innerHTML = '<button type="button" class="auth-link">Resend code</button>';
      el.querySelector('button')!.addEventListener('click', () =>
        this.busy(async () => {
          if (step === 'verify') await resendSignupCode(this.email);
          else await sendPasswordReset(this.email);
          this.say('A new code is on its way.');
          this.startResend(step);
        }),
      );
    };
    clearInterval(this.resendTimer);
    this.resendTimer = window.setInterval(tick, 1000);
    tick();
  }

  private renderReset(): void {
    this.body.innerHTML = `
      <p class="auth-lede">Enter your email and we will send you a code to choose a new password.</p>
      <form class="auth-form" novalidate>
        <label class="auth-field">
          <span>Email</span>
          <input type="email" name="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" value="${esc(this.email)}" required />
        </label>
        <p class="auth-message" role="status" aria-live="polite" hidden></p>
        <button type="submit" class="auth-submit">Send code</button>
      </form>`;
    const form = this.body.querySelector('form')!;
    const email = form.querySelector<HTMLInputElement>('input[name=email]')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.email = email.value.trim();
      if (!validEmail(this.email)) return this.say('Enter a valid email address.', true, email);
      void this.busy(async () => {
        await sendPasswordReset(this.email);
        this.show('reset-code');
      });
    });
  }

  private renderNewPassword(): void {
    this.body.innerHTML = `
      <p class="auth-lede">You are signed in. Choose a new password for next time.</p>
      <form class="auth-form" novalidate>
        ${passwordField('new-password', true, 'New password')}
        <p class="auth-message" role="status" aria-live="polite" hidden></p>
        <button type="submit" class="auth-submit">Save password</button>
      </form>`;
    const form = this.body.querySelector('form')!;
    const password = form.querySelector<HTMLInputElement>('input[name=password]')!;
    this.wireStrength(password);
    wireReveal(form);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!meetsAll(password.value)) return this.say('Your password does not meet every requirement yet.', true, password);
      void this.busy(async () => {
        await updatePassword(password.value);
        this.done('Your new password is saved.');
      });
    });
  }

  // ---------- shared pieces ----------

  private wireTabsAndLinks(): void {
    this.body.querySelectorAll<HTMLElement>('[data-to]').forEach((b) =>
      b.addEventListener('click', () => {
        const email = this.body.querySelector<HTMLInputElement>('input[name=email]');
        if (email) this.email = email.value.trim();
        this.show(b.dataset.to as Step);
      }),
    );
  }

  /** Live meter and checklist under a new-password field. */
  private wireStrength(input: HTMLInputElement): void {
    const meter = this.body.querySelector<HTMLElement>('.pw-meter')!;
    const label = this.body.querySelector<HTMLElement>('.pw-label')!;
    const list = this.body.querySelector<HTMLElement>('.pw-checks')!;
    const submit = this.body.querySelector<HTMLButtonElement>('.auth-submit')!;
    const paint = () => {
      const s = strength(input.value);
      meter.dataset.score = String(s.score);
      label.textContent = s.label;
      list.innerHTML = passwordChecks(input.value)
        .map((c) => `<li class="${c.ok ? 'ok' : ''}"><span class="tick">${TICK}</span>${c.label}<span class="visually-hidden">${c.ok ? ', done' : ', not yet'}</span></li>`)
        .join('');
      submit.disabled = !meetsAll(input.value);
    };
    input.addEventListener('input', paint);
    paint();
  }

  private say(text: string, error = false, focus?: HTMLInputElement): void {
    const el = this.body.querySelector<HTMLElement>('.auth-message');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', error);
    el.hidden = !text;
    focus?.focus();
  }

  /** Run an action with the form disabled and a spinner on its button; errors are shown inline. */
  private async busy(run: () => Promise<void>): Promise<void> {
    const submit = this.body.querySelector<HTMLButtonElement>('.auth-submit');
    const controls = [...this.body.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')];
    controls.forEach((c) => (c.disabled = true));
    submit?.classList.add('loading');
    this.say('');
    try {
      await run();
    } catch (e) {
      this.say(friendly(e), true);
    } finally {
      if (this.dialog.open) {
        controls.forEach((c) => (c.disabled = false));
        submit?.classList.remove('loading');
        // A code form keeps its button off until all digits are in.
        const otp = this.body.querySelector<HTMLInputElement>('.otp-input');
        if (otp && submit) submit.disabled = otp.value.length < CODE_LENGTH;
        const pw = this.body.querySelector<HTMLInputElement>('input[autocomplete=new-password]');
        if (pw && submit) submit.disabled = !meetsAll(pw.value);
      }
    }
  }

  private async google(): Promise<void> {
    await this.busy(() => signInWithGoogle()); // leaves for Google on success
  }

  private done(message = ''): void {
    this.password = '';
    this.close();
    if (!message) return;
    // Kept for the calculator to show, even if signing in here moves to another page.
    try {
      sessionStorage.setItem('mathestra:notice', message);
    } catch {
      // private mode: the event below still reaches this page
    }
    document.dispatchEvent(new CustomEvent('mathestra:notice', { detail: message }));
  }
}

function passwordField(autocomplete: string, withStrength: boolean, label = 'Password'): string {
  return `
    <label class="auth-field">
      <span>${label}</span>
      <span class="pw-wrap">
        <input type="password" name="password" autocomplete="${autocomplete}" autocapitalize="off" spellcheck="false" required ${withStrength ? 'aria-describedby="pw-rules"' : ''} />
        <button type="button" class="pw-reveal" aria-label="Show password" aria-pressed="false">${EYE}</button>
      </span>
    </label>
    ${
      withStrength
        ? `<div class="pw-strength" id="pw-rules">
            <div class="pw-meter" data-score="0" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
            <span class="pw-label" aria-live="polite"></span>
            <ul class="pw-checks"></ul>
          </div>`
        : ''
    }`;
}

function wireReveal(form: HTMLElement): void {
  const button = form.querySelector<HTMLButtonElement>('.pw-reveal');
  const input = form.querySelector<HTMLInputElement>('input[name=password]');
  if (!button || !input) return;
  button.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the caret in the field
  button.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(show));
    button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
}

const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (!supabase) return 'Accounts are not available on this copy of Mathestra.';
  if (/invalid login credentials/i.test(msg)) return 'The email or password is incorrect.';
  // Supabase cannot tell a mistyped code from an old one, so neither can we.
  if (/expired or is invalid|otp_expired/i.test(msg)) return 'That code is wrong or has expired. Check it, or send a new one.';
  if (/expired/i.test(msg)) return 'That code has expired. Send a new one.';
  if (/invalid.*(token|otp)|token.*invalid|otp.*invalid/i.test(msg)) return 'That code is not right. Check the email and try again.';
  if (/already registered/i.test(msg)) return 'This email already has an account. Sign in instead.';
  if (/weak|pwned|leaked/i.test(msg)) return 'Choose a stronger password; this one appears in known data breaches.';
  if (/provider is not enabled/i.test(msg)) return 'Google sign-in is not switched on for this site yet.';
  if (/rate limit|too many|security purposes/i.test(msg)) return 'Too many attempts. Wait a minute, then try again.';
  if (/network|fetch/i.test(msg)) return 'The server could not be reached. Check your connection.';
  return msg;
}
