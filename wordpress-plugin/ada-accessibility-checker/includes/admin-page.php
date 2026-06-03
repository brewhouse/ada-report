<?php
defined( 'ABSPATH' ) || exit;

function ada_register_admin_menu() {
	// Top-level menu
	add_menu_page(
		'ADA Accessibility',
		'ADA Checker',
		'manage_options',
		'ada-results',
		'ada_render_results_page',
		'dashicons-universal-access-alt',
		3
	);

	// Sub-pages
	add_submenu_page( 'ada-results', 'Full Results',   'Full Results',   'manage_options', 'ada-results',   'ada_render_results_page' );
	add_submenu_page( 'ada-results', 'ADA Settings',   'Settings',       'manage_options', 'ada-settings',  'ada_render_settings_page' );
}

function ada_render_results_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		wp_die( esc_html__( 'Insufficient permissions.', 'ada-checker' ) );
	}

	$settings = ada_get_settings();
	$audit_id = $settings['last_audit_id'];
	$api_url  = rtrim( $settings['api_url'] ?: ADA_CHECKER_API_DEFAULT, '/' );
	$site_url = get_site_url();

	// Auto-discover the latest auditId via the API if we don't have one stored.
	// This handles the case where the user has existing scans in the dashboard
	// but hasn't run a scan through the WP plugin yet.
	if ( ! $audit_id ) {
		$summary = ada_get_scan_summary();
		if ( ! is_wp_error( $summary ) && ! empty( $summary['auditId'] ) ) {
			$audit_id = $summary['auditId'];
			ada_update_setting( 'last_audit_id',  $audit_id );
			ada_update_setting( 'last_scan_time', $summary['completedAt'] ?? '' );
			ada_update_setting( 'last_score',     $summary['score']       ?? '' );
		}
	}

	// Build iframe URL — readonly=true prevents the "New Audit" button from showing
	$iframe_url = '';
	if ( $audit_id ) {
		$iframe_url = add_query_arg( [
			'auditId'  => rawurlencode( $audit_id ),
			'readonly' => 'true',
			'siteUrl'  => rawurlencode( $site_url ),
		], $api_url . '/' );
	}
	?>
	<div class="wrap ada-results-wrap">
		<h1>ADA Accessibility Results</h1>
		<p class="ada-site-tag">Site: <strong><?php echo esc_html( $site_url ); ?></strong></p>

		<?php if ( ! $audit_id ) : ?>
			<div class="notice notice-warning" style="margin:20px 0">
				<p>No scan has been run yet. Go to your
					<a href="<?php echo esc_url( admin_url( 'index.php' ) ); ?>">Dashboard</a>
					and click <strong>Rescan Website</strong>, or configure a
					<a href="<?php echo esc_url( admin_url( 'admin.php?page=ada-settings' ) ); ?>">scheduled scan</a>.
				</p>
			</div>
		<?php else : ?>
			<div class="ada-iframe-toolbar">
				<button id="ada-results-rescan" class="button button-primary">↻ Rescan Website</button>
				<span id="ada-results-scan-msg" style="display:none;margin-left:12px;color:#6b7280;font-size:13px"></span>
			</div>
			<div class="ada-iframe-wrap">
				<iframe
					id="ada-results-iframe"
					src="<?php echo esc_url( $iframe_url ); ?>"
					width="100%"
					height="1800"
					title="ADA Accessibility Results for <?php echo esc_attr( $site_url ); ?>"
					allowfullscreen
				></iframe>
			</div>
		<?php endif; ?>
	</div>

	<script>
	(function() {
		const btn = document.getElementById('ada-results-rescan');
		if (!btn) return;
		btn.addEventListener('click', function() {
			btn.disabled = true;
			const msg = document.getElementById('ada-results-scan-msg');
			msg.textContent = 'Starting scan…';
			msg.style.display = 'inline';
			fetch(adaChecker.ajaxUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ action: 'ada_start_scan', nonce: adaChecker.nonce })
			})
			.then(r => r.json())
			.then(d => {
				if (d.success) {
					msg.textContent = 'Scan started! Reload this page in a few minutes to see updated results.';
					btn.textContent = '✓ Scan queued';
				} else {
					msg.textContent = 'Error: ' + (d.data?.message || 'Unknown error');
					btn.disabled = false;
				}
			})
			.catch(() => {
				msg.textContent = 'Request failed.';
				btn.disabled = false;
			});
		});
	})();
	</script>
	<?php
}
