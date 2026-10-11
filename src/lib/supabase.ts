// Supabase client, plus small typed helpers for accounts and saved graphs.
// Only the project URL and the publishable key ever reach the browser; row level
// security (supabase/schema.sql) is what keeps each person's graphs private.

import { createClient, type Session, type User } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/** Null when the site is built without Supabase settings; the calculator still works, just without accounts. */
export const supabase =
  url && key
    ? createClient(url, key, {
        auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      })
    : null;

export type { Session, User };

/** Where people land after Google, email confirmation or a password reset link. */
export const appUrl = () => new URL(`${import.meta.env.BASE_URL}app/`, location.origin).href;

// ---------- accounts ----------

export type AuthEvent = 'signed-in' | 'signed-out' | 'recovery' | 'updated';

export function onAuthChange(fn: (user: User | null, event: AuthEvent) => void): void {
  if (!supabase) return fn(null, 'signed-out');
  supabase.auth.onAuthStateChange((event, session) => {
    const user = session?.user ?? null;
    // Defer: Supabase recommends not awaiting other calls inside this callback.
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY') fn(user, 'recovery');
      else if (event === 'USER_UPDATED') fn(user, 'updated');
      else fn(user, user ? 'signed-in' : 'signed-out');
    });
  });
}

export async function currentUser(): Promise<User | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}

function client() {
  if (!supabase) throw new Error('Accounts are not set up on this site.');
  return supabase;
}

export async function signInWithGoogle(): Promise<void> {
  const { error } = await client().auth.signInWithOAuth({ provider: 'google', options: { redirectTo: appUrl() } });
  if (error) throw error;
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  const { error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw error;
}

/**
 * Create an account. "verify" means a code is on its way to the inbox; "exists" means
 * the address already has a confirmed account (Supabase reports that without an error,
 * so nobody can probe which addresses are registered).
 */
export async function signUpWithEmail(email: string, password: string): Promise<'verify' | 'signed-in' | 'exists'> {
  const { data, error } = await client().auth.signUp({ email, password, options: { emailRedirectTo: appUrl() } });
  if (error) throw error;
  if (data.session) return 'signed-in';
  if (data.user && data.user.identities?.length === 0) return 'exists';
  return 'verify';
}

/** Send the sign-up code again. */
export async function resendSignupCode(email: string): Promise<void> {
  const { error } = await client().auth.resend({ type: 'signup', email, options: { emailRedirectTo: appUrl() } });
  if (error) throw error;
}

/** Check an emailed code; on success the person is signed in. */
export async function verifyEmailCode(email: string, token: string, type: 'signup' | 'email' | 'recovery'): Promise<void> {
  const { error } = await client().auth.verifyOtp({ email, token, type });
  if (error) throw error;
}

export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await client().auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
  if (error) throw error;
}

export async function updatePassword(password: string): Promise<void> {
  const { error } = await client().auth.updateUser({ password });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  const { error } = await client().auth.signOut();
  if (error) throw error;
}

export function displayName(user: User): string {
  const meta = user.user_metadata as { full_name?: string; name?: string };
  return meta.full_name || meta.name || user.email || 'Account';
}

export function avatarUrl(user: User): string | null {
  const meta = user.user_metadata as { avatar_url?: string; picture?: string };
  return meta.avatar_url || meta.picture || null;
}

// ---------- saved graphs ----------

export interface GraphRow {
  id: string;
  title: string;
  data: string;
  updated_at: string;
}

/** Turn Supabase errors into sentences people can act on. */
function explain(error: { code?: string; message: string }): Error {
  if (error.code === 'PGRST205' || error.code === '42P01')
    return new Error('Saving isn’t set up yet: run supabase/schema.sql in the Supabase SQL editor.');
  if (error.code === 'PGRST116') return new Error('That graph doesn’t exist, or it belongs to another account.');
  if (error.code === '23514' && /graphs_data_check/.test(error.message))
    return new Error('This graph is too large to save to your account. Its link still opens it anywhere.');
  return new Error(error.message);
}

export async function listGraphs(): Promise<GraphRow[]> {
  const { data, error } = await client()
    .from('graphs')
    .select('id, title, data, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw explain(error);
  return data;
}

export async function getGraph(id: string): Promise<GraphRow> {
  const { data, error } = await client().from('graphs').select('id, title, data, updated_at').eq('id', id).single();
  if (error) throw explain(error);
  return data;
}

export async function createGraph(title: string, data: string): Promise<GraphRow> {
  const { data: row, error } = await client()
    .from('graphs')
    .insert({ title, data })
    .select('id, title, data, updated_at')
    .single();
  if (error) throw explain(error);
  return row;
}

export async function updateGraph(id: string, title: string, data: string): Promise<void> {
  const { error } = await client().from('graphs').update({ title, data }).eq('id', id);
  if (error) throw explain(error);
}

export async function deleteGraph(id: string): Promise<void> {
  const { error } = await client().from('graphs').delete().eq('id', id);
  if (error) throw explain(error);
}
