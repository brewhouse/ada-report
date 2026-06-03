<?php
defined( 'ABSPATH' ) || exit;

/**
 * AJAX handlers — all require a valid nonce and manage_options capability.
 * The site URL is always derived server-side; the browser never sets it.
 */

function ada_ajax_verify() {
	check_ajax_referer( 'ada_checker_nonce', 'nonce' );
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_send_json_error( [ 'message' => 'Insufficient permissions.' ], 403 );
	}
}

// ── GET summary ───────────────────────────────────────────────────────────────

function ada_ajax_ada_get_summary() {
	ada_ajax_verify();

	// Optional auditId: when provided right after a scan completes, passing it
	// lets the API check in-memory sessions first and avoid the DB-write race condition.
	$audit_id = sanitize_text_field( wp_unslash( $_POST['auditId'] ?? '' ) );

	$result = ada_get_scan_summary( $audit_id ?: null );
	if ( is_wp_error( $result ) ) {
		wp_send_json_error( [ 'message' => $result->get_error_message() ] );
	}
	if ( null === $result ) {
		wp_send_json_success( [ 'status' => 'not_scanned' ] );
	}

	// Update cached audit ID and last score so the admin page can use them immediately.
	if ( ! empty( $result['auditId'] ) ) {
		ada_update_setting( 'last_audit_id',  $result['auditId'] );
		ada_update_setting( 'last_scan_time', $result['completedAt'] ?? '' );
		ada_update_setting( 'last_score',     $result['score']       ?? '' );
	}

	wp_send_json_success( $result );
}

// ── Start scan ────────────────────────────────────────────────────────────────

function ada_ajax_ada_start_scan() {
	ada_ajax_verify();

	$settings   = ada_get_settings();
	$max_pages  = absint( $settings['max_pages'] ) ?: 50;
	$result     = ada_start_scan( $max_pages );

	if ( is_wp_error( $result ) ) {
		wp_send_json_error( [ 'message' => $result->get_error_message() ] );
	}
	if ( empty( $result['auditId'] ) ) {
		wp_send_json_error( [ 'message' => 'No audit ID returned from API.' ] );
	}

	ada_update_setting( 'last_audit_id',  $result['auditId'] );
	ada_update_setting( 'last_scan_time', current_time( 'c' ) );

	wp_send_json_success( [ 'auditId' => $result['auditId'] ] );
}

// ── Poll scan status ──────────────────────────────────────────────────────────

function ada_ajax_ada_get_scan_status() {
	ada_ajax_verify();

	$audit_id = sanitize_text_field( wp_unslash( $_POST['auditId'] ?? '' ) );
	if ( ! $audit_id ) {
		wp_send_json_error( [ 'message' => 'auditId is required.' ] );
	}

	$result = ada_get_audit_status( $audit_id );
	if ( is_wp_error( $result ) ) {
		wp_send_json_error( [ 'message' => $result->get_error_message() ] );
	}

	// If scan just completed, refresh the stored summary
	if ( isset( $result['status'] ) && 'completed' === $result['status'] ) {
		ada_update_setting( 'last_audit_id',  $audit_id );
		ada_update_setting( 'last_scan_time', $result['endTime'] ?? current_time( 'c' ) );
		if ( isset( $result['summary']['averageScore'] ) ) {
			ada_update_setting( 'last_score', $result['summary']['averageScore'] );
		}
	}

	wp_send_json_success( [
		'status'   => $result['status']   ?? 'unknown',
		'progress' => $result['progress'] ?? null,
		'summary'  => $result['summary']  ?? null,
		'error'    => $result['error']    ?? null,
	] );
}

// ── Shared helper: resolve audit ID from settings, POST param, or auto-discovery ──

function ada_resolve_audit_id() {
	$settings = ada_get_settings();
	$audit_id = $settings['last_audit_id'];

	// Accept an audit ID forwarded directly from the meta-box JS.
	if ( ! $audit_id ) {
		$audit_id = sanitize_text_field( wp_unslash( $_POST['auditId'] ?? '' ) );
	}

	// Last resort: auto-discover from the API (same logic as ada_render_meta_box).
	if ( ! $audit_id ) {
		$summary = ada_get_scan_summary();
		if ( ! is_wp_error( $summary ) && ! empty( $summary['auditId'] ) ) {
			$audit_id = $summary['auditId'];
			ada_update_setting( 'last_audit_id',  $audit_id );
			ada_update_setting( 'last_scan_time', $summary['completedAt'] ?? '' );
			ada_update_setting( 'last_score',     $summary['score']       ?? '' );
		}
	}

	return $audit_id;
}

// ── Per-page results (editor meta box) ───────────────────────────────────────

function ada_ajax_ada_get_page_results() {
	ada_ajax_verify();

	$page_url = esc_url_raw( wp_unslash( $_POST['pageUrl'] ?? '' ) );
	if ( ! $page_url ) {
		wp_send_json_error( [ 'message' => 'pageUrl is required.' ] );
	}

	// Confirm the URL belongs to this site
	$site = untrailingslashit( get_site_url() );
	if ( 0 !== strpos( $page_url, $site ) ) {
		wp_send_json_error( [ 'message' => 'URL does not belong to this site.' ], 403 );
	}

	$audit_id = ada_resolve_audit_id();
	if ( ! $audit_id ) {
		wp_send_json_success( [ 'status' => 'no_audit' ] );
	}

	$result = ada_get_page_summary( $audit_id, $page_url );
	if ( is_wp_error( $result ) ) {
		wp_send_json_error( [ 'message' => $result->get_error_message() ] );
	}

	wp_send_json_success( $result );
}

// ── Rescan page ───────────────────────────────────────────────────────────────

function ada_ajax_ada_rescan_page() {
	ada_ajax_verify();

	$page_url = esc_url_raw( wp_unslash( $_POST['pageUrl'] ?? '' ) );
	if ( ! $page_url ) {
		wp_send_json_error( [ 'message' => 'pageUrl is required.' ] );
	}

	$audit_id = ada_resolve_audit_id();
	if ( ! $audit_id ) {
		wp_send_json_error( [ 'message' => 'No completed scan found. Please run a full site scan first.' ] );
	}

	$result = ada_rescan_page( $audit_id, $page_url );
	if ( is_wp_error( $result ) ) {
		wp_send_json_error( [ 'message' => $result->get_error_message() ] );
	}

	wp_send_json_success( $result );
}
