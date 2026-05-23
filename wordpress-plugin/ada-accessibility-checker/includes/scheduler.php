<?php
defined( 'ABSPATH' ) || exit;

// ── Cron intervals ─────────────────────────────────────────────────────────────

function ada_add_cron_schedules( $schedules ) {
	if ( ! isset( $schedules['monthly'] ) ) {
		$schedules['monthly'] = [
			'interval' => 30 * DAY_IN_SECONDS,
			'display'  => 'Once a month',
		];
	}
	return $schedules;
}

// ── Schedule management ────────────────────────────────────────────────────────

/**
 * Apply current settings to the WP cron table.
 * Clears any existing scheduled event, then re-registers if enabled.
 */
function ada_reschedule_cron() {
	wp_clear_scheduled_hook( 'ada_scheduled_scan' );

	$s = ada_get_settings();
	if ( 'none' === $s['schedule'] ) return;

	// Calculate the first fire time in the site's timezone
	$recurrence = $s['schedule']; // daily | weekly | monthly
	$timestamp  = ada_next_run_timestamp( $s );

	if ( $timestamp > 0 ) {
		wp_schedule_event( $timestamp, $recurrence, 'ada_scheduled_scan' );
	}
}

/**
 * Calculate the Unix timestamp (UTC) for the next run.
 */
function ada_next_run_timestamp( $s ) {
	$now_site = current_time( 'timestamp' ); // local time
	$tz       = get_option( 'timezone_string' ) ?: 'UTC';

	try {
		$dt = new DateTime( 'now', new DateTimeZone( $tz ) );
	} catch ( Exception $e ) {
		$dt = new DateTime( 'now', new DateTimeZone( 'UTC' ) );
	}

	$hour = (int) $s['sched_hour'];
	$day  = (int) $s['sched_day'];

	switch ( $s['schedule'] ) {
		case 'daily':
			$dt->setTime( $hour, 0, 0 );
			if ( $dt->getTimestamp() <= $now_site ) {
				$dt->modify( '+1 day' );
			}
			break;

		case 'weekly':
			// PHP date('N') uses 1=Mon … 7=Sun; our $day matches that.
			$current_dow = (int) $dt->format( 'N' );
			$diff        = $day - $current_dow;
			if ( $diff < 0 || ( $diff === 0 && $dt->format( 'H' ) >= $hour ) ) {
				$diff += 7;
			}
			$dt->modify( "+{$diff} days" );
			$dt->setTime( $hour, 0, 0 );
			break;

		case 'monthly':
			$dt->setDate( (int) $dt->format( 'Y' ), (int) $dt->format( 'n' ), $day );
			$dt->setTime( $hour, 0, 0 );
			if ( $dt->getTimestamp() <= $now_site ) {
				$dt->modify( '+1 month' );
			}
			break;

		default:
			return 0;
	}

	return $dt->getTimestamp();
}

// ── Cron callback ─────────────────────────────────────────────────────────────

function ada_run_scheduled_scan() {
	$s          = ada_get_settings();
	$max_pages  = absint( $s['max_pages'] ) ?: 50;

	$result = ada_start_scan( $max_pages );
	if ( is_wp_error( $result ) ) {
		error_log( '[ADA Checker] Scheduled scan failed to start: ' . $result->get_error_message() );
		return;
	}

	$audit_id = $result['auditId'] ?? '';
	if ( ! $audit_id ) {
		error_log( '[ADA Checker] Scheduled scan returned no auditId.' );
		return;
	}

	ada_update_setting( 'last_audit_id',  $audit_id );
	ada_update_setting( 'last_scan_time', current_time( 'c' ) );

	// Poll until complete (max 20 minutes, checking every 30 s)
	$deadline   = time() + 20 * MINUTE_IN_SECONDS;
	$completed  = false;
	$summary    = null;

	while ( time() < $deadline ) {
		sleep( 30 );
		$status = ada_get_audit_status( $audit_id );
		if ( is_wp_error( $status ) ) break;

		$scan_status = $status['status'] ?? '';
		if ( in_array( $scan_status, [ 'completed', 'error' ], true ) ) {
			$completed = true;
			$summary   = $status['summary'] ?? null;
			if ( isset( $status['summary']['averageScore'] ) ) {
				ada_update_setting( 'last_score', $status['summary']['averageScore'] );
			}
			break;
		}
	}

	if ( $completed && $summary ) {
		ada_send_scan_notification( $audit_id, $summary, $s );
	}
}

// ── Email notification ────────────────────────────────────────────────────────

function ada_send_scan_notification( $audit_id, $summary, $settings ) {
	$emails = array_filter( array_map( 'trim', preg_split( '/[\s,]+/', $settings['emails'] ?? '' ) ) );
	$emails = array_filter( $emails, 'is_email' );
	if ( empty( $emails ) ) return;

	$site_name  = get_bloginfo( 'name' );
	$site_url   = get_site_url();
	$score      = $summary['averageScore'] ?? 'N/A';
	$pages      = $summary['totalPages']   ?? 0;
	$issues     = $summary['totalIssues']  ?? 0;
	$critical   = $summary['criticalIssues'] ?? 0;
	$serious    = $summary['seriousIssues']  ?? 0;
	$moderate   = $summary['moderateIssues'] ?? 0;
	$minor      = $summary['minorIssues']    ?? 0;

	$results_url = admin_url( 'admin.php?page=ada-results' );
	$api_url     = rtrim( $settings['api_url'] ?: ADA_CHECKER_API_DEFAULT, '/' );
	$full_url    = add_query_arg( [ 'auditId' => rawurlencode( $audit_id ), 'readonly' => 'true' ], $api_url . '/' );

	$subject = sprintf( '[%s] ADA Accessibility Scan Complete – Score %s/100', $site_name, $score );

	$body = "ADA Accessibility Scan Complete\n";
	$body .= str_repeat( '─', 40 ) . "\n\n";
	$body .= "Website:        {$site_url}\n";
	$body .= "Overall Score:  {$score}/100\n";
	$body .= "Pages Audited:  {$pages}\n";
	$body .= "Total Issues:   {$issues}\n\n";
	$body .= "Issue Breakdown:\n";
	$body .= "  Critical:  {$critical}\n";
	$body .= "  Serious:   {$serious}\n";
	$body .= "  Moderate:  {$moderate}\n";
	$body .= "  Minor:     {$minor}\n\n";
	$body .= "View full results in your WordPress admin:\n{$results_url}\n\n";
	$body .= "View detailed report:\n{$full_url}\n\n";
	$body .= str_repeat( '─', 40 ) . "\n";
	$body .= "Sent by ADA Accessibility Checker plugin on {$site_name}\n";

	$headers = [
		'Content-Type: text/plain; charset=UTF-8',
		'From: ' . get_bloginfo( 'name' ) . ' <' . get_option( 'admin_email' ) . '>',
	];

	foreach ( $emails as $email ) {
		wp_mail( $email, $subject, $body, $headers );
	}
}
