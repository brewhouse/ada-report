<?php
defined( 'ABSPATH' ) || exit;

function ada_register_meta_boxes() {
	if ( ! current_user_can( 'manage_options' ) ) return;

	$post_types = apply_filters( 'ada_checker_post_types', [ 'post', 'page' ] );
	foreach ( $post_types as $type ) {
		add_meta_box(
			'ada_page_results',
			'ADA Accessibility',
			'ada_render_meta_box',
			$type,
			'side',
			'default'
		);
	}
}

function ada_render_meta_box( $post ) {
	$settings  = ada_get_settings();
	$audit_id  = $settings['last_audit_id'];

	// Auto-discover the latest auditId if not stored yet — same logic as admin-page.php.
	if ( ! $audit_id ) {
		$summary = ada_get_scan_summary();
		if ( ! is_wp_error( $summary ) && ! empty( $summary['auditId'] ) ) {
			$audit_id = $summary['auditId'];
			ada_update_setting( 'last_audit_id',  $audit_id );
			ada_update_setting( 'last_scan_time', $summary['completedAt'] ?? '' );
			ada_update_setting( 'last_score',     $summary['score']       ?? '' );
		}
	}

	// Determine the public URL for this post
	$page_url  = get_permalink( $post->ID );
	if ( ! $page_url ) $page_url = '';

	// For unpublished posts we show a friendly message
	$is_published = in_array( $post->post_status, [ 'publish', 'private' ], true );
	?>
	<div id="ada-meta-box" data-page-url="<?php echo esc_attr( $page_url ); ?>"
		data-audit-id="<?php echo esc_attr( $audit_id ); ?>">

		<?php if ( ! $audit_id ) : ?>
			<p class="ada-meta-notice">
				No site scan found.<br>
				<a href="<?php echo esc_url( admin_url( 'index.php' ) ); ?>">Run a scan from the dashboard</a>.
			</p>

		<?php elseif ( ! $is_published || ! $page_url ) : ?>
			<p class="ada-meta-notice">Publish this <?php echo esc_html( $post->post_type ); ?> first to see accessibility results.</p>

		<?php else : ?>

			<!-- Loading -->
			<div id="ada-mb-loading" class="ada-meta-state">
				<span class="ada-spinner-inline"></span> Loading…
			</div>

			<!-- No results for this page -->
			<div id="ada-mb-none" class="ada-meta-state" style="display:none">
				<p style="margin:0 0 8px;font-size:12px;color:#6b7280">This page has not been scanned yet.</p>
			</div>

			<!-- Results -->
			<div id="ada-mb-results" class="ada-meta-state" style="display:none">
				<div class="ada-mb-score-row">
					<canvas id="ada-mb-canvas" width="60" height="60"></canvas>
					<div>
						<div id="ada-mb-score" class="ada-mb-score-val">–</div>
						<div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px">Score</div>
					</div>
				</div>
				<table class="ada-mb-table">
					<tr><td><span class="ada-dot ada-dot-critical"></span>Critical</td><td id="ada-mb-critical">–</td></tr>
					<tr><td><span class="ada-dot ada-dot-serious"></span>Serious</td><td id="ada-mb-serious">–</td></tr>
					<tr><td><span class="ada-dot ada-dot-moderate"></span>Moderate</td><td id="ada-mb-moderate">–</td></tr>
					<tr><td><span class="ada-dot ada-dot-minor"></span>Minor</td><td id="ada-mb-minor">–</td></tr>
					<tr><td><span class="ada-dot ada-dot-ignored"></span>Ignored</td><td id="ada-mb-ignored">–</td></tr>
				</table>
				<p id="ada-mb-audited" style="font-size:11px;color:#9ca3af;margin:6px 0 0"></p>
			</div>

			<!-- Scanning -->
			<div id="ada-mb-scanning" class="ada-meta-state" style="display:none">
				<span class="ada-spinner-inline"></span>
				<span id="ada-mb-scan-label">Scanning this page…</span>
			</div>

			<!-- Error -->
			<div id="ada-mb-error" class="ada-meta-state" style="display:none">
				<p id="ada-mb-error-msg" style="color:#dc2626;font-size:12px;margin:0 0 6px"></p>
			</div>

			<div class="ada-mb-actions" style="margin-top:10px">
				<button id="ada-mb-rescan-btn" class="button button-small" style="width:100%">
					↻ Rescan This Page
				</button>
			</div>

		<?php endif; ?>
	</div>
	<?php
}
