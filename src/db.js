/**
 * MySQL database layer for ADA Accessibility Auditor.
 *
 * Tables created on first run:
 *   audit_sessions  — one row per audit (metadata + summary stats)
 *   audit_pages     — one row per page audited within a session
 *   audit_issues    — one row per issue type per page
 *   schedules       — scheduled audit configurations (replaces data/schedules.json)
 *
 * Environment variables (all have working defaults):
 *   MYSQL_HOST  MYSQL_PORT  MYSQL_USER  MYSQL_PASS  MYSQL_DB
 */

import mysql from 'mysql2/promise';

// SSL is required by some providers (e.g. TiDB Cloud, PlanetScale).
// Set MYSQL_SSL=true in Render environment variables to enable it.
const sslConfig = process.env.MYSQL_SSL === 'true'
  ? { ssl: { rejectUnauthorized: true } }
  : {};

const pool = mysql.createPool({
  host:             process.env.MYSQL_HOST || '147.182.205.221',
  port:             parseInt(process.env.MYSQL_PORT || '3306'),
  user:             process.env.MYSQL_USER || 'grxoxirozk',
  password:         process.env.MYSQL_PASS || 'Pl@neteria123',
  database:         process.env.MYSQL_DB   || 'grxoxirozk',
  waitForConnections: true,
  connectionLimit:  10,
  queueLimit:       0,
  timezone:         'Z',
  charset:          'utf8mb4',
  connectTimeout:   10000,
  ...sslConfig,
});

// ── Table initialisation ──────────────────────────────────────────────────────

export async function initDb() {
  const conn = await pool.getConnection();
  try {
    // audit_sessions — one row per audit run
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS audit_sessions (
        id               VARCHAR(36)   NOT NULL PRIMARY KEY,
        url              VARCHAR(2048) NOT NULL,
        status           VARCHAR(20)   NOT NULL DEFAULT 'queued',
        max_pages        INT           NOT NULL DEFAULT 100,
        start_time       DATETIME      NOT NULL,
        end_time         DATETIME,
        total_pages      INT           DEFAULT 0,
        successful_pages INT           DEFAULT 0,
        error_pages      INT           DEFAULT 0,
        average_score    DECIMAL(5,2)  DEFAULT 0,
        min_score        INT           DEFAULT 0,
        max_score        INT           DEFAULT 0,
        total_issues     INT           DEFAULT 0,
        critical_issues  INT           DEFAULT 0,
        serious_issues   INT           DEFAULT 0,
        moderate_issues  INT           DEFAULT 0,
        minor_issues     INT           DEFAULT 0,
        pages_above_90   INT           DEFAULT 0,
        pages_70_to_89   INT           DEFAULT 0,
        pages_50_to_69   INT           DEFAULT 0,
        pages_below_50   INT           DEFAULT 0,
        error_message    TEXT,
        url_list         JSON,
        exclude_sitemaps JSON,
        created_at       DATETIME      DEFAULT CURRENT_TIMESTAMP,
        updated_at       DATETIME      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_as_status     (status),
        INDEX idx_as_start_time (start_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // audit_pages — one row per page per session
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS audit_pages (
        id            INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
        session_id    VARCHAR(36)   NOT NULL,
        url           VARCHAR(2048) NOT NULL,
        status        VARCHAR(20)   NOT NULL DEFAULT 'completed',
        score         INT,
        issue_count   INT           DEFAULT 0,
        error_message TEXT,
        audited_at    DATETIME,
        INDEX idx_ap_session (session_id),
        INDEX idx_ap_status  (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // audit_issues — one row per distinct issue type per page
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS audit_issues (
        id          INT           NOT NULL AUTO_INCREMENT PRIMARY KEY,
        page_id     INT           NOT NULL,
        session_id  VARCHAR(36)   NOT NULL,
        issue_id    VARCHAR(150),
        wcag        VARCHAR(20),
        wcag_level  VARCHAR(10),
        severity    VARCHAR(20),
        title       VARCHAR(1000),
        description TEXT,
        issue_count INT           DEFAULT 1,
        elements    JSON,
        INDEX idx_ai_page     (page_id),
        INDEX idx_ai_session  (session_id),
        INDEX idx_ai_wcag     (wcag),
        INDEX idx_ai_severity (severity)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Backfill columns added after initial deploy.
    // Check if columns exist first (IF NOT EXISTS not supported on all MySQL versions).
    const [cols] = await conn.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_issues'`
    );
    const existingCols = new Set(cols.map(c => c.COLUMN_NAME));

    if (!existingCols.has('issue_id')) {
      await conn.execute("ALTER TABLE audit_issues ADD COLUMN issue_id VARCHAR(150) NULL");
      console.log('[db] Added missing column: audit_issues.issue_id');
    }
    if (!existingCols.has('wcag_level')) {
      await conn.execute("ALTER TABLE audit_issues ADD COLUMN wcag_level VARCHAR(10) NULL");
      console.log('[db] Added missing column: audit_issues.wcag_level');
    }

    // schedules — replaces data/schedules.json
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS schedules (
        id              VARCHAR(36)  NOT NULL PRIMARY KEY,
        name            VARCHAR(255) DEFAULT '',
        url             VARCHAR(2048) NOT NULL,
        max_pages       INT          DEFAULT 50,
        exclude_sitemaps JSON,
        frequency       VARCHAR(20)  DEFAULT 'weekly',
        day_of_week     INT          DEFAULT 1,
        day_of_month    INT          DEFAULT 1,
        hour            INT          DEFAULT 8,
        minute_val      INT          DEFAULT 0,
        emails          JSON,
        dev_emails      JSON,
        brand           VARCHAR(50)  DEFAULT 'planeteria',
        enabled         TINYINT(1)   DEFAULT 1,
        last_run        DATETIME,
        last_run_status VARCHAR(20),
        last_run_error  TEXT,
        created_at      DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('[db] All tables initialised');
  } finally {
    conn.release();
  }
}

// Diagnostic: test INSERT/SELECT/DELETE on audit_issues to verify DB writes work.
export async function testIssueInsert() {
  const testPageId = 999999999;
  const testSessionId = 'test-issue-insert';
  try {
    // Insert
    await pool.execute(
      `INSERT INTO audit_issues
         (page_id, session_id, issue_id, wcag, wcag_level, severity, title, description, issue_count, elements)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [testPageId, testSessionId, 'test-id', '1.1.1', 'A', 'critical', 'Test issue', 'Test desc', 1, '[]']
    );
    // Read back
    const [rows] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM audit_issues WHERE page_id = ? AND session_id = ?',
      [testPageId, testSessionId]
    );
    const count = rows[0].cnt;
    // Clean up
    await pool.execute(
      'DELETE FROM audit_issues WHERE page_id = ? AND session_id = ?',
      [testPageId, testSessionId]
    );
    return { success: true, insertedAndRead: count > 0 };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Session helpers ───────────────────────────────────────────────────────────

function sessionToRow(session) {
  const s = session.summary || {};
  return [
    session.id,
    session.url,
    session.status,
    session.maxPages,
    new Date(session.startTime),
    session.endTime ? new Date(session.endTime) : null,
    s.totalPages      || 0,
    s.successfulPages || 0,
    s.errorPages      || 0,
    s.averageScore    || 0,
    s.minScore        || 0,
    s.maxScore        || 0,
    s.totalIssues     || 0,
    s.criticalIssues  || 0,
    s.seriousIssues   || 0,
    s.moderateIssues  || 0,
    s.minorIssues     || 0,
    s.pagesAbove90    || 0,
    s.pages70to89     || 0,
    s.pages50to69     || 0,
    s.pagesBelow50    || 0,
    session.error || null,
    session.urlList         ? JSON.stringify(session.urlList)         : null,
    session.excludeSitemaps ? JSON.stringify(session.excludeSitemaps) : null,
  ];
}

function rowToSession(row) {
  const hasSummary = row.total_pages > 0 || row.status === 'completed';
  return {
    id:              row.id,
    url:             row.url,
    status:          row.status,
    maxPages:        row.max_pages,
    startTime:       row.start_time ? new Date(row.start_time).toISOString() : null,
    endTime:         row.end_time   ? new Date(row.end_time).toISOString()   : null,
    pages:           [],   // lightweight — issues loaded separately via getFullSession()
    crawledUrls:     [],
    currentPage:     null,
    progress:        { crawled: 0, total: 0, audited: 0 },
    summary:         hasSummary ? {
      totalPages:      row.total_pages,
      successfulPages: row.successful_pages,
      errorPages:      row.error_pages,
      averageScore:    parseFloat(row.average_score) || 0,
      minScore:        row.min_score,
      maxScore:        row.max_score,
      totalIssues:     row.total_issues,
      criticalIssues:  row.critical_issues,
      seriousIssues:   row.serious_issues,
      moderateIssues:  row.moderate_issues,
      minorIssues:     row.minor_issues,
      pagesAbove90:    row.pages_above_90,
      pages70to89:     row.pages_70_to_89,
      pages50to69:     row.pages_50_to_69,
      pagesBelow50:    row.pages_below_50,
    } : null,
    error:           row.error_message || null,
    urlList:         row.url_list         ? JSON.parse(row.url_list)         : null,
    excludeSitemaps: row.exclude_sitemaps ? JSON.parse(row.exclude_sitemaps) : null,
  };
}

// Insert or update a session's metadata + summary stats.
export async function upsertSession(session) {
  const vals = sessionToRow(session);
  await pool.execute(
    `INSERT INTO audit_sessions
       (id, url, status, max_pages, start_time, end_time,
        total_pages, successful_pages, error_pages,
        average_score, min_score, max_score,
        total_issues, critical_issues, serious_issues, moderate_issues, minor_issues,
        pages_above_90, pages_70_to_89, pages_50_to_69, pages_below_50,
        error_message, url_list, exclude_sitemaps)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       status           = VALUES(status),
       end_time         = VALUES(end_time),
       total_pages      = VALUES(total_pages),
       successful_pages = VALUES(successful_pages),
       error_pages      = VALUES(error_pages),
       average_score    = VALUES(average_score),
       min_score        = VALUES(min_score),
       max_score        = VALUES(max_score),
       total_issues     = VALUES(total_issues),
       critical_issues  = VALUES(critical_issues),
       serious_issues   = VALUES(serious_issues),
       moderate_issues  = VALUES(moderate_issues),
       minor_issues     = VALUES(minor_issues),
       pages_above_90   = VALUES(pages_above_90),
       pages_70_to_89   = VALUES(pages_70_to_89),
       pages_50_to_69   = VALUES(pages_50_to_69),
       pages_below_50   = VALUES(pages_below_50),
       error_message    = VALUES(error_message),
       url_list         = VALUES(url_list),
       exclude_sitemaps = VALUES(exclude_sitemaps)`,
    vals
  );
}

// Write a single completed page (and its issues) to the database.
// Returns the inserted audit_pages.id.
export async function savePage(sessionId, page) {
  console.log(`[db] savePage called: session=${sessionId}, url=${page.url}, status=${page.status}, issueCount=${page.issueCount}, hasIssues=${!!(page.issues && page.issues.length > 0)}, issuesLength=${page.issues?.length ?? 'null'}`);

  const [result] = await pool.execute(
    `INSERT INTO audit_pages
       (session_id, url, status, score, issue_count, error_message, audited_at)
     VALUES (?,?,?,?,?,?,?)`,
    [
      sessionId,
      page.url,
      page.status,
      page.score ?? null,
      page.issueCount || 0,
      page.error || null,
      page.timestamp ? new Date(page.timestamp) : new Date(),
    ]
  );
  const pageId = result.insertId;
  console.log(`[db] Page inserted: pageId=${pageId}, now inserting ${page.issues?.length ?? 0} issues`);

  if (page.issues && page.issues.length > 0) {
    // Insert issues one-by-one using prepared statements to avoid bulk INSERT
    // failures (VALUES ? with pool.query has been unreliable on some MySQL
    // configurations, silently failing and leaving audit_issues empty).
    let saved = 0;
    for (const issue of page.issues) {
      try {
        await pool.execute(
          `INSERT INTO audit_issues
             (page_id, session_id, issue_id, wcag, wcag_level, severity, title, description, issue_count, elements)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            pageId,
            sessionId,
            (issue.id        || '').substring(0, 150) || null,
            (issue.wcag      || '').substring(0, 20)  || null,
            (issue.wcagLevel || '').substring(0, 10)  || null,
            (issue.severity  || '').substring(0, 20)  || null,
            (issue.title     || '').substring(0, 1000),
            issue.description || null,
            issue.count      || 1,
            issue.elements   ? JSON.stringify(issue.elements) : null,
          ]
        );
        saved++;
      } catch (e) {
        console.error(`[db] Issue insert failed for page ${pageId}: ${e.message} — id: ${issue.id}, title: ${(issue.title || '').substring(0, 60)}`);
      }
    }
    if (saved !== page.issues.length) {
      console.warn(`[db] Page ${pageId} (${page.url}): saved ${saved}/${page.issues.length} issues`);
    }
  }

  return pageId;
}

// Delete a page (and its issues) by session + URL — used by the rescan route.
export async function deletePageByUrl(sessionId, pageUrl) {
  const [pages] = await pool.execute(
    'SELECT id FROM audit_pages WHERE session_id = ? AND url = ?',
    [sessionId, pageUrl]
  );
  for (const p of pages) {
    await pool.execute('DELETE FROM audit_issues WHERE page_id = ?', [p.id]);
  }
  await pool.execute(
    'DELETE FROM audit_pages WHERE session_id = ? AND url = ?',
    [sessionId, pageUrl]
  );
}

// Load lightweight session metadata for all sessions newer than `days` days.
// Pages and issues are NOT loaded — use getFullSession() for that.
export async function loadSessionMetas(days = 7) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [rows] = await pool.execute(
    `SELECT * FROM audit_sessions
     WHERE start_time > ?
     ORDER BY start_time DESC
     LIMIT 200`,
    [cutoff]
  );
  return rows.map(rowToSession);
}

// Load a session with ALL its pages and issues — for report generation.
export async function getFullSession(sessionId) {
  const [sessionRows] = await pool.execute(
    'SELECT * FROM audit_sessions WHERE id = ?',
    [sessionId]
  );
  if (!sessionRows.length) return null;

  const session = rowToSession(sessionRows[0]);

  const [pageRows] = await pool.execute(
    'SELECT * FROM audit_pages WHERE session_id = ? ORDER BY id',
    [sessionId]
  );

  // Bulk-load all issues for this session, then group by page_id
  const issueMap = {};
  if (pageRows.length > 0) {
    const [issueRows] = await pool.execute(
      'SELECT * FROM audit_issues WHERE session_id = ? ORDER BY page_id, id',
      [sessionId]
    );
    for (const issue of issueRows) {
      if (!issueMap[issue.page_id]) issueMap[issue.page_id] = [];
      issueMap[issue.page_id].push({
        id:          issue.issue_id   || null,
        wcag:        issue.wcag,
        wcagLevel:   issue.wcag_level || null,
        severity:    issue.severity,
        title:       issue.title,
        description: issue.description,
        count:       issue.issue_count,
        elements:    issue.elements ? (() => { try { return JSON.parse(issue.elements); } catch { return []; } })() : [],
      });
    }
  }

  session.pages = pageRows.map(p => ({
    url:        p.url,
    status:     p.status,
    score:      p.score,
    issueCount: p.issue_count,
    issues:     issueMap[p.id] || [],
    error:      p.error_message || null,
    timestamp:  p.audited_at ? new Date(p.audited_at).toISOString() : null,
  }));

  return session;
}

// Re-aggregate summary stats from DB — used after a page rescan.
export async function recomputeSummary(sessionId) {
  const [[stats]] = await pool.execute(
    `SELECT
       COUNT(*)                                  AS total_pages,
       SUM(status = 'completed')                 AS successful_pages,
       SUM(status = 'error')                     AS error_pages,
       ROUND(AVG(CASE WHEN score IS NOT NULL THEN score END), 2) AS average_score,
       MIN(score)                                AS min_score,
       MAX(score)                                AS max_score,
       SUM(score >= 90)                          AS pages_above_90,
       SUM(score >= 70 AND score < 90)           AS pages_70_to_89,
       SUM(score >= 50 AND score < 70)           AS pages_50_to_69,
       SUM(score < 50 AND score IS NOT NULL)     AS pages_below_50
     FROM audit_pages WHERE session_id = ?`,
    [sessionId]
  );

  const [[issueCounts]] = await pool.execute(
    `SELECT
       COUNT(*)                           AS total_issues,
       SUM(severity = 'critical')         AS critical_issues,
       SUM(severity = 'serious')          AS serious_issues,
       SUM(severity = 'moderate')         AS moderate_issues,
       SUM(severity = 'minor')            AS minor_issues
     FROM audit_issues WHERE session_id = ?`,
    [sessionId]
  );

  return {
    totalPages:      stats.total_pages      || 0,
    successfulPages: stats.successful_pages || 0,
    errorPages:      stats.error_pages      || 0,
    averageScore:    parseFloat(stats.average_score) || 0,
    minScore:        stats.min_score        || 0,
    maxScore:        stats.max_score        || 0,
    totalIssues:     issueCounts.total_issues    || 0,
    criticalIssues:  issueCounts.critical_issues || 0,
    seriousIssues:   issueCounts.serious_issues  || 0,
    moderateIssues:  issueCounts.moderate_issues || 0,
    minorIssues:     issueCounts.minor_issues    || 0,
    pagesAbove90:    stats.pages_above_90   || 0,
    pages70to89:     stats.pages_70_to_89   || 0,
    pages50to69:     stats.pages_50_to_69   || 0,
    pagesBelow50:    stats.pages_below_50   || 0,
  };
}

// Delete sessions (and their pages/issues) older than `days` days.
export async function deleteOldSessions(days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [oldSessions] = await pool.execute(
    'SELECT id FROM audit_sessions WHERE start_time < ?',
    [cutoff]
  );
  for (const { id } of oldSessions) {
    await pool.execute('DELETE FROM audit_issues WHERE session_id = ?', [id]);
    await pool.execute('DELETE FROM audit_pages   WHERE session_id = ?', [id]);
    await pool.execute('DELETE FROM audit_sessions WHERE id = ?',        [id]);
  }
  if (oldSessions.length > 0) {
    console.log(`[db] Pruned ${oldSessions.length} old session(s)`);
  }
}

// ── Schedule helpers ──────────────────────────────────────────────────────────

function scheduleToRow(s) {
  return [
    s.id,
    s.name       || '',
    s.url,
    s.maxPages   || 50,
    s.excludeSitemaps ? JSON.stringify(s.excludeSitemaps) : null,
    s.frequency  || 'weekly',
    s.dayOfWeek  ?? 1,
    s.dayOfMonth ?? 1,
    s.hour       ?? 8,
    s.minute     ?? 0,
    JSON.stringify(s.emails    || []),
    JSON.stringify(s.devEmails || []),
    s.brand      || 'planeteria',
    s.enabled !== false ? 1 : 0,
    s.lastRun        ? new Date(s.lastRun) : null,
    s.lastRunStatus  || null,
    s.lastRunError   || null,
    new Date(s.createdAt || new Date()),
  ];
}

function rowToSchedule(row) {
  return {
    id:             row.id,
    name:           row.name           || '',
    url:            row.url,
    maxPages:       row.max_pages,
    excludeSitemaps: row.exclude_sitemaps ? JSON.parse(row.exclude_sitemaps) : [],
    frequency:      row.frequency,
    dayOfWeek:      row.day_of_week,
    dayOfMonth:     row.day_of_month,
    hour:           row.hour,
    minute:         row.minute_val,
    emails:         row.emails     ? JSON.parse(row.emails)     : [],
    devEmails:      row.dev_emails ? JSON.parse(row.dev_emails) : [],
    brand:          row.brand          || 'planeteria',
    enabled:        row.enabled === 1,
    lastRun:        row.last_run        ? new Date(row.last_run).toISOString()        : null,
    lastRunStatus:  row.last_run_status || null,
    lastRunError:   row.last_run_error  || null,
    createdAt:      row.created_at      ? new Date(row.created_at).toISOString()      : null,
  };
}

export async function upsertScheduleToDb(schedule) {
  const vals = scheduleToRow(schedule);
  await pool.execute(
    `INSERT INTO schedules
       (id, name, url, max_pages, exclude_sitemaps, frequency,
        day_of_week, day_of_month, hour, minute_val,
        emails, dev_emails, brand, enabled,
        last_run, last_run_status, last_run_error, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       name             = VALUES(name),
       url              = VALUES(url),
       max_pages        = VALUES(max_pages),
       exclude_sitemaps = VALUES(exclude_sitemaps),
       frequency        = VALUES(frequency),
       day_of_week      = VALUES(day_of_week),
       day_of_month     = VALUES(day_of_month),
       hour             = VALUES(hour),
       minute_val       = VALUES(minute_val),
       emails           = VALUES(emails),
       dev_emails       = VALUES(dev_emails),
       brand            = VALUES(brand),
       enabled          = VALUES(enabled),
       last_run         = VALUES(last_run),
       last_run_status  = VALUES(last_run_status),
       last_run_error   = VALUES(last_run_error)`,
    vals
  );
}

export async function deleteScheduleFromDb(id) {
  await pool.execute('DELETE FROM schedules WHERE id = ?', [id]);
}

export async function loadSchedulesFromDb() {
  const [rows] = await pool.execute('SELECT * FROM schedules ORDER BY created_at');
  return rows.map(rowToSchedule);
}

export async function patchScheduleInDb(id, fields) {
  const sets   = [];
  const values = [];

  const mapping = {
    lastRun:       ['last_run',        v => v ? new Date(v) : null],
    lastRunStatus: ['last_run_status', v => v],
    lastRunError:  ['last_run_error',  v => v],
    enabled:       ['enabled',         v => v ? 1 : 0],
  };

  for (const [key, [col, transform]] of Object.entries(mapping)) {
    if (key in fields) {
      sets.push(`${col} = ?`);
      values.push(transform(fields[key]));
    }
  }

  if (sets.length === 0) return;
  values.push(id);
  await pool.execute(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`, values);
}
