import { readdirSync, readlinkSync, lstatSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── /tmp janitor ──────────────────────────────────────────────────────────────
// Render caps the /tmp volume at 2GB and replaces the instance when it fills.
//
// Every Chromium teardown path in this app is a SIGKILL (see closeBrowser and
// killAllChrome in lighthouse-runner.js), and SIGKILL cannot be trapped — so
// Chromium never runs its own exit cleanup and abandons whatever it left in
// /tmp.  Two things pile up:
//
//   • Puppeteer profile dirs.  With no userDataDir set, every launch() mints a
//     fresh /tmp/puppeteer_dev_chrome_profile-XXXX.  Puppeteer cleans these on
//     process exit, but killAllChrome() kills Chrome processes Puppeteer has no
//     handle on, so those dirs are simply orphaned.
//   • Chromium's own temp files (.org.chromium.Chromium.XXXXXX).  We pass
//     --disable-dev-shm-usage everywhere, which pushes Chromium's shared-memory
//     segments out of /dev/shm and into the temp dir as files.
//
// Nothing else reclaims these, and /tmp lives as long as the instance does, so
// they accrue over weeks of audits until the volume trips.  This sweeps them.
const TMP = tmpdir();

const LEAKED = [
  /^puppeteer_dev_chrome_profile-/,
  /^\.org\.chromium\.Chromium\./,
  /^\.com\.google\.Chrome\./,
  /^chrome_/,
];

// Every /tmp path currently held open by a live process — including cwd, since
// Chromium chdirs into its profile.  Anything in here is off-limits: an audit
// may legitimately hold one browser open for hours on a large crawl, so age
// alone is not a safe signal.  Returns null if /proc can't be read at all,
// which we treat as "don't sweep" rather than "nothing is in use".
function pathsInUse() {
  let pids;
  try {
    pids = readdirSync('/proc').filter(f => /^\d+$/.test(f));
  } catch {
    return null;
  }

  const inUse = new Set();
  for (const pid of pids) {
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (cwd.startsWith(`${TMP}/`)) inUse.add(cwd);
    } catch {}

    let fds;
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // process exited, or not ours
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        // Already-unlinked files show up as "/tmp/foo (deleted)" — the kernel
        // frees those on process death, so they are not our problem.
        if (target.startsWith(`${TMP}/`) && !target.endsWith(' (deleted)')) {
          inUse.add(target);
        }
      } catch {}
    }
  }
  return inUse;
}

function sizeOf(path) {
  let total = 0;
  let stack = [path];
  while (stack.length) {
    const current = stack.pop();
    let st;
    try {
      st = lstatSync(current);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        for (const entry of readdirSync(current)) stack.push(join(current, entry));
      } catch {}
    } else {
      total += st.size;
    }
  }
  return total;
}

/**
 * Remove orphaned Chromium/Puppeteer litter from /tmp.
 *
 * @param {object}  opts
 * @param {boolean} opts.force     Skip the in-use and age checks entirely.  Only
 *                                 safe immediately after killAllChrome(), when
 *                                 no Chrome process is alive to own anything.
 * @param {number}  opts.minAgeMs  Ignore entries touched more recently than this.
 */
export function sweepChromeTmp({ force = false, minAgeMs = 60 * 60 * 1000 } = {}) {
  if (process.platform !== 'linux') return { removed: 0, bytes: 0 };

  let entries;
  try {
    entries = readdirSync(TMP);
  } catch (err) {
    console.warn(`[tmp] Could not read ${TMP}: ${err.message}`);
    return { removed: 0, bytes: 0 };
  }

  let inUse = new Set();
  if (!force) {
    inUse = pathsInUse();
    if (inUse === null) {
      console.warn('[tmp] /proc unreadable — skipping sweep rather than risk deleting a live profile');
      return { removed: 0, bytes: 0 };
    }
  }

  const now = Date.now();
  let removed = 0;
  let bytes = 0;

  for (const name of entries) {
    if (!LEAKED.some(re => re.test(name))) continue;
    const path = join(TMP, name);

    if (!force) {
      let st;
      try {
        st = statSync(path);
      } catch {
        continue; // vanished under us
      }
      if (now - st.mtimeMs < minAgeMs) continue;

      let busy = false;
      for (const held of inUse) {
        if (held === path || held.startsWith(`${path}/`)) {
          busy = true;
          break;
        }
      }
      if (busy) continue;
    }

    const size = sizeOf(path);
    try {
      rmSync(path, { recursive: true, force: true });
      removed++;
      bytes += size;
    } catch {}
  }

  if (removed > 0) {
    const mb = (bytes / 1024 / 1024).toFixed(1);
    console.log(`[tmp] Reclaimed ${mb} MB from ${removed} orphaned Chrome temp entr${removed === 1 ? 'y' : 'ies'}`);
  }
  return { removed, bytes };
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// Boot sweep runs with force — startup calls killAllChrome() first, so nothing
// is alive to own a profile and we can clear the backlog unconditionally.  From
// then on audits are in flight, so the periodic sweep has to respect in-use.
export function startTmpJanitor() {
  sweepChromeTmp({ force: true });
  const timer = setInterval(() => sweepChromeTmp(), SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
