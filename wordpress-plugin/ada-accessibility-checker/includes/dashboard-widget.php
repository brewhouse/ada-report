<?php
defined( 'ABSPATH' ) || exit;

function ada_register_dashboard_widget() {
	if ( ! current_user_can( 'manage_options' ) ) return;
	wp_add_dashboard_widget(
		'ada_accessibility_widget',
		'ADA Accessibility Status',
		'ada_render_dashboard_widget',
		null,
		null,
		'normal',
		'high'
	);
}

function ada_render_dashboard_widget() {
	$settings     = ada_get_settings();
	$results_url  = admin_url( 'admin.php?page=ada-results' );
	$last_audit   = esc_attr( $settings['last_audit_id'] );
	$last_time    = $settings['last_scan_time'] ? human_time_diff( strtotime( $settings['last_scan_time'] ), current_time( 'timestamp' ) ) . ' ago' : '';
	?>
	<div id="ada-widget-wrap">

		<!-- Loading state -->
		<div id="ada-state-loading" class="ada-state">
			<span class="ada-spinner-inline"></span>
			<span>Loading accessibility data…</span>
		</div>

		<!-- No-scan state -->
		<div id="ada-state-none" class="ada-state" style="display:none">
			<p style="margin:0 0 12px">No scan data found for <strong><?php echo esc_html( get_site_url() ); ?></strong>.</p>
			<button id="ada-btn-first-scan" class="button button-primary ada-scan-btn">
				Run First Scan
			</button>
		</div>

		<!-- Scanning / progress state -->
		<div id="ada-state-scanning" class="ada-state" style="display:none">
			<div class="ada-scan-header">
				<span class="ada-spinner-inline"></span>
				<span id="ada-scan-label">Scan in progress…</span>
			</div>
			<div class="ada-progress-track">
				<div id="ada-progress-bar" class="ada-progress-fill" style="width:0%"></div>
			</div>
			<p id="ada-scan-detail" style="font-size:12px;color:#6b7280;margin:6px 0 0"></p>
		</div>

		<!-- Results state -->
		<div id="ada-state-results" class="ada-state" style="display:none">
			<div class="ada-results-grid">
				<!-- Score gauge -->
				<div class="ada-gauge-col">
					<canvas id="ada-score-canvas" width="110" height="110"></canvas>
					<div class="ada-gauge-label">OVERALL SCORE</div>
				</div>

				<!-- Stats -->
				<div class="ada-stats-col">
					<div class="ada-stat-row">
						<div class="ada-stat-box">
							<span id="ada-stat-pages" class="ada-stat-num">–</span>
							<span class="ada-stat-lbl">PAGES AUDITED</span>
						</div>
						<div class="ada-stat-divider"></div>
						<div class="ada-stat-box">
							<span id="ada-stat-issues" class="ada-stat-num">–</span>
							<span class="ada-stat-lbl">TOTAL ISSUES</span>
						</div>
					</div>
					<div class="ada-severity-list">
						<span class="ada-dot ada-dot-critical"></span><span id="ada-sev-critical">–</span> Critical&ensp;
						<span class="ada-dot ada-dot-serious"></span><span id="ada-sev-serious">–</span> Serious&ensp;
						<span class="ada-dot ada-dot-moderate"></span><span id="ada-sev-moderate">–</span> Moderate&ensp;
						<span class="ada-dot ada-dot-minor"></span><span id="ada-sev-minor">–</span> Minor
					</div>
					<div class="ada-ignored-row">
						<span class="ada-dot ada-dot-ignored"></span>
						<span id="ada-sev-ignored">–</span> Ignored
					</div>
					<?php if ( $last_time ) : ?>
					<div class="ada-last-scan">Last scanned <?php echo esc_html( $last_time ); ?></div>
					<?php endif; ?>
				</div>
			</div>

			<div class="ada-widget-actions">
				<button id="ada-btn-rescan" class="button button-primary ada-scan-btn" data-audit="<?php echo $last_audit; ?>">
					↻ Rescan Website
				</button>
				<a id="ada-btn-results" href="<?php echo esc_url( $results_url ); ?>" class="button button-secondary">
					View Full Results →
				</a>
			</div>
		</div>

		<!-- Error state -->
		<div id="ada-state-error" class="ada-state" style="display:none">
			<p id="ada-error-msg" style="color:#dc2626;margin:0 0 6px"></p>
			<p id="ada-error-url" style="font-size:12px;color:#6b7280;margin:0 0 10px"></p>
			<button id="ada-btn-retry" class="button">Retry</button>
		</div>

	</div><!-- #ada-widget-wrap -->
	<?php
}
