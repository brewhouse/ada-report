#!/usr/bin/env node
// Import PRISM 2026 registrant spreadsheet into campaign clients
// Usage: node scripts/import-prism-campaign.js [--dry-run]

const path = require('path');
const XLSX  = require('xlsx');

const BASE      = 'https://adachecker.planeteria.com';
const USER      = 'admin';
const PASS      = 'inquiros2025';
const DRY_RUN   = process.argv.includes('--dry-run');
const XLSX_FILE = path.join(__dirname, '..', 'Registrant-Details---PRISM_2026__004_.xlsx');

// ── helpers ──────────────────────────────────────────────────────────────────

function parseName(fullName) {
  const s = String(fullName || '').trim();
  if (!s) return { firstName: '', lastName: '' };
  if (s.includes(',')) {
    const [last, ...rest] = s.split(',').map(p => p.trim());
    return { firstName: rest.join(' ').trim(), lastName: last };
  }
  const parts = s.split(/\s+/);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

function normalizeUrl(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '');
  if (!u.match(/^https?:\/\//)) u = 'https://' + u;
  return u;
}

function urlKey(url) {
  return url.toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

// ── parse spreadsheet ─────────────────────────────────────────────────────────

const wb   = XLSX.readFile(XLSX_FILE);
const ws   = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
// Row 0 = title, Row 1 = column headers, Row 2+ = data
const data = rows.slice(2).filter(r => r.__EMPTY_5 && r.__EMPTY_1);

const byKey = new Map(); // urlKey → { name, url, recipients[] }

for (const r of data) {
  const url  = normalizeUrl(r.__EMPTY_5);
  const key  = urlKey(url);
  const name = String(r.__EMPTY_2 || '').trim();

  if (!byKey.has(key)) {
    byKey.set(key, { name: name || url, url, recipients: [] });
  }
  const group = byKey.get(key);
  // Use first non-empty company name found for this site
  if (!group.name || group.name === group.url) {
    if (name) group.name = name;
  }

  const { firstName, lastName } = parseName(r.__EMPTY);
  const email = String(r.__EMPTY_1 || '').trim().toLowerCase();
  if (email && !group.recipients.find(x => x.email === email)) {
    group.recipients.push({ email, firstName, lastName });
  }
}

const groups = [...byKey.values()];
console.log(`Parsed ${groups.length} unique websites from ${data.length} rows`);

if (DRY_RUN) {
  groups.forEach(g => {
    console.log(`\n${g.name}\n  URL: ${g.url}\n  Recipients: ${g.recipients.length}`);
    g.recipients.forEach(r => console.log(`    ${r.firstName} ${r.lastName} <${r.email}>`));
  });
  console.log('\n[DRY RUN] No records created.');
  process.exit(0);
}

// ── API helpers ───────────────────────────────────────────────────────────────

let token = null;

async function login() {
  const res = await fetch(`${BASE}/api/campaign/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(`Login failed: ${d.error}`);
  token = d.token;
  console.log('Logged in OK');
}

function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

async function getExistingClients() {
  const res = await fetch(`${BASE}/api/campaign/clients`, { headers: authHeaders() });
  if (!res.ok) throw new Error('Failed to fetch existing clients');
  return res.json();
}

async function createClient(group) {
  const res = await fetch(`${BASE}/api/campaign/clients`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      name:       group.name,
      url:        group.url,
      fromEmail:  'noreply@planeteria.com',
      fromName:   'Planeteria Media',
      recipients: group.recipients,
    }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
  return d;
}

// ── main ──────────────────────────────────────────────────────────────────────

(async () => {
  await login();

  const existing = await getExistingClients();
  const existingKeys = new Set(existing.map(c => urlKey(c.url)));
  console.log(`Found ${existing.length} existing client(s)`);

  const toCreate = groups.filter(g => !existingKeys.has(urlKey(g.url)));
  const skipped  = groups.length - toCreate.length;
  console.log(`Will create ${toCreate.length} new record(s), skip ${skipped} duplicate(s)\n`);

  let created = 0, failed = 0;
  for (const group of toCreate) {
    try {
      await createClient(group);
      console.log(`✓  ${group.name} (${group.url}) — ${group.recipients.length} recipient(s)`);
      created++;
    } catch (err) {
      console.error(`✗  ${group.name} (${group.url}): ${err.message}`);
      failed++;
    }
    // Small delay to avoid hammering the server
    await new Promise(r => setTimeout(r, 80));
  }

  console.log(`\nDone. Created: ${created}, Failed: ${failed}, Skipped: ${skipped}`);
})();
