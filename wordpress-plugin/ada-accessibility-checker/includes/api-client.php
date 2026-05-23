<?php
defined( 'ABSPATH' ) || exit;

/**
 * All HTTP communication with the ADA Checker API goes through these functions.
 * API calls happen server-side (PHP → API) so the site URL is always authoritative
 * and never injectable by the browser.
 */

function ada_api_url() {
	$settings = ada_get_settings();
	return rtrim( $settings['api_url'] ?: ADA_CHECKER_API_DEFAULT, '/' );
}

function ada_get_scan_url() {
	$settings = ada_get_settings();
	$override = trim( $settings['scan_url'] ?? '' );
	return $override ?: get_site_url();
}

/**
 * Generic request wrapper using WP_HTTP.
 *
 * @param string $endpoint  e.g. '/api/scan-summary'
 * @param string $method    GET | POST
 * @param array  $body      POST body (will be JSON-encoded)
 * @param array  $params    GET query params
 * @return array|WP_Error   Decoded JSON body or WP_Error
 */
function ada_api_request( $endpoint, $method = 'GET', $body = [], $params = [] ) {
	$url = ada_api_url() . $endpoint;
	if ( $params ) {
		$url = add_query_arg( $params, $url );
	}

	$args = [
		'method'  => strtoupper( $method ),
		'timeout' => 30,
		'headers' => [ 'Content-Type' => 'application/json' ],
	];
	if ( 'POST' === $args['method'] && $body ) {
		$args['body'] = wp_json_encode( $body );
	}

	$response = wp_remote_request( $url, $args );
	if ( is_wp_error( $response ) ) {
		return $response;
	}

	$code = wp_remote_retrieve_response_code( $response );
	$raw  = wp_remote_retrieve_body( $response );
	$data = json_decode( $raw, true );

	if ( $code >= 400 ) {
		$msg = isset( $data['error'] ) ? $data['error'] : "HTTP {$code}";
		return new WP_Error( 'ada_api_error', $msg, [ 'status' => $code ] );
	}

	return $data ?: [];
}

// ── Specific endpoints ─────────────────────────────────────────────────────────

/**
 * Get the analytics summary for the latest completed scan of the current site.
 *
 * Pass $audit_id when calling immediately after a scan completes — the API will
 * check in-memory sessions first and skip the DB-write race condition.
 *
 * Returns null if never scanned, WP_Error on failure.
 *
 * @param string|null $audit_id Optional: specific audit session to fetch.
 */
function ada_get_scan_summary( $audit_id = null ) {
	$params = [ 'url' => ada_get_scan_url() ];
	if ( $audit_id ) {
		$params['auditId'] = $audit_id;
	}
	$result = ada_api_request( '/api/scan-summary', 'GET', [], $params );
	if ( is_wp_error( $result ) ) return $result;
	if ( isset( $result['status'] ) && 'not_scanned' === $result['status'] ) return null;
	return $result;
}

/**
 * Start a new full-site scan. Returns ['auditId' => '...'] or WP_Error.
 */
function ada_start_scan( $max_pages = 50 ) {
	return ada_api_request( '/api/audit', 'POST', [
		'url'      => ada_get_scan_url(),
		'maxPages' => absint( $max_pages ),
	] );
}

/**
 * Get status of an in-progress or completed audit.
 */
function ada_get_audit_status( $audit_id ) {
	return ada_api_request( "/api/audit/{$audit_id}" );
}

/**
 * Rescan a single page within an existing completed audit session.
 * Note: the API blocks until the rescan is complete (can take 30–120s).
 */
function ada_rescan_page( $audit_id, $page_url ) {
	// Safety: only allow rescanning pages that belong to this site.
	$site = untrailingslashit( get_site_url() );
	if ( 0 !== strpos( $page_url, $site ) ) {
		return new WP_Error( 'ada_forbidden', 'Page URL does not belong to this site.' );
	}
	// Use a generous timeout — rescan is synchronous and can take up to 2 minutes.
	$url  = ada_api_url() . "/api/audit/{$audit_id}/rescan";
	$args = [
		'method'  => 'POST',
		'timeout' => 120,
		'headers' => [ 'Content-Type' => 'application/json' ],
		'body'    => wp_json_encode( [ 'url' => $page_url ] ),
	];
	$response = wp_remote_request( $url, $args );
	if ( is_wp_error( $response ) ) return $response;
	$code = wp_remote_retrieve_response_code( $response );
	$data = json_decode( wp_remote_retrieve_body( $response ), true );
	if ( $code >= 400 ) {
		return new WP_Error( 'ada_api_error', $data['error'] ?? "HTTP {$code}" );
	}
	return $data ?: [];
}

/**
 * Get per-page score + issue summary from a completed audit.
 */
function ada_get_page_summary( $audit_id, $page_url ) {
	return ada_api_request( '/api/page-summary', 'GET', [], [
		'auditId' => $audit_id,
		'pageUrl' => $page_url,
	] );
}
