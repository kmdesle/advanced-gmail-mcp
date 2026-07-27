import { google, type Auth } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { URL } from 'url';
import {
  type AccountConfig,
  getAccounts,
  getCredentialsPath,
  getTokenPath,
  resolveAccount,
} from '../config.js';
import type { StoredToken } from './types.js';

/**
 * Expanded scopes: read, modify, send, compose.
 */
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];

const REDIRECT_URI = 'http://localhost:3005';

/**
 * Load GCP OAuth credentials from credentials.json at project root.
 */
export function loadCredentials() {
  const credPath = getCredentialsPath();

  if (!fs.existsSync(credPath)) {
    throw new Error(
      `credentials.json not found at ${credPath}. Download it from Google Cloud Console.`
    );
  }

  const content = fs.readFileSync(credPath, 'utf-8');
  const credentials = JSON.parse(content);
  return credentials.installed || credentials.web;
}

/**
 * Get an authenticated OAuth2Client for an account.
 */
export async function getAuthClient(account: AccountConfig): Promise<Auth.OAuth2Client> {
  const credentials = loadCredentials();

  const oauth2Client = new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    REDIRECT_URI,
  );

  const tokenPath = getTokenPath(account);

  if (!fs.existsSync(tokenPath)) {
    throw new Error(
      `No token for ${account.email}. Run: npx tsx src/auth.ts ${account.alias}`
    );
  }

  const token: StoredToken = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
  oauth2Client.setCredentials(token);

  // Refresh if expired (with 60s buffer)
  if (token.expiry_date && token.expiry_date < Date.now() + 60_000) {
    try {
      const { credentials: refreshed } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(refreshed);

      const tokenDir = path.dirname(tokenPath);
      if (!fs.existsSync(tokenDir)) {
        fs.mkdirSync(tokenDir, { recursive: true });
      }
      fs.writeFileSync(tokenPath, JSON.stringify(refreshed, null, 2));
    } catch (err) {
      throw new Error(
        `Token refresh failed for ${account.email}. Re-authenticate: npx tsx src/auth.ts ${account.alias}\n` +
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return oauth2Client;
}

/**
 * Interactive OAuth flow: opens URL, starts local callback server, saves token.
 */
export async function authenticateAccount(account: AccountConfig): Promise<void> {
  const credentials = loadCredentials();

  const oauth2Client = new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    REDIRECT_URI,
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    login_hint: account.email,
    prompt: 'consent',
  });

  console.log(`\nAuthenticating: ${account.email} (${account.alias})`);
  console.log(`\nOpen this URL in your browser:\n${authUrl}\n`);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '', 'http://localhost:3005');
        const code = url.searchParams.get('code');

        if (code) {
          const { tokens } = await oauth2Client.getToken(code);

          const tokenPath = getTokenPath(account);
          const tokenDir = path.dirname(tokenPath);
          if (!fs.existsSync(tokenDir)) {
            fs.mkdirSync(tokenDir, { recursive: true });
          }

          fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            `<h1>Success!</h1><p>Authenticated ${account.email} (${account.alias})</p><p>You can close this window.</p>`
          );

          server.close();
          console.log(`Token saved for ${account.email}`);
          resolve();
        }
      } catch (err) {
        res.writeHead(500);
        res.end('Authentication failed');
        server.close();
        reject(err);
      }
    });

    server.listen(3005, () => {
      console.log('Waiting for OAuth callback on http://localhost:3005...');
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('Authentication timed out after 5 minutes'));
    }, 5 * 60 * 1000);
  });
}

/**
 * Check authentication status of all accounts.
 */
export function checkAuthStatus(): void {
  const accounts = getAccounts();

  console.log('\nAccount Status:');
  console.log('─'.repeat(60));

  for (const account of accounts) {
    const tokenPath = getTokenPath(account);
    const exists = fs.existsSync(tokenPath);

    let status = 'NOT AUTHENTICATED';
    let scopeInfo = '';

    if (exists) {
      try {
        const token: StoredToken = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
        const expired = token.expiry_date && token.expiry_date < Date.now();
        const hasSendScope = token.scope?.includes('gmail.send');
        const hasComposeScope = token.scope?.includes('gmail.compose');

        status = expired ? 'EXPIRED (will auto-refresh)' : 'OK';
        scopeInfo = hasSendScope && hasComposeScope
          ? ' [send+compose]'
          : hasSendScope
            ? ' [send only]'
            : ' [read/modify only]';
      } catch {
        status = 'TOKEN CORRUPT';
      }
    }

    const icon = exists && status !== 'TOKEN CORRUPT' ? '+' : '-';
    console.log(
      `  ${icon} ${account.alias.padEnd(10)} ${account.email.padEnd(30)} ${status}${scopeInfo}`
    );
  }

  console.log('');
}
