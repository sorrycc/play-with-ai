// The login behind every other API route: one admin password, remembered in a cookie.

import crypto from 'node:crypto';

const COOKIE = 'pwa_auth';
const MAX_AGE_S = 60 * 60 * 24 * 7;

function same(a, b) {
  const [x, y] = [a, b].map((s) => crypto.createHash('sha256').update(s).digest());
  return crypto.timingSafeEqual(x, y);
}

export function createAuth(env) {
  const password = (env.ADMIN_PASSWORD || '').trim() || '12306';
  // Derived from the password, so nothing is stored and changing the password signs everyone out.
  const token = crypto.createHmac('sha256', password).update('play-with-ai').digest('hex');

  return {
    passwordOk: (given) => typeof given === 'string' && same(given, password),
    authed(cookieHeader) {
      const value = (cookieHeader ?? '')
        .split(';')
        .map((part) => part.trim().split('='))
        .find(([name]) => name === COOKIE)?.[1];
      return value !== undefined && same(value, token);
    },
    loginCookie: (secure) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`,
    logoutCookie: `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  };
}
