# ADA Accessibility Auditor

A full-featured web application that crawls an entire website and audits every page for ADA / WCAG accessibility compliance using Google Lighthouse.

## Features

- **Full site crawl** – Automatically discovers all pages on a domain
- **Google Lighthouse powered** – Industry-standard accessibility auditing
- **Real-time progress** – Watch results stream in via WebSocket
- **Interactive dashboard** – Browse page scores, filter by severity
- **WCAG mapping** – Each issue linked to its WCAG 2.1 criterion
- **Downloadable HTML report** – Printable/PDF-ready report for stakeholders
- **Recent audits** – Resume or revisit past audit sessions

## Quick Start (Local)

### Prerequisites
- Node.js 18+
- The `puppeteer` package will automatically download Chromium on `npm install`

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000)

## Deploying to Render

### Option 1: Docker (Recommended)

1. Push this repo to GitHub
2. Create a new **Web Service** on [Render](https://render.com)
3. Connect your GitHub repo
4. Set **Environment** to `Docker`
5. Set **Dockerfile Path** to `./Dockerfile`
6. Set **Plan** to **Standard** (1GB RAM required for Chrome + Lighthouse)
7. Click **Deploy**

### Option 2: Using render.yaml

The included `render.yaml` automates the above. Just connect your repo to Render and it will use the config automatically.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port to listen on |
| `NODE_ENV` | `production` | Node environment |
| `PUPPETEER_EXECUTABLE_PATH` | (auto) | Path to Chrome/Chromium binary |

> **Note:** The Dockerfile installs Google Chrome Stable and sets `PUPPETEER_EXECUTABLE_PATH` automatically.

## Architecture

```
ada-audit-app/
├── server.js              # Express + WebSocket server
├── src/
│   ├── crawler.js         # BFS web crawler (axios + cheerio)
│   ├── lighthouse-runner.js  # Puppeteer + Lighthouse integration
│   ├── audit-manager.js   # Orchestrates crawl → audit pipeline
│   └── report-generator.js  # Generates downloadable HTML reports
├── public/
│   ├── index.html         # Single-page application
│   ├── styles.css         # UI styles
│   └── app.js             # Frontend JavaScript
├── Dockerfile             # Docker build for Render
└── render.yaml            # Render deployment config
```

## How It Works

1. User enters a URL and max page limit
2. Server crawls the site using BFS (axios + cheerio), discovering all internal pages
3. For each page, Google Lighthouse runs an accessibility-only audit
4. Results stream to the browser in real-time via WebSocket
5. When complete, an interactive dashboard shows:
   - Per-page accessibility scores (0–100)
   - All failing WCAG checks with affected HTML elements
   - Severity levels: Critical, Serious, Moderate, Minor
6. A comprehensive HTML report can be downloaded and printed/saved as PDF

## Resource Requirements

| Plan | RAM | Suitable For |
|------|-----|-------------|
| Starter ($7/mo) | 512MB | Small sites (< 20 pages) |
| Standard ($25/mo) | 1GB | Medium sites (up to 100 pages) |
| Pro ($85/mo) | 2GB | Large sites (100+ pages) |

Chrome + Lighthouse requires approximately 300–500MB RAM per active audit.

## Limitations

- Single-page applications (SPAs) that rely heavily on JavaScript routing may have incomplete crawl results
- Password-protected pages cannot be audited
- Pages behind CAPTCHA or bot-detection may be skipped
- Audit sessions are stored in memory; restarting the server clears history
