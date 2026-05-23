<?php
/**
 * Plugin Name:       ADA Accessibility Checker
 * Plugin URI:        https://adachecker.planeteria.com
 * Description:       Monitor your website's ADA/WCAG accessibility compliance — dashboard widget, post-editor panel, scheduled scans, and email notifications.
 * Version:           1.0.0
 * Requires at least: 5.8
 * Requires PHP:      7.4
 * Author:            Planeteria Media
 * License:           GPL-2.0+
 * Text Domain:       ada-checker
 */

defined( 'ABSPATH' ) || exit;

define( 'ADA_CHECKER_VERSION',    '1.0.0' );
define( 'ADA_CHECKER_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'ADA_CHECKER_PLUGIN_URL', plugin_dir_url( __FILE__ ) );
define( 'ADA_CHECKER_API_DEFAULT', 'https://adachecker.planeteria.com' );
define( 'ADA_CHECKER_OPTION_KEY',  'ada_checker_settings' );

// ── Load includes ──────────────────────────────────────────────────────────────
foreach ( [ 'api-client', 'ajax-handlers', 'dashboard-widget', 'admin-page', 'settings-page', 'scheduler', 'meta-box' ] as $file ) {
	require_once ADA_CHECKER_PLUGIN_DIR . "includes/{$file}.php";
}

// ── Hooks ──────────────────────────────────────────────────────────────────────
add_action( 'wp_dashboard_setup',    'ada_register_dashboard_widget' );
add_action( 'admin_menu',            'ada_register_admin_menu' );
add_action( 'admin_enqueue_scripts', 'ada_enqueue_admin_assets' );
add_action( 'add_meta_boxes',        'ada_register_meta_boxes' );

// AJAX (logged-in only)
foreach ( [ 'ada_get_summary', 'ada_start_scan', 'ada_get_scan_status', 'ada_get_page_results', 'ada_rescan_page' ] as $action ) {
	add_action( "wp_ajax_{$action}", "ada_ajax_{$action}" );
}

// Scheduled scan cron
add_action( 'ada_scheduled_scan', 'ada_run_scheduled_scan' );
add_filter( 'cron_schedules',     'ada_add_cron_schedules' );

// Lifecycle
register_activation_hook(   __FILE__, 'ada_plugin_activate' );
register_deactivation_hook( __FILE__, 'ada_plugin_deactivate' );

// ── Lifecycle callbacks ────────────────────────────────────────────────────────

function ada_plugin_activate() {
	if ( ! get_option( ADA_CHECKER_OPTION_KEY ) ) {
		update_option( ADA_CHECKER_OPTION_KEY, ada_default_settings() );
	}
	ada_reschedule_cron();
}

function ada_plugin_deactivate() {
	wp_clear_scheduled_hook( 'ada_scheduled_scan' );
}

// ── Settings helpers ───────────────────────────────────────────────────────────

function ada_default_settings() {
	return [
		'api_url'        => ADA_CHECKER_API_DEFAULT,
		'max_pages'      => 2000,
		'schedule'       => 'none',   // none | daily | weekly | monthly
		'sched_day'      => 1,        // 1–7 (weekly Mon–Sun) or 1–28 (monthly)
		'sched_hour'     => 8,
		'emails'         => '',       // comma-separated
		'scan_url'       => '',       // override URL to scan (leave empty to use WordPress site URL)
		'last_audit_id'  => '',
		'last_scan_time' => '',
		'last_score'     => '',
	];
}

function ada_get_settings() {
	return wp_parse_args(
		(array) get_option( ADA_CHECKER_OPTION_KEY, [] ),
		ada_default_settings()
	);
}

function ada_update_setting( $key, $value ) {
	$settings        = ada_get_settings();
	$settings[ $key ] = $value;
	update_option( ADA_CHECKER_OPTION_KEY, $settings );
}

// ── Asset enqueue ──────────────────────────────────────────────────────────────

function ada_enqueue_admin_assets( $hook ) {
	// Dashboard
	if ( 'index.php' === $hook ) {
		wp_enqueue_style(  'ada-admin', ADA_CHECKER_PLUGIN_URL . 'assets/css/admin.css', [], ADA_CHECKER_VERSION );
		wp_enqueue_script( 'ada-dashboard', ADA_CHECKER_PLUGIN_URL . 'assets/js/dashboard-widget.js', [], ADA_CHECKER_VERSION, true );
		wp_localize_script( 'ada-dashboard', 'adaChecker', ada_js_data() );
	}

	// Post / page editor
	$editor_hooks = [ 'post.php', 'post-new.php' ];
	if ( in_array( $hook, $editor_hooks, true ) ) {
		wp_enqueue_style(  'ada-admin', ADA_CHECKER_PLUGIN_URL . 'assets/css/admin.css', [], ADA_CHECKER_VERSION );
		wp_enqueue_script( 'ada-meta-box', ADA_CHECKER_PLUGIN_URL . 'assets/js/meta-box.js', [], ADA_CHECKER_VERSION, true );
		wp_localize_script( 'ada-meta-box', 'adaChecker', ada_js_data() );
	}

	// Settings page
	if ( false !== strpos( $hook, 'ada-settings' ) ) {
		wp_enqueue_style( 'ada-admin', ADA_CHECKER_PLUGIN_URL . 'assets/css/admin.css', [], ADA_CHECKER_VERSION );
	}
}

function ada_js_data() {
	$settings = ada_get_settings();
	return [
		'ajaxUrl'     => admin_url( 'admin-ajax.php' ),
		'nonce'       => wp_create_nonce( 'ada_checker_nonce' ),
		'siteUrl'     => get_site_url(),
		'scanUrl'     => ada_get_scan_url(),
		'lastAuditId' => $settings['last_audit_id'],
		'resultsPage' => admin_url( 'admin.php?page=ada-results' ),
	];
}
