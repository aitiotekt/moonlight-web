/**
 * CodecAuto — « Auto », the first codec of the Settings menu and its default.
 *
 * Auto streams in HEVC, as « HEVC (recommended) » did before it, and in AV1
 * where HEVC cannot do the job: an HDR stream with the enhancer asked for,
 * from a host that encodes AV1 10-bit, in a browser that decodes it in
 * software (BrowserDetect.hdrLaunchCodec). The launch resolves it to one of
 * the two before asking the host: the host never sees « auto ». A codec
 * chosen in the menu is kept as chosen.
 *
 * A stored HEVC cannot say whether it was chosen or only left as the default,
 * so it becomes Auto once per browser (codecAfterAutoMigration). Auto is HEVC
 * but where HEVC fails: nothing is lost, and a HEVC picked afterwards stays.
 *
 * Where HEVC failed, Auto remembers it (hevcFailedHere) and asks H.264 from
 * the next launch on, instead of failing HEVC first at every launch.
 */

export const CODEC_AUTO = 'auto';

/** Set once this browser's stored codec has been through the move to Auto. */
const MIGRATED_KEY = 'mw_codec_auto';

/** localStorage, or null where reading it throws (sandboxed frame, privacy mode). */
function store() {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (e) {
        return null;
    }
}

/**
 * The codec setting after the one move of a stored HEVC to Auto. A missing
 * codec is left missing, and leaves the move for the first one stored (the
 * server's default, on a first visit to the Settings page).
 * @param {string|undefined} codec the codec as stored
 * @param {Storage|null} [s] where the move is remembered
 * @returns {string|undefined}
 */
export function codecAfterAutoMigration(codec, s = store()) {
    if (typeof codec !== 'string' || !codec) return codec;
    try {
        if (!s || s.getItem(MIGRATED_KEY) === '1') return codec;
        s.setItem(MIGRATED_KEY, '1');
    } catch (e) {
        // Neither read nor kept: the codec as it is, asked again next time.
        return codec;
    }
    return codec === 'hevc' ? CODEC_AUTO : codec;
}

/**
 * The same move on the settings this browser stored (`mw-streaming-settings`),
 * written back when it changed them. Run once, at start-up, before anything
 * reads them.
 * @param {Storage|null} [s]
 */
export function migrateStoredCodecToAuto(s = store()) {
    if (!s) return;
    try {
        const raw = s.getItem('mw-streaming-settings');
        if (!raw) return;
        const settings = JSON.parse(raw);
        if (!settings || typeof settings !== 'object') return;
        const codec = codecAfterAutoMigration(settings.video_codec, s);
        if (codec !== settings.video_codec) {
            settings.video_codec = codec;
            s.setItem('mw-streaming-settings', JSON.stringify(settings));
            console.log('[MW] Codec: the HEVC stored here is Auto from now on');
        }
    } catch (e) {
        // Unreadable settings are the Settings page's to repair, not this.
    }
}

/** The browsers whose HEVC failed to decode: user agent → when (ms). */
const HEVC_FAILED_KEY = 'mw_hevc_failed';

/** How long such a verdict holds. Past it, Auto asks HEVC again. */
export const HEVC_FAILED_DAYS = 30;
const HEVC_FAILED_MS = HEVC_FAILED_DAYS * 24 * 3600 * 1000;

const userAgent = () => (typeof navigator !== 'undefined' && navigator.userAgent) || '';

/** @param {Storage|null} s @returns {Object<string, number>} */
function hevcVerdicts(s) {
    try {
        const kept = s && JSON.parse(s.getItem(HEVC_FAILED_KEY) || '{}');
        return kept && typeof kept === 'object' ? kept : {};
    } catch (e) {
        return {};
    }
}

/**
 * Whether this browser's HEVC was seen failing: the decoder refused every
 * configuration, or gave no picture, and the stream fell back to H.264.
 * Firefox on the UM790Pro asked HEVC under Auto, failed it in 0.8 s and came
 * back in H.264, at every launch (28/10/2026). The verdict is kept under the
 * user agent (a new version of the browser is asked again) and for
 * HEVC_FAILED_DAYS at most.
 * @param {string} [ua]
 * @param {Storage|null} [s]
 * @param {number} [now] ms since the epoch
 * @returns {boolean}
 */
export function hevcFailedHere(ua = userAgent(), s = store(), now = Date.now()) {
    const seen = hevcVerdicts(s)[ua];
    // A date ahead of the clock (the clock set back) holds no longer either.
    return typeof seen === 'number' && now >= seen && now - seen < HEVC_FAILED_MS;
}

/**
 * Remember it (hevcFailedHere), dropping the verdicts past their time.
 * @param {string} [ua]
 * @param {Storage|null} [s]
 * @param {number} [now]
 */
export function noteHevcFailed(ua = userAgent(), s = store(), now = Date.now()) {
    if (!s) return;
    try {
        const kept = {};
        for (const [k, seen] of Object.entries(hevcVerdicts(s))) {
            if (typeof seen === 'number' && now >= seen && now - seen < HEVC_FAILED_MS)
                kept[k] = seen;
        }
        kept[ua] = now;
        s.setItem(HEVC_FAILED_KEY, JSON.stringify(kept));
    } catch (e) {
        // Not kept: the next launch finds out again, a relaunch later.
    }
}

/**
 * The codec an Auto launch asks the host for: HEVC, or H.264 in a browser
 * whose HEVC failed (hevcFailedHere). The HDR route may still turn HEVC into
 * AV1 (BrowserDetect.hdrLaunchCodec).
 * @param {string} [ua]
 * @param {Storage|null} [s]
 * @param {number} [now]
 * @returns {'hevc'|'h264'}
 */
export function autoLaunchCodec(ua, s, now) {
    return hevcFailedHere(ua, s, now) ? 'h264' : 'hevc';
}
