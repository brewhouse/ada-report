<?php
defined( 'ABSPATH' ) || exit;

// Register settings (for the WP Settings API form)
add_action( 'admin_init', 'ada_register_settings' );

function ada_register_settings() {
	register_setting(
		'ada_checker_settings_group',
		ADA_CHECKER_OPTION_KEY,
		[ 'sanitize_callback' => 'ada_sanitize_settings' ]
	);
}

function ada_sanitize_settings( $input ) {
	$clean = ada_get_settings(); // start from current

	$clean['scan_url']  = esc_url_raw( trim( $input['scan_url'] ?? '' ) );
	$clean['api_url']   = esc_url_raw( $input['api_url'] ?? ADA_CHECKER_API_DEFAULT );
	$clean['max_pages'] = max( 1, min( 5000, absint( $input['max_pages'] ?? 50 ) ) );

	$schedule = $input['schedule'] ?? 'none';
	$clean['schedule']   = in_array( $schedule, [ 'none', 'daily', 'weekly', 'monthly' ], true ) ? $schedule : 'none';
	$clean['sched_day']  = max( 1, min( 28, absint( $input['sched_day'] ?? 1 ) ) );
	$clean['sched_hour'] = max( 0, min( 23, absint( $input['sched_hour'] ?? 8 ) ) );

	// Sanitize email list: each entry must be a valid email
	$raw_emails = sanitize_textarea_field( $input['emails'] ?? '' );
	$emails     = array_filter( array_map( 'trim', preg_split( '/[\s,]+/', $raw_emails ) ) );
	$valid      = array_filter( $emails, 'is_email' );
	$clean['emails'] = implode( ', ', $valid );

	// Re-apply cron after settings save
	ada_reschedule_cron();

	return $clean;
}

function ada_render_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Insufficient permissions.' );
	$s = ada_get_settings();
	?>
	<div class="wrap ada-settings-wrap">
		<h1>ADA Accessibility Checker – Settings</h1>

		<?php settings_errors( ADA_CHECKER_OPTION_KEY ); ?>

		<form method="post" action="options.php">
			<?php settings_fields( 'ada_checker_settings_group' ); ?>

			<!-- ── Scan settings ──────────────────────────────────────────── -->
			<h2 class="ada-section-title">Scan Settings</h2>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="ada_scan_url">URL to scan</label></th>
					<td>
						<input type="url" id="ada_scan_url" name="<?php echo ADA_CHECKER_OPTION_KEY; ?>[scan_url]"
							value="<?php echo esc_attr( $s['scan_url'] ); ?>" class="regular-text"
							placeholder="<?php echo esc_attr( get_site_url() ); ?>">
						<p class="description">
							Leave blank to scan this WordPress site (<code><?php echo esc_html( get_site_url() ); ?></code>).<br>
							Set to a production URL when the plugin is installed on a dev/staging environment
							that the scan server cannot reach (e.g. <code>https://www.example.com</code>).
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="ada_max_pages">Max pages per scan</label></th>
					<td>
						<input type="number" id="ada_max_pages" name="<?php echo ADA_CHECKER_OPTION_KEY; ?>[max_pages]"
							value="<?php echo esc_attr( $s['max_pages'] ); ?>" min="1" max="5000" class="small-text">
						<p class="description">How many pages to crawl and audit in each scan (1–5000).</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="ada_api_url">API URL</label></th>
					<td>
						<input type="url" id="ada_api_url" name="<?php echo ADA_CHECKER_OPTION_KEY; ?>[api_url]"
							value="<?php echo esc_attr( $s['api_url'] ); ?>" class="regular-text">
						<p class="description">Leave at default unless self-hosting the ADA checker service.</p>
					</td>
				</tr>
			</table>

			<!-- ── Schedule ──────────────────────────────────────────────── -->
			<h2 class="ada-section-title">Automatic Scan Schedule</h2>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row">Frequency</th>
					<td>
						<?php
						$freqs = [ 'none' => 'Disabled', 'daily' => 'Daily', 'weekly' => 'Weekly', 'monthly' => 'Monthly' ];
						foreach ( $freqs as $val => $label ) :
							$checked = checked( $s['schedule'], $val, false );
							?>
							<label style="margin-right:18px">
								<input type="radio" name="<?php echo ADA_CHECKER_OPTION_KEY; ?>[schedule]"
									value="<?php echo esc_attr( $val ); ?>" <?php echo $checked; ?>>
								<?php echo esc_html( $label ); ?>
							</label>
						<?php endforeach; ?>
					</td>
				</tr>
				<tr id="ada-sched-day-row" <?php echo 'none' === $s['schedule'] ? 'style="display:none"' : ''; ?>>
					<th scope="row"><label for="ada_sched_day">Run on day</label></th>
					<td>
						<div id="ada-sched-weekly" <?php echo 'weekly' !== $s['schedule'] ? 'style="display:none"' : ''; ?>>
							<select name="<?php echo ADA_CHECKER_OPTION_KEY; ?>[sched_day]" id="ada_sched_day_weekly">
								<?php
								$days = [ 1 => 'Monday', 2 => 'Tuesday', 3 => 'Wednesday', 4 => 'Thursday', 5 => 'Friday', 6 => 'Saturday', 7 => 'Sunday' ];
								foreach ( $days as $num => $name ) :
									echo '<option value="' . $num . '"' . selected( $s['sched_day'], $num, false ) . '>' . esc_html( $name ) . '</option>';
								endforeach;
								?>
							</select>
						</div>
						<div id="ada-sched-monthly" <?php echo 'monthly' !== $s['schedule'] ? 'style="display:none"' : ''; ?>>
							<select name="<?php echo ADA_CHECKER_OPTION_KEY; ?>[sched_day]" id="ada_sched_day_monthly">
								<?php for ( $d = 1; $d <= 28; $d++ ) : ?>
									<option value="<?php echo $d; ?>" <?php selected( $s['sched_day'], $d ); ?>>
										Day <?php echo $d; ?> of the month
									</option>
								<?php endfor; ?>
							</select>
						</div>
					</td>
				</tr>
				<tr id="ada-sched-hour-row" <?php echo 'none' === $s['schedule'] ? 'style="display:none"' : ''; ?>>
					<th scope="row"><label for="ada_sched_hour">Run at (hour)</label></th>
					<td>
						<select name="<?php echo ADA_CHECKER_OPTION_KEY; ?>[sched_hour]" id="ada_sched_hour">
							<?php for ( $h = 0; $h < 24; $h++ ) : ?>
								<option value="<?php echo $h; ?>" <?php selected( $s['sched_hour'], $h ); ?>>
									<?php echo sprintf( '%02d:00', $h ); ?>
								</option>
							<?php endfor; ?>
						</select>
						<p class="description">Uses the timezone set in WordPress (Settings › General).</p>
					</td>
				</tr>
			</table>

			<!-- ── Email Notifications ───────────────────────────────────── -->
			<h2 class="ada-section-title">Email Notifications</h2>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="ada_emails">Notification emails</label></th>
					<td>
						<textarea id="ada_emails" name="<?php echo ADA_CHECKER_OPTION_KEY; ?>[emails]"
							rows="4" class="large-text"><?php echo esc_textarea( $s['emails'] ); ?></textarea>
						<p class="description">
							Enter email addresses separated by commas or line breaks.<br>
							An email with the scan summary will be sent after every completed scan (scheduled or manual).
						</p>
					</td>
				</tr>
			</table>

			<?php
			$next = wp_next_scheduled( 'ada_scheduled_scan' );
			if ( $next && 'none' !== $s['schedule'] ) :
				?>
				<p class="description" style="margin-top:8px">
					Next scheduled scan: <strong><?php echo esc_html( get_date_from_gmt( gmdate( 'Y-m-d H:i:s', $next ), get_option( 'date_format' ) . ' ' . get_option( 'time_format' ) ) ); ?></strong>
				</p>
			<?php endif; ?>

			<?php submit_button( 'Save Settings' ); ?>
		</form>
	</div>

	<script>
	(function() {
		const radios    = document.querySelectorAll('input[name="<?php echo ADA_CHECKER_OPTION_KEY; ?>[schedule]"]');
		const dayRow    = document.getElementById('ada-sched-day-row');
		const hourRow   = document.getElementById('ada-sched-hour-row');
		const weekly    = document.getElementById('ada-sched-weekly');
		const monthly   = document.getElementById('ada-sched-monthly');

		function applySchedule(val) {
			dayRow.style.display  = val === 'none' ? 'none' : '';
			hourRow.style.display = val === 'none' ? 'none' : '';
			if (weekly)  weekly.style.display  = val === 'weekly'  ? '' : 'none';
			if (monthly) monthly.style.display = val === 'monthly' ? '' : 'none';
		}

		radios.forEach(r => r.addEventListener('change', () => applySchedule(r.value)));
	})();
	</script>
	<?php
}
