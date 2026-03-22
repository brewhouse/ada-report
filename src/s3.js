/**
 * S3 upload helper for ADA report PDFs.
 *
 * Uploads PDF buffers to the 'planeteria-pdf-report' bucket and returns
 * publicly accessible URLs.
 *
 * Environment variables:
 *   AWS_ACCESS_KEY_ID      — IAM access key
 *   AWS_SECRET_ACCESS_KEY  — IAM secret key
 *   AWS_REGION             — bucket region (default: us-west-2)
 *   S3_BUCKET              — override bucket name (default: planeteria-pdf-report)
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const BUCKET = process.env.S3_BUCKET || 'planeteria-pdf-report';
const REGION = process.env.AWS_REGION || 'us-west-2';

let s3 = null;

function getClient() {
  if (s3) return s3;
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return null;
  }
  s3 = new S3Client({
    region: REGION,
    credentials: {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
  return s3;
}

/**
 * Upload a PDF buffer to S3 and return the public URL.
 * Returns null if S3 is not configured.
 *
 * @param {Buffer} pdfBuffer  — PDF content
 * @param {string} key        — S3 object key (e.g. "reports/summary-domain-2026-03-22.pdf")
 * @param {string} [contentType='application/pdf']
 * @returns {Promise<string|null>} Public URL or null
 */
export async function uploadToS3(pdfBuffer, key, contentType = 'application/pdf') {
  const client = getClient();
  if (!client) {
    console.warn('[s3] AWS credentials not configured — skipping upload');
    return null;
  }

  await client.send(new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    Body:        pdfBuffer,
    ContentType: contentType,
  }));

  const url = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${encodeURI(key)}`;
  console.log(`[s3] Uploaded: ${url}`);
  return url;
}

/**
 * Upload all three report PDFs (summary, detail, VPAT) for a session.
 * Returns an object with S3 URLs (or nulls if upload fails/not configured).
 *
 * @param {object} params
 * @param {Buffer} params.summaryPdf
 * @param {Buffer} params.detailPdf
 * @param {Buffer} params.vpatPdf
 * @param {string} params.domain    — sanitised domain string
 * @param {string} params.date      — YYYY-MM-DD
 * @param {string} params.sessionId — audit session UUID
 * @returns {Promise<{summaryUrl: string|null, detailUrl: string|null, vpatUrl: string|null}>}
 */
export async function uploadReportPdfs({ summaryPdf, detailPdf, vpatPdf, domain, date, sessionId }) {
  const prefix = `reports/${domain}/${date}`;

  const [summaryUrl, detailUrl, vpatUrl] = await Promise.all([
    uploadToS3(summaryPdf, `${prefix}/accessibility-summary-${sessionId}.pdf`)
      .catch(err => { console.error('[s3] Summary upload failed:', err.message); return null; }),
    uploadToS3(detailPdf, `${prefix}/accessibility-detail-${sessionId}.pdf`)
      .catch(err => { console.error('[s3] Detail upload failed:', err.message); return null; }),
    uploadToS3(vpatPdf, `${prefix}/vpat-report-${sessionId}.pdf`)
      .catch(err => { console.error('[s3] VPAT upload failed:', err.message); return null; }),
  ]);

  return { summaryUrl, detailUrl, vpatUrl };
}
